import { describe, expect, it } from 'vitest';
import { toJsonValue } from '../json.js';

describe('JSON snapshot conversion', () => {
  it('normalizes undefined array entries to null like JSON.stringify', () => {
    expect(toJsonValue(['a', undefined, { keep: true, drop: undefined }])).toEqual([
      'a',
      null,
      { keep: true }
    ]);
  });
});
