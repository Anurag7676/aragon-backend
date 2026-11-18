/** Conversion service: original upload (JPEG, PNG, HEIC) → upright sRGB JPEG master. */
import { env } from '../config/env.js';
import { startStageWorker } from './stage-worker.js';

await startStageWorker('conversion', env.CONVERSION_CONCURRENCY);
