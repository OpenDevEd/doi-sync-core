import { describe, expect, it } from 'vitest';
import { stableJson, sha256Hex } from '../hash.js';

describe('canonical hashing', () => {
  it('serializes object keys deterministically and hashes the result', () => {
    const left = { b: 2, a: { y: true, x: ['z', 'a'] } };
    const right = { a: { x: ['z', 'a'], y: true }, b: 2 };

    expect(stableJson(left)).toBe(stableJson(right));
    expect(stableJson(left)).toBe('{"a":{"x":["z","a"],"y":true},"b":2}');
    expect(sha256Hex(left)).toHaveLength(64);
    expect(sha256Hex(left)).toBe(sha256Hex(right));
  });

  it('orders keys by JavaScript code units rather than process locale', () => {
    const value = { b: 1, B: 2, aa: 3, a: 4 };

    expect(stableJson(value)).toBe('{"B":2,"a":4,"aa":3,"b":1}');
  });
});
