import { z } from 'zod';

// Local development reads .env (or .env.test under Vitest). Real environments inject variables directly,
// and loadEnvFile never overrides a variable that is already set.
try {
  process.loadEnvFile(process.env.NODE_ENV === 'test' ? '.env.test' : '.env');
} catch {
  // No env file: rely on the process environment.
}

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    APP_ORIGINS: originList,

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: booleanFromString.default(true),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

    JWT_ACCESS_SECRET: z.string().min(32),
    OTP_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    REFRESH_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

    AWS_REGION: z.string().min(1).default('ap-southeast-1'),
    S3_BUCKET: z.string().min(3),
    S3_KEY_PREFIX: z.string().default(''),

    SMTP_HOST: z.string().default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().optional(),

    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  })
  .refine((value) => value.NODE_ENV !== 'production' || (value.SMTP_USER && value.SMTP_PASS), {
    message: 'SMTP_USER and SMTP_PASS are required in production',
    path: ['SMTP_USER'],
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on env, so report configuration errors directly and stop.
  console.error('Invalid environment configuration:', z.flattenError(parsed.error).fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
