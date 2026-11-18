/**
 * Load test: uploads many photos at once through the public API (the same three calls the browser
 * makes), then follows every photo through validation and the three pipeline services until it has
 * finished, and reports throughput, latency per stage and failures.
 *
 *   npm run load-test -- --base-url http://localhost:4090 --tokens load-test-results/tokens.json \
 *     --images 500 --concurrency 40 --ops-token "$OPS_TOKEN"
 *
 * Tokens come from `seed-users` (see README). Each account uploads the six portraits in ./photos
 * (two HEIC, two JPEG, two PNG): they all pass validation and are different enough from each other
 * that none is rejected as "too similar", so every photo reaches the pipeline.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:4090' },
    tokens: { type: 'string', default: 'load-test-results/tokens.json' },
    images: { type: 'string', default: '500' },
    concurrency: { type: 'string', default: '40' },
    'ops-token': { type: 'string' },
    'timeout-minutes': { type: 'string', default: '30' },
    out: { type: 'string', default: 'load-test-results' },
  },
});

const API = `${values['base-url']!.replace(/\/$/, '')}/api/v1`;
const IMAGE_COUNT = Number(values.images);
const CONCURRENCY = Number(values.concurrency);
const OPS_TOKEN = values['ops-token'] ?? process.env.OPS_TOKEN;
const TIMEOUT_MS = Number(values['timeout-minutes']) * 60_000;
const STAGES = ['conversion', 'compression', 'variants'] as const;

// ---------------------------------------------------------------------------------------------- setup

const CONTENT_TYPES: Record<string, string> = { '.heic': 'image/heic', '.jpg': 'image/jpeg', '.png': 'image/png' };
const photoDir = new URL('./photos/', import.meta.url);
const photos = readdirSync(photoDir)
  .filter((name) => CONTENT_TYPES[extname(name)])
  .sort()
  .map((name) => ({ name, contentType: CONTENT_TYPES[extname(name)]!, data: readFileSync(new URL(name, photoDir)) }));

const { users } = JSON.parse(readFileSync(values.tokens!, 'utf8')) as { users: { email: string; token: string }[] };
if (users.length * photos.length < IMAGE_COUNT) {
  throw new Error(
    `${IMAGE_COUNT} images need at least ${Math.ceil(IMAGE_COUNT / photos.length)} accounts (each uploads ${photos.length}); the tokens file has ${users.length}.`,
  );
}
const tasks = Array.from({ length: IMAGE_COUNT }, (_, index) => ({
  token: users[Math.floor(index / photos.length)]!.token,
  photo: photos[index % photos.length]!,
}));

// ------------------------------------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      await sleep(Number(res.headers.get('retry-after') ?? 1) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

/** Runs fn over items with at most `size` in flight. */
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]!).then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (reason: unknown) => ({ status: 'rejected', reason }) as const,
        );
      }
    }),
  );
  return results;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : null;
function summarize(values: (number | null)[]) {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted.at(-1) ?? null };
}
const seconds = (ms: number | null) => (ms === null ? '   -  ' : `${(ms / 1000).toFixed(1).padStart(5)}s`);

// ------------------------------------------------------------------------------------------- upload

interface Submitted {
  imageId: string;
  token: string;
  photo: string;
}

async function upload(task: (typeof tasks)[number]): Promise<Submitted> {
  const { photo, token } = task;
  const created = await call<{ image: { id: string }; upload: { url: string; fields: Record<string, string> } }>(
    'POST',
    '/images',
    token,
    { fileName: photo.name, contentType: photo.contentType, sizeBytes: photo.data.length },
  );

  const form = new FormData();
  for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
  form.append('file', new Blob([photo.data], { type: photo.contentType }), photo.name);
  const s3 = await fetch(created.upload.url, { method: 'POST', body: form });
  if (!s3.ok) throw new Error(`S3 upload → ${s3.status} ${await s3.text()}`);

  await call('POST', `/images/${created.image.id}/complete`, token);
  return { imageId: created.image.id, token, photo: photo.name };
}

// ------------------------------------------------------------------------------------------ progress

interface QueueStats {
  waiting: number;
  active: number;
  failed: number;
  workers: number;
}
interface OpsSnapshot {
  queues: Record<'validation' | (typeof STAGES)[number], QueueStats>;
  jobs: Record<string, number>;
  validating: number;
}

const startedAt = new Date();
const snapshots: (OpsSnapshot & { t: number })[] = [];
let uploaded = 0;
let uploadsDone = false;

async function opsSnapshot(): Promise<OpsSnapshot | null> {
  if (!OPS_TOKEN) return null;
  const res = await fetch(`${API}/ops/pipeline?since=${encodeURIComponent(startedAt.toISOString())}`, {
    headers: { Authorization: `Bearer ${OPS_TOKEN}` },
  });
  return res.ok ? ((await res.json()) as OpsSnapshot) : null;
}

function printProgress(snapshot: OpsSnapshot): void {
  const t = Math.round((Date.now() - startedAt.getTime()) / 1000);
  const queue = (name: keyof OpsSnapshot['queues']) => {
    const q = snapshot.queues[name];
    return `${name.slice(0, 4)} ${String(q.waiting).padStart(4)}w ${String(q.active).padStart(2)}a ×${q.workers}`;
  };
  console.log(
    `${String(t).padStart(4)}s  uploaded ${String(uploaded).padStart(4)}/${IMAGE_COUNT}  validating ${String(snapshot.validating).padStart(4)}  |  ` +
      `${queue('validation')}  ${queue('conversion')}  ${queue('compression')}  ${queue('variants')}  |  ` +
      `done ${snapshot.jobs.completed ?? 0}  failed ${snapshot.jobs.failed ?? 0}`,
  );
}

const unfinishedJobs = (jobs: Record<string, number>) =>
  (jobs.queued ?? 0) + (jobs.converting ?? 0) + (jobs.compressing ?? 0) + (jobs.generating_variants ?? 0);

// ---------------------------------------------------------------------------------------------- run

console.log(
  `Load test: ${IMAGE_COUNT} images from ${Math.ceil(IMAGE_COUNT / photos.length)} accounts, ${CONCURRENCY} uploads at a time → ${API}`,
);
if (!OPS_TOKEN) console.log('No --ops-token: live queue view is off; waiting by polling each photo instead.');

const ticker = setInterval(() => {
  void opsSnapshot().then((snapshot) => {
    if (!snapshot) return;
    snapshots.push({ ...snapshot, t: Date.now() - startedAt.getTime() });
    printProgress(snapshot);
  });
}, 2_000);

const uploads = await pool(tasks, CONCURRENCY, async (task) => {
  const result = await upload(task);
  uploaded += 1;
  return result;
});
uploadsDone = true;
const uploadMs = Date.now() - startedAt.getTime();
const submitted = uploads.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
const uploadErrors = uploads.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []));
console.log(`All uploads sent in ${seconds(uploadMs).trim()} (${uploadErrors.length} failed).`);

// Wait until every photo has been decided and every pipeline job has finished.
const deadline = Date.now() + TIMEOUT_MS;
for (;;) {
  if (Date.now() > deadline) {
    console.log('Timed out waiting for the pipeline to finish.');
    break;
  }
  if (OPS_TOKEN) {
    const snapshot = await opsSnapshot();
    if (uploadsDone && snapshot && snapshot.validating === 0 && unfinishedJobs(snapshot.jobs) === 0) break;
  } else {
    const states = await pool(submitted, 20, (item) =>
      call<{ image: { status: string; pipeline: { status: string } | null } }>('GET', `/images/${item.imageId}`, item.token),
    );
    const pending = states.filter(
      (state) =>
        state.status === 'fulfilled' &&
        (['queued', 'processing'].includes(state.value.image.status) ||
          (state.value.image.pipeline && !['completed', 'failed'].includes(state.value.image.pipeline.status))),
    ).length;
    console.log(`${Math.round((Date.now() - startedAt.getTime()) / 1000)}s  ${pending} photos still in progress`);
    if (pending === 0) break;
  }
  await sleep(2_000);
}
clearInterval(ticker);
const wallMs = Date.now() - startedAt.getTime();

// -------------------------------------------------------------------------------------------- report

interface ImageDto {
  status: string;
  createdAt: string;
  rejectionReasons: { code: string }[];
}
interface PipelineDto {
  status: string;
  error: { stage: string; code: string; message: string } | null;
  savedPercent: number | null;
  sizes: { convertedBytes: number | null; compressedBytes: number | null };
  timings: { completedAt: string | null };
  durations: Record<(typeof STAGES)[number], { waitMs: number | null; runMs: number | null }> & { totalMs: number | null };
}

const details = await pool(submitted, 20, async (item) => {
  const { image } = await call<{ image: ImageDto }>('GET', `/images/${item.imageId}`, item.token);
  const pipeline =
    image.status === 'accepted'
      ? (await call<{ pipeline: PipelineDto }>('GET', `/images/${item.imageId}/pipeline`, item.token)).pipeline
      : null;
  return { ...item, image, pipeline };
});
const rows = details.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

const completed = rows.filter((row) => row.pipeline?.status === 'completed');
const pipelineFailed = rows.filter((row) => row.pipeline?.status === 'failed');
const rejected = rows.filter((row) => row.image.status === 'rejected');
const countBy = (items: string[]) => items.reduce<Record<string, number>>((acc, key) => ({ ...acc, [key]: (acc[key] ?? 0) + 1 }), {});

const endToEnd = completed.map((row) => Date.parse(row.pipeline!.timings.completedAt!) - Date.parse(row.image.createdAt));
const firstCreated = Math.min(...rows.map((row) => Date.parse(row.image.createdAt)));
const lastCompleted = Math.max(...completed.map((row) => Date.parse(row.pipeline!.timings.completedAt!)));
const throughputPerMin = completed.length > 0 ? (completed.length / (lastCompleted - firstCreated)) * 60_000 : 0;
const peakWaiting = Object.fromEntries(
  (['validation', ...STAGES] as const).map((name) => [name, Math.max(0, ...snapshots.map((s) => s.queues[name].waiting))]),
);
const workers = snapshots.at(-1)?.queues;

const report = {
  startedAt: startedAt.toISOString(),
  config: { baseUrl: values['base-url'], images: IMAGE_COUNT, concurrency: CONCURRENCY, accounts: Math.ceil(IMAGE_COUNT / photos.length) },
  workersPerStage: workers ? Object.fromEntries(Object.entries(workers).map(([name, q]) => [name, q.workers])) : null,
  totals: {
    submitted: submitted.length,
    uploadErrors: uploadErrors.length,
    rejected: rejected.length,
    completed: completed.length,
    failed: pipelineFailed.length,
  },
  wallClockMs: wallMs,
  uploadPhaseMs: uploadMs,
  throughputPerMinute: Math.round(throughputPerMin * 10) / 10,
  endToEndMs: summarize(endToEnd),
  pipelineOnlyMs: summarize(completed.map((row) => row.pipeline!.durations.totalMs)),
  stages: Object.fromEntries(
    STAGES.map((stage) => [
      stage,
      {
        waitMs: summarize(completed.map((row) => row.pipeline!.durations[stage].waitMs)),
        runMs: summarize(completed.map((row) => row.pipeline!.durations[stage].runMs)),
      },
    ]),
  ),
  peakQueueWaiting: snapshots.length ? peakWaiting : null,
  compression: {
    averageSavedPercent:
      completed.length > 0
        ? Math.round((completed.reduce((sum, row) => sum + (row.pipeline!.savedPercent ?? 0), 0) / completed.length) * 10) / 10
        : null,
    bytesBefore: completed.reduce((sum, row) => sum + (row.pipeline!.sizes.convertedBytes ?? 0), 0),
    bytesAfter: completed.reduce((sum, row) => sum + (row.pipeline!.sizes.compressedBytes ?? 0), 0),
  },
  rejectedReasons: countBy(rejected.flatMap((row) => row.image.rejectionReasons.map((reason) => reason.code))),
  failures: pipelineFailed.map((row) => ({ imageId: row.imageId, photo: row.photo, ...row.pipeline!.error })),
  uploadErrorSamples: uploadErrors.slice(0, 5),
};

mkdirSync(values.out!, { recursive: true });
const file = join(values.out!, `report-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

const line = (label: string, stats: ReturnType<typeof summarize>) =>
  console.log(`  ${label.padEnd(22)} p50 ${seconds(stats.p50)}  p95 ${seconds(stats.p95)}  p99 ${seconds(stats.p99)}  max ${seconds(stats.max)}`);

console.log('\n──────────── Load test result ────────────');
console.log(`  Submitted ${submitted.length}  completed ${completed.length}  failed ${pipelineFailed.length}  rejected ${rejected.length}  upload errors ${uploadErrors.length}`);
if (report.workersPerStage) console.log(`  Workers per stage      ${JSON.stringify(report.workersPerStage)}`);
console.log(`  Wall clock             ${seconds(wallMs).trim()}   throughput ${report.throughputPerMinute} images/min`);
line('Upload → variants', report.endToEndMs);
line('Pipeline only', report.pipelineOnlyMs);
for (const stage of STAGES) {
  line(`${stage} (waiting)`, report.stages[stage]!.waitMs);
  line(`${stage} (running)`, report.stages[stage]!.runMs);
}
if (report.peakQueueWaiting) console.log(`  Peak queue depth       ${JSON.stringify(report.peakQueueWaiting)}`);
console.log(`  Compression            ${report.compression.averageSavedPercent}% smaller on average`);
if (pipelineFailed.length) console.log(`  Failures               ${JSON.stringify(countBy(pipelineFailed.map((row) => row.pipeline!.error?.code ?? '?')))}`);
if (rejected.length) console.log(`  Rejected               ${JSON.stringify(report.rejectedReasons)}`);
console.log(`  Report                 ${file}`);
