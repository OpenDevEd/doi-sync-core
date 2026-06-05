import { describe, expect, it } from 'vitest';

import { buildDoiDisplayLinks } from '../display.js';

describe('DOI display helpers', () => {
  it('shows Crossref DOI plus Zenodo record links for external-Crossref Zenodo records', () => {
    const display = buildDoiDisplayLinks({
      DOI: 'https://doi.org/10.53832/OpenDevEd.1207',
      extra: [
        'Reviewed by: Someone',
        'DOI: 10.53832/opendeved.1207',
        'ZenodoArchiveID: 20342806',
        'ZenodoArchiveConcept: 20342805',
        'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1207'
      ].join('\n')
    });

    expect(display.crossrefDoi).toEqual({
      provider: 'crossref',
      kind: 'doi',
      label: 'Crossref DOI',
      value: '10.53832/opendeved.1207',
      url: 'https://doi.org/10.53832/opendeved.1207'
    });
    expect(display.zenodoRecord).toEqual({
      provider: 'zenodo',
      kind: 'record',
      label: 'Zenodo archive',
      value: '20342806',
      url: 'https://zenodo.org/records/20342806'
    });
    expect(display.zenodoConceptRecord).toEqual({
      provider: 'zenodo',
      kind: 'concept-record',
      label: 'Zenodo concept record',
      value: '20342805',
      url: 'https://zenodo.org/records/20342805'
    });
    expect(display.zenodoVersionDoi).toBeUndefined();
    expect(display.links.map((link) => link.label)).toEqual([
      'Crossref DOI',
      'Zenodo archive',
      'Zenodo concept record'
    ]);
  });

  it('shows explicit Zenodo/DataCite DOI fields without deriving them from record ids', () => {
    const display = buildDoiDisplayLinks({
      DOI: '10.53832/opendeved.1205',
      extra: [
        'ZenodoConceptDOI: 10.5281/zenodo.15043087',
        'ZenodoVersionDOI: https://doi.org/10.5281/zenodo.15043088',
        'DOI: 10.53832/opendeved.1205',
        'ZenodoArchiveID: 15043088',
        'ZenodoArchiveConcept: 15043087'
      ].join('\n')
    });

    expect(display.zenodoVersionDoi).toEqual({
      provider: 'zenodo',
      kind: 'doi',
      label: 'Zenodo DOI',
      value: '10.5281/zenodo.15043088',
      url: 'https://doi.org/10.5281/zenodo.15043088'
    });
    expect(display.zenodoConceptDoi).toEqual({
      provider: 'zenodo',
      kind: 'doi',
      label: 'Zenodo concept DOI',
      value: '10.5281/zenodo.15043087',
      url: 'https://doi.org/10.5281/zenodo.15043087'
    });
    expect(display.links.map((link) => link.label)).toEqual([
      'Crossref DOI',
      'Zenodo DOI',
      'Zenodo concept DOI',
      'Zenodo archive',
      'Zenodo concept record'
    ]);
  });

  it('uses Zotero Extra DOI when the parent DOI field is empty', () => {
    const display = buildDoiDisplayLinks({
      extra: 'DOI: https://doi.org/10.53832/ekitabu.1005'
    });

    expect(display.crossrefDoi?.value).toBe('10.53832/ekitabu.1005');
  });

  it('does not turn a ZenodoArchiveID into a fake Zenodo DOI', () => {
    const display = buildDoiDisplayLinks({
      DOI: '10.53832/edtechhub.1171',
      extra: 'ZenodoArchiveID: 20350001'
    });

    expect(display.zenodoRecord?.url).toBe('https://zenodo.org/records/20350001');
    expect(display.zenodoVersionDoi).toBeUndefined();
  });

  it('falls back to managed Zotero identifier-link attachments', () => {
    const display = buildDoiDisplayLinks({
      attachmentsData: [
        {
          linkMode: 'linked_url',
          url: 'https://doi.org/10.53832/unlockingdata.1033',
          tags: ['_r:doi', '_r:crossref', '_r:zotzen']
        },
        {
          linkMode: 'linked_url',
          url: 'https://sandbox.zenodo.org/record/123456',
          tags: ['_r:zenodoRecord', '_r:zotzen']
        }
      ]
    });

    expect(display.crossrefDoi?.url).toBe('https://doi.org/10.53832/unlockingdata.1033');
    expect(display.zenodoRecord).toEqual({
      provider: 'zenodo',
      kind: 'record',
      label: 'Zenodo archive',
      value: '123456',
      url: 'https://sandbox.zenodo.org/records/123456'
    });
  });
});
