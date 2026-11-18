/** Variant service: compressed master → thumbnail, web and full sizes in S3, URLs in Postgres. */
import { env } from '../config/env.js';
import { startStageWorker } from './stage-worker.js';

await startStageWorker('variants', env.VARIANTS_CONCURRENCY);
