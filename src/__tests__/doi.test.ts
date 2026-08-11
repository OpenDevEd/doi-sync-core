import { describe, expect, it } from 'vitest';

import { analyzeDoiDrift, normalizeDoi, resolveDoiCandidates } from '../doi.js';

describe('provider-neutral DOI helpers', () => {
  it('resolves the first valid candidate without knowing its host data model', () => {
    expect(resolveDoiCandidates([
      { source: 'canonical-record', value: '' },
      { source: 'managed-crossref', value: 'https://doi.org/10.53832/OpenDevEd.1205' },
      { source: 'external-metadata', value: '10.9999/ignored' }
    ])).toEqual({
      doi: '10.53832/opendeved.1205',
      source: 'managed-crossref'
    });
  });

  it('reports normalized conflicts against a canonical DOI', () => {
    expect(analyzeDoiDrift({
      canonicalDoi: 'https://doi.org/10.53832/OpenDevEd.1205',
      candidates: [
        { source: 'provider-field', value: '10.53832/opendeved.1205' },
        { source: 'imported-metadata', value: 'DOI: 10.9999/wrong' },
        { source: 'managed-link', value: 'https://doi.org/10.9999/wrong' }
      ]
    })).toEqual({
      drifted: true,
      canonicalDoi: '10.53832/opendeved.1205',
      conflicts: [
        { source: 'imported-metadata', doi: '10.9999/wrong' },
        { source: 'managed-link', doi: '10.9999/wrong' }
      ]
    });
  });

  it('does not corrupt valid suffix punctuation or extract DOIs from prose', () => {
    expect(normalizeDoi('10.1234/foo(2024)')).toBe('10.1234/foo(2024)');
    expect(normalizeDoi('This sentence mentions 10.1234/foo')).toBeNull();
  });
});
