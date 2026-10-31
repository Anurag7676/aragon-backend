import { z } from 'zod';
import { Errors } from './errors.js';

/** Keyset pagination cursor: the (createdAt, id) of the last row on the previous page. */
export interface Cursor {
  createdAt: Date;
  id: string;
}

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

export const encodeCursor = ({ createdAt, id }: Cursor): string =>
  Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString('base64url');

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    throw Errors.badRequest('INVALID_CURSOR', 'The pagination cursor is invalid.');
  }
}
