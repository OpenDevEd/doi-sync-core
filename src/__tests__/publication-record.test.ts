import { describe, expect, it } from 'vitest';

import {
  parsePublicationIdentifiers,
  parsePublicationRecordSnapshot
} from '../publication/record.js';

describe('publication record contract', () => {
  it('parses a provider-neutral canonical record snapshot', () => {
    expect(parsePublicationRecordSnapshot({
      recordKey: 'REPORT01',
      canonicalRevision: 4,
      itemType: 'Report',
      title: '  Evidence synthesis  ',
      publicationDate: '2026-08-11',
      creators: [{ type: 'organizational', name: 'OpenDevEd' }],
      publisher: 'OpenDevEd',
      rights: 'CC BY 4.0',
      license: 'cc-by-4.0',
      tags: [' education ', 'evidence'],
      landingUrl: 'https://example.org/items/REPORT01',
      fields: { reportNumber: '12', pages: 42 }
    })).toMatchObject({
      recordKey: 'REPORT01',
      canonicalRevision: 4,
      title: 'Evidence synthesis',
      tags: ['education', 'evidence'],
      fields: { reportNumber: '12', pages: 42 }
    });
  });

  it('rejects a non-positive canonical revision', () => {
    expect(() => parsePublicationRecordSnapshot({
      recordKey: 'REPORT01',
      canonicalRevision: 0,
      itemType: 'Report',
      title: 'Evidence synthesis',
      publicationDate: '2026',
      creators: [],
      tags: [],
      landingUrl: 'https://example.org/items/REPORT01',
      fields: {}
    })).toThrow();
  });

  it('normalizes explicitly classified publication identifiers', () => {
    expect(parsePublicationIdentifiers({
      bibliographicDoi: 'https://doi.org/10.1000/External.1',
      managedCrossrefDoi: 'DOI: 10.53832/OpenDevEd.1205',
      zenodoVersionDoi: '10.5281/ZENODO.1234',
      zenodoConceptDoi: '10.5281/zenodo.1233'
    })).toEqual({
      bibliographicDoi: '10.1000/external.1',
      managedCrossrefDoi: '10.53832/opendeved.1205',
      zenodoVersionDoi: '10.5281/zenodo.1234',
      zenodoConceptDoi: '10.5281/zenodo.1233'
    });
  });
});
