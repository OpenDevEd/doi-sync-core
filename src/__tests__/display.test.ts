import { describe, expect, it } from 'vitest';

import { buildDoiDisplayLinks } from '../display.js';

describe('DOI display helpers', () => {
  it('builds links from explicit provider-neutral identifiers', () => {
    const display = buildDoiDisplayLinks({
      bibliographicDoi: '10.1000/external.1',
      crossrefDoi: 'https://doi.org/10.53832/OpenDevEd.1207',
      zenodoVersionDoi: '10.5281/zenodo.20342806',
      zenodoConceptDoi: '10.5281/zenodo.20342805',
      zenodoRecordId: '20342806',
      zenodoConceptRecordId: '20342805'
    });

    expect(display.bibliographicDoi).toEqual({
      provider: 'doi',
      kind: 'doi',
      label: 'DOI',
      value: '10.1000/external.1',
      url: 'https://doi.org/10.1000/external.1'
    });
    expect(display.crossrefDoi?.value).toBe('10.53832/opendeved.1207');
    expect(display.zenodoVersionDoi?.value).toBe('10.5281/zenodo.20342806');
    expect(display.zenodoConceptDoi?.value).toBe('10.5281/zenodo.20342805');
    expect(display.zenodoRecord?.url).toBe('https://zenodo.org/records/20342806');
    expect(display.zenodoConceptRecord?.url).toBe('https://zenodo.org/records/20342805');
  });

  it('deduplicates a bibliographic DOI that is also managed by Crossref', () => {
    const display = buildDoiDisplayLinks({
      bibliographicDoi: '10.53832/opendeved.1205',
      crossrefDoi: 'https://doi.org/10.53832/OpenDevEd.1205'
    });

    expect(display.bibliographicDoi).toBe(display.crossrefDoi);
    expect(display.links).toEqual([display.crossrefDoi]);
  });

  it('does not synthesize a Zenodo DOI from a record id', () => {
    const display = buildDoiDisplayLinks({ zenodoRecordId: 20350001 });

    expect(display.zenodoRecord?.url).toBe('https://zenodo.org/records/20350001');
    expect(display.zenodoVersionDoi).toBeUndefined();
  });

  it('uses an explicit sandbox record base URL', () => {
    const display = buildDoiDisplayLinks({
      zenodoRecordId: '123456',
      zenodoBaseUrl: 'https://sandbox.zenodo.org/'
    });

    expect(display.zenodoRecord?.url).toBe('https://sandbox.zenodo.org/records/123456');
  });

  it('omits record links when an explicit base URL is invalid', () => {
    const display = buildDoiDisplayLinks({
      zenodoRecordId: '123456',
      zenodoBaseUrl: 'sandbox.zenodo.org'
    });

    expect(display.zenodoRecord).toBeUndefined();
    expect(display.links).toEqual([]);
  });
});
