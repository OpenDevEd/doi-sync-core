import { describe, expect, it } from 'vitest';
import { buildCanonicalMetadataSnapshot } from '../metadata.js';

describe('canonical Zotero metadata', () => {
  it('normalizes deposited metadata and excludes Zotero versions and timestamps', () => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/opendeved.1205',
      fallbackPublicationDate: '1970-01-01',
      zoteroItem: {
        key: 'ABC12345',
        version: 99,
        data: {
          itemType: 'report',
          title: '  Evidence   report  ',
          DOI: '10.53832/opendeved.1205',
          date: '2026-05-20',
          abstractNote: ' Summary ',
          language: 'en',
          institution: 'Open Development & Education',
          creators: [
            { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
            { creatorType: 'author', name: 'Open Development & Education' }
          ],
          tags: [
            { tag: ' Education ' },
            { tag: 'evidence' },
            { tag: '_r:AddedByMyEducationEvidence' },
            { tag: '_r:zotzen' },
            { tag: '_comingsoon' },
            { tag: 'Org:eKitabu' },
            { tag: 'Internal' },
            { tag: 'Approved: Bjoern' },
            { tag: 'publication' },
            { tag: 'fix_metadata' }
          ]
        }
      }
    });

    expect(snapshot).toEqual({
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      abstract: 'Summary',
      language: 'en',
      publisher: 'Open Development & Education',
      creators: [
        { type: 'personal', name: 'Lovelace, Ada', creatorType: 'author', givenName: 'Ada', familyName: 'Lovelace' },
        { type: 'organizational', name: 'Open Development & Education', creatorType: 'author' }
      ],
      tags: ['Education', 'evidence']
    });
  });

  it('uses the zotero-lib Crossref DOI source order before falling back to the record DOI', () => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/opendeved.1205',
      callNumberDoiPrefix: '10.53832',
      fallbackPublicationDate: '1970-01-01',
      zoteroItem: {
        key: 'ABC12345',
        version: 1,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: '10.53832/opendeved.1205',
          doi: '10.53832/ignored.lowercase',
          extra: 'DOI: 10.53832/ignored.extra',
          callNumber: 'ignored.callnumber',
          date: '5 May 2026',
          creators: []
        }
      }
    });

    expect(snapshot.doi).toBe('10.53832/opendeved.1205');
    expect(snapshot.publicationDate).toBe('2026-05-05');
  });

  it('orders external tags by JavaScript code units rather than process locale', () => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/opendeved.1205',
      fallbackPublicationDate: '1970-01-01',
      zoteroItem: {
        key: 'ABC12345',
        version: 1,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: '10.53832/opendeved.1205',
          creators: [],
          tags: [
            { tag: 'b' },
            { tag: 'B' },
            { tag: 'aa' },
            { tag: 'a' }
          ]
        }
      }
    });

    expect(snapshot.tags).toEqual(['B', 'a', 'aa', 'b']);
  });

  it('can derive the Crossref DOI from Zotero callNumber using the configured DOI prefix', () => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/edtechhub.1137',
      callNumberDoiPrefix: '10.53832',
      fallbackPublicationDate: '1970-01-01',
      zoteroItem: {
        key: 'FDJ3ET3C',
        version: 1,
        data: {
          itemType: 'preprint',
          title: 'Leveraging Technology for Scaling Teacher Professional Development',
          callNumber: 'edtechhub.1137',
          date: '02/05/2026',
          institution: 'EdTech Hub',
          creators: []
        }
      }
    });

    expect(snapshot.doi).toBe('10.53832/edtechhub.1137');
    expect(snapshot.publicationDate).toBe('2026-05-02');
    expect(snapshot.publisher).toBe('EdTech Hub');
  });

  it.each([
    ['April 2026', '2026-04-01'],
    ['Apr 2026', '2026-04-01'],
    ['2026-04', '2026-04-01'],
    ['2026-02-24T00:00:00.000Z', '2026-02-24'],
    ['2026-02-24 00:00:00', '2026-02-24'],
    ['2026', '2026-01-01']
  ])('normalizes partial Zotero dates without losing month precision: %s', (zoteroDate, publicationDate) => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/edtechhub.1152',
      fallbackPublicationDate: '1970-01-01',
      zoteroItem: {
        key: '95DU3BRT',
        version: 1,
        data: {
          itemType: 'report',
          title: 'How Is AI Transforming Teachers Roles?',
          DOI: '10.53832/edtechhub.1152',
          date: zoteroDate,
          creators: []
        }
      }
    });

    expect(snapshot.publicationDate).toBe(publicationDate);
  });

  it.each([
    ['10.53832/edtechhub.1193', 'EdTech Hub'],
    ['10.53832/unlockingdata.1045', 'Unlocking data'],
    ['10.53832/ekitabu.1006', 'eKitabu Scaling Inclusive Early Learning for Deaf Children'],
    ['10.53832/opendeved.1207', 'Open Development & Education']
  ])('uses the DOI namespace publisher when Zotero has no publisher field: %s', (recordDoi, publisher) => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi,
      fallbackPublicationDate: '1970-01-01',
      zoteroItem: {
        key: 'ABC12345',
        version: 1,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: recordDoi,
          creators: []
        }
      }
    });

    expect(snapshot.publisher).toBe(publisher);
  });

  it('uses the explicit fallback publication date when Zotero has no parseable date', () => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/opendeved.1205',
      fallbackPublicationDate: '2000-01-02',
      zoteroItem: {
        key: 'ABC12345',
        version: 1,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: '10.53832/opendeved.1205',
          date: 'undated',
          creators: []
        }
      }
    });

    expect(snapshot.publicationDate).toBe('2000-01-02');
  });

  it('enriches creators from an author directory using names and aliases', () => {
    const snapshot = buildCanonicalMetadataSnapshot({
      recordDoi: '10.53832/opendeved.1205',
      fallbackPublicationDate: '1970-01-01',
      authorEnrichments: [{
        name: 'Haßler, Björn',
        aliases: ['Björn Haßler', 'Hassler, Bjorn'],
        orcid: '0000-0002-5277-9947',
        affiliation: 'OpenDevEd'
      }],
      zoteroItem: {
        key: 'ABC12345',
        version: 1,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: '10.53832/opendeved.1205',
          creators: [
            { creatorType: 'author', firstName: 'Björn', lastName: 'Haßler' },
            { creatorType: 'author', name: 'Unmatched Org' }
          ]
        }
      }
    });

    expect(snapshot.creators).toEqual([
      {
        type: 'personal',
        name: 'Haßler, Björn',
        creatorType: 'author',
        givenName: 'Björn',
        familyName: 'Haßler',
        affiliation: 'OpenDevEd',
        orcid: '0000-0002-5277-9947'
      },
      { type: 'organizational', name: 'Unmatched Org', creatorType: 'author' }
    ]);
  });
});
