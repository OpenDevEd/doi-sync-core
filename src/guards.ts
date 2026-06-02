export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function idString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  return asString(value);
}
