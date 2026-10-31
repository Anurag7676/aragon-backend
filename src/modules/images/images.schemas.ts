import { z } from 'zod';
import { ALLOWED_CONTENT_TYPES, uploadRules } from '../../config/rules.js';
import { IMAGE_STATUSES } from '../../db/models/index.js';

const maxMb = uploadRules.maxFileBytes / (1024 * 1024);

export const createImageSchema = z.object({
  fileName: z.string().trim().min(1, 'File name is required.').max(255),
  contentType: z.enum(ALLOWED_CONTENT_TYPES, { error: 'Only JPG, PNG and HEIC photos are allowed.' }),
  sizeBytes: z
    .number()
    .int()
    .positive('The file is empty.')
    .max(uploadRules.maxFileBytes, `Photos must be ${maxMb} MB or smaller.`),
});

export const imageIdParamsSchema = z.object({ id: z.uuid({ error: 'Invalid image id.' }) });

export const listImagesQuerySchema = z.object({
  // Comma-separated, e.g. ?status=queued,processing
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((status) => status.trim()) : undefined))
    .pipe(z.array(z.enum(IMAGE_STATUSES)).min(1).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(200).optional(),
});

export type CreateImageInput = z.infer<typeof createImageSchema>;
export type ListImagesQuery = z.infer<typeof listImagesQuerySchema>;
