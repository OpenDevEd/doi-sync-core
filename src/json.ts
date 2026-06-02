import { z } from 'zod';
import type { JsonValue } from './hash.js';

export type JsonObject = { readonly [key: string]: JsonValue };

/** Zod schema for validating JSON snapshots persisted by sync hosts. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]));

export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => toJsonValue(entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, toJsonValue(entry)])
    );
  }

  throw new Error(`Cannot serialize ${typeof value} as JSON`);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: JsonValue): JsonObject | null {
  return isJsonObject(value) ? value : null;
}
