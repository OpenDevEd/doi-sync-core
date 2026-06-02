import { createHash } from 'node:crypto';
import { asRecord } from './guards.js';
import { compareCodeUnits } from './sort.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry: unknown) => stableJson(entry)).join(',')}]`;

  const record = asRecord(value);
  if (!record) return JSON.stringify(value);

  const entries = Object.entries(record)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

export function sha256Hex(value: unknown): string {
  const input = typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(input).digest('hex');
}
