import { describe, expect, it } from 'vitest';
import { analyzeDoiDrift, normalizeDoi, resolveCrossrefDoi } from '../doi.js';

describe('DOI drift analysis', () => {
  it('accepts matching DOI values from Zotero fields, Extra, and call number', () => {
    const result = analyzeDoiDrift({
      recordDoi: 'https://doi.org/10.53832/OpenDevEd.1205',
      zoteroDoi: '10.53832/opendeved.1205',
      extra: 'DOI: 10.53832/opendeved.1205\nUnrelated: keep me',
      callNumber: 'opendeved.1205',
      callNumberDoiPrefix: '10.53832'
    });

    expect(result).toEqual({
      drifted: false,
      canonicalDoi: '10.53832/opendeved.1205',
      conflicts: []
    });
    expect(normalizeDoi(' https://doi.org/10.53832/OpenDevEd.1205 ')).toBe('10.53832/opendeved.1205');
  });

  it('resolves Crossref DOI using the patched zotero-lib source order', () => {
    expect(resolveCrossrefDoi({
      recordDoi: '10.53832/record.1',
      zoteroDoi: '10.53832/zotero-uppercase.1',
      zoteroLowercaseDoi: '10.53832/zotero-lowercase.1',
      extra: 'DOI: 10.53832/extra.1',
      callNumber: 'callnumber.1',
      callNumberDoiPrefix: '10.53832'
    })).toEqual({ doi: '10.53832/record.1', source: 'record' });

    expect(resolveCrossrefDoi({
      recordDoi: '10.53832/record.1',
      extra: 'not managed\n10.53832/bare-extra.1',
      callNumber: 'callnumber.1',
      callNumberDoiPrefix: '10.53832'
    })).toEqual({ doi: '10.53832/record.1', source: 'record' });

    expect(resolveCrossrefDoi({
      recordDoi: '',
      extra: 'not managed\n10.53832/bare-extra.1',
      callNumber: 'callnumber.1',
      callNumberDoiPrefix: '10.53832'
    })).toEqual({ doi: '10.53832/bare-extra.1', source: 'extra' });

    expect(resolveCrossrefDoi({
      recordDoi: '',
      callNumber: 'callnumber.1',
      callNumberDoiPrefix: '10.53832'
    })).toEqual({ doi: '10.53832/callnumber.1', source: 'callNumber' });
  });

  it('normalizes only DOI field values without corrupting valid suffix punctuation', () => {
    expect(normalizeDoi('10.1234/foo(2024)')).toBe('10.1234/foo(2024)');
    expect(normalizeDoi('This sentence mentions 10.1234/foo')).toBeNull();
  });

  it('detects DOI URL drift in Zotero Extra managed DOI lines', () => {
    expect(analyzeDoiDrift({
      recordDoi: '10.53832/opendeved.1205',
      extra: 'DOI: https://doi.org/10.9999/wrong'
    })).toEqual({
      drifted: true,
      canonicalDoi: '10.53832/opendeved.1205',
      conflicts: [{ source: 'extra', doi: '10.9999/wrong' }]
    });
  });
});
