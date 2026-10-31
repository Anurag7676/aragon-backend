import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

// External boundaries are replaced for every test file. Postgres and Redis stay real.

vi.mock('../src/integrations/mailer.js', () => ({
  sendOtpEmail: vi.fn(async () => {}),
}));

vi.mock('../src/integrations/s3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/s3.js')>();
  return {
    ...actual,
    storage: {
      createUploadForm: vi.fn(async (key: string, contentType: string) => ({
        url: 'https://s3.test/bucket',
        fields: { key, 'Content-Type': contentType, Policy: 'policy', 'X-Amz-Signature': 'signature' },
      })),
      head: vi.fn(async () => ({ sizeBytes: 123_456 })),
      getBuffer: vi.fn(async () => null),
      put: vi.fn(async () => {}),
      deleteMany: vi.fn(async () => {}),
      readUrl: vi.fn(async (key: string) => `https://s3.test/read/${key}`),
    },
  };
});

vi.mock('../src/integrations/queue.js', () => ({
  IMAGE_QUEUE: 'image-processing',
  MAINTENANCE_QUEUE: 'maintenance',
  enqueueImageProcessing: vi.fn(async () => ({})),
}));

const { sequelize } = await import('../src/db/sequelize.js');
await import('../src/db/models/index.js');
const { redis } = await import('../src/integrations/redis.js');

beforeAll(async () => {
  await sequelize.query('TRUNCATE users, email_otps, refresh_tokens, images CASCADE');
});

beforeEach(() => {
  // Clears calls and per-test overrides; each mock goes back to the default implementation above.
  vi.resetAllMocks();
});

afterAll(async () => {
  await sequelize.close();
  await redis.quit();
});
