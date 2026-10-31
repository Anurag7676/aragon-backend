/**
 * Creates (or updates) the private S3 bucket for photos. Safe to run more than once.
 *
 *   npm run setup:bucket -- --origins https://app.example.com,http://localhost:5173
 *
 * Origins default to APP_ORIGINS. Only these origins may POST uploads from the browser.
 */
import {
  BucketAlreadyOwnedByYou,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import { parseArgs } from 'node:util';
import { env } from '../src/config/env.js';

const { values } = parseArgs({ options: { origins: { type: 'string' } } });
const origins = values.origins ? values.origins.split(',').map((origin) => origin.trim()) : env.APP_ORIGINS;
const bucket = env.S3_BUCKET;
const region = env.AWS_REGION;
const client = new S3Client({ region });

async function createBucket(): Promise<void> {
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        ...(region === 'us-east-1'
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
      }),
    );
    console.log(`created bucket ${bucket} in ${region}`);
  } catch (error) {
    if (!(error instanceof BucketAlreadyOwnedByYou)) throw error;
    console.log(`bucket ${bucket} already exists; updating settings`);
  }
}

await createBucket();

await client.send(
  new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }),
);

await client.send(
  new PutBucketEncryptionCommand({
    Bucket: bucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true }],
    },
  }),
);

// Refuse any request that isn't over TLS.
await client.send(
  new PutBucketPolicyCommand({
    Bucket: bucket,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    }),
  }),
);

// Browser uploads use a presigned POST; reads use presigned GET in <img> tags.
await client.send(
  new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['POST', 'GET', 'HEAD'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3000,
        },
      ],
    },
  }),
);

await client.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'abort-incomplete-multipart-uploads',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        },
      ],
    },
  }),
);

console.log(`bucket ready: private, encrypted, TLS-only, CORS for ${origins.join(', ')}`);
