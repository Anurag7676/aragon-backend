/**
 * Command-line walkthrough of one photo, for demos: uploads it (or reprocesses it), follows the live
 * event stream and prints every stage as it happens, then lists the variants.
 *
 *   npm run demo -- upload ./photo.heic
 *   npm run demo -- reprocess <imageId>
 *   npm run demo -- status <imageId>
 *
 * Signs in with DEMO_EMAIL / DEMO_PASSWORD (a verified account, e.g. from `npm run db:seed`).
 * DEMO_API defaults to http://localhost:4090/api/v1.
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const API = (process.env.DEMO_API ?? 'http://localhost:4090/api/v1').replace(/\/$/, '');
const [command, target] = process.argv.slice(2);
const CONTENT_TYPES: Record<string, string> = {
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

interface PipelineSummary {
  status: string;
  run: number;
  error: { stage: string; code: string; message: string } | null;
}
interface ImageDto {
  id: string;
  status: string;
  rejectionReasons: { code: string; message?: string }[];
  pipeline: PipelineSummary | null;
}

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`;

async function call<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function signIn(): Promise<string> {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  if (!email || !password) throw new Error('Set DEMO_EMAIL and DEMO_PASSWORD.');
  const { accessToken } = await call<{ accessToken: string }>('POST', '/auth/login', undefined, { email, password });
  return accessToken;
}

/**
 * Opens the SSE stream first, then runs `start` (the upload or the reprocess), and prints each change
 * to the photo until its processing has finished.
 */
async function follow(token: string, imageId: string, start: () => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const res = await fetch(`${API}/images/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`events → ${res.status}`);

  let last = '';
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  const decoder = new TextDecoder();
  let buffer = '';

  const read = (async () => {
    for await (const chunk of res.body!) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = message.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6)) as { type: string; image?: ImageDto };
        if (event.type !== 'image.updated' || event.image?.id !== imageId) continue;

        const image = event.image;
        const line = image.pipeline
          ? `pipeline run ${image.pipeline.run}: ${image.pipeline.status}`
          : `validation: ${image.status}`;
        if (line !== last) {
          console.log(`${stamp()}  ${line}`);
          last = line;
        }
        if (image.status === 'rejected') {
          console.log(`         rejected: ${image.rejectionReasons.map((reason) => reason.code).join(', ')}`);
          finished();
        }
        if (image.pipeline?.error) {
          const { stage, code, message: reason } = image.pipeline.error;
          console.log(`         failed in ${stage}: ${code} — ${reason}`);
        }
        if (image.pipeline && ['completed', 'failed'].includes(image.pipeline.status)) finished();
      }
    }
  })().catch(() => {});

  await start();
  await done;
  controller.abort();
  await read;
}

async function printDetails(token: string, imageId: string): Promise<void> {
  const { pipeline } = await call<{ pipeline: Record<string, unknown> & PipelineSummary }>(
    'GET',
    `/images/${imageId}/pipeline`,
    token,
  );
  const sizes = pipeline.sizes as Record<string, number | null>;
  const durations = pipeline.durations as Record<string, { waitMs: number | null; runMs: number | null }>;
  console.log(`\nSource ${pipeline.sourceFormat} ${pipeline.width}×${pipeline.height}`);
  console.log(
    `Sizes  original ${sizes.originalBytes} B → converted ${sizes.convertedBytes} B → compressed ${sizes.compressedBytes} B ` +
      `(${pipeline.compressionRatio}× , ${pipeline.savedPercent}% smaller)`,
  );
  for (const stage of ['conversion', 'compression', 'variants']) {
    console.log(`  ${stage.padEnd(12)} waited ${durations[stage]?.waitMs ?? '-'} ms, ran ${durations[stage]?.runMs ?? '-'} ms`);
  }

  const { variants } = await call<{
    variants: { kind: string; width: number; height: number; bytes: number; url: string }[];
  }>('GET', `/images/${imageId}/variants`, token);
  console.log('\nVariants');
  for (const variant of variants) {
    console.log(`  ${variant.kind.padEnd(10)} ${`${variant.width}×${variant.height}`.padEnd(11)} ${String(variant.bytes).padStart(9)} B  ${variant.url.split('?')[0]}`);
  }
}

const token = await signIn();

if (command === 'upload' && target) {
  const data = readFileSync(target);
  const contentType = CONTENT_TYPES[extname(target).toLowerCase()];
  if (!contentType) throw new Error('Use a .heic, .jpg or .png file.');

  const created = await call<{ image: { id: string }; upload: { url: string; fields: Record<string, string> } }>(
    'POST',
    '/images',
    token,
    { fileName: basename(target), contentType, sizeBytes: data.length },
  );
  const imageId = created.image.id;
  console.log(`${stamp()}  created ${imageId}`);

  await follow(token, imageId, async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
    form.append('file', new Blob([data], { type: contentType }), basename(target));
    const s3 = await fetch(created.upload.url, { method: 'POST', body: form });
    if (!s3.ok) throw new Error(`S3 upload → ${s3.status}`);
    console.log(`${stamp()}  uploaded ${data.length} B straight to S3`);
    await call('POST', `/images/${imageId}/complete`, token);
  });
  const { image } = await call<{ image: ImageDto }>('GET', `/images/${imageId}`, token);
  if (image.status === 'accepted') await printDetails(token, imageId);
} else if (command === 'reprocess' && target) {
  await follow(token, target, async () => {
    const { pipeline } = await call<{ pipeline: PipelineSummary }>('POST', `/images/${target}/reprocess`, token);
    console.log(`${stamp()}  reprocess accepted: run ${pipeline.run}`);
  });
  await printDetails(token, target);
} else if (command === 'status' && target) {
  await printDetails(token, target);
} else {
  console.log('Usage: npm run demo -- upload <file> | reprocess <imageId> | status <imageId>');
  process.exitCode = 1;
}
