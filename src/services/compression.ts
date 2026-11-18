/** Compression service: converted master → smaller JPEG, recording the size and ratio. */
import { env } from '../config/env.js';
import { startStageWorker } from './stage-worker.js';

await startStageWorker('compression', env.COMPRESSION_CONCURRENCY);
