import { describe, expect, it } from 'vitest';
import { buildSyncPayloadSnapshots } from '../snapshots.js';
import { ZENODO_INVENIORDM_ACCEPT, buildZenodoWritePayload, parseZenodoRecordIdentifiers } from '../zenodo/records.js';

describe('Zenodo records', () => {
  it('builds the actual legacy deposition write payload in the zotzen-compatible shape', () => {
    expect(ZENODO_INVENIORDM_ACCEPT).toBe('application/vnd.inveniordm.v1+json');

    const metadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'preprint',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      abstract: 'Summary',
      language: 'en',
      publisher: 'Open Development & Education',
      creators: [{
        type: 'personal',
        name: 'Lovelace, Ada',
        givenName: 'Ada',
        familyName: 'Lovelace',
        affiliation: 'Analytical Engine Lab',
        orcid: '0000-0001-2345-6789'
      }],
      tags: ['evidence']
    } as const;

    const payload = buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata
    });

    expect(payload).toEqual({
      metadata: {
        access_right: 'open',
        creators: [{
          name: 'Lovelace, Ada',
          affiliation: 'Analytical Engine Lab',
          orcid: '0000-0001-2345-6789'
        }],
        description: 'Summary',
        publication_date: '2026-05-20',
        publication_type: 'report',
        title: 'Evidence report',
        upload_type: 'publication'
      }
    });
  });

  it('uses the exact Zenodo write payload for snapshots and diffs', () => {
    const metadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      abstract: 'Summary',
      creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
      tags: []
    } as const;

    const resourceUrl = 'https://my.educationevidence.io/lib/record/ABC12345';

    const snapshots = buildSyncPayloadSnapshots({
      metadata,
      fileManifest: { files: [], unsupported: [] },
      doiPolicy: 'dual',
      resourceUrl
    });

    expect(snapshots.zenodoPayload).toEqual(buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata,
      resourceUrl
    }));
  });

  it('omits legacy communities when there is no existing community to preserve', () => {
    const payload = buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      }
    });

    expect(payload.metadata).not.toHaveProperty('communities');
  });

  it('includes stable Zotero file identity fields in file snapshots without version churn', () => {
    const snapshots = buildSyncPayloadSnapshots({
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [{
          zoteroAttachmentKey: 'PDF12345',
          zoteroVersion: 7,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'md5-1',
          zoteroMtime: 123,
          supported: true
        }],
        unsupported: []
      },
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(snapshots.fileManifest).toEqual({
      files: [{
        zoteroAttachmentKey: 'PDF12345',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        linkMode: 'imported_file',
        source: 'zotero',
        zoteroMd5: 'md5-1',
        zoteroMtime: 123
      }]
    });
  });

  it('keeps the file snapshot stable when only the Zotero attachment version changes', () => {
    const metadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      creators: [],
      tags: []
    } as const;
    const file = {
      zoteroAttachmentKey: 'PDF12345',
      filename: 'report.pdf',
      contentType: 'application/pdf',
      linkMode: 'imported_file' as const,
      source: 'zotero' as const,
      zoteroMd5: 'md5-1',
      zoteroMtime: 123,
      supported: true as const
    };

    const before = buildSyncPayloadSnapshots({
      metadata,
      fileManifest: {
        files: [{ ...file, zoteroVersion: 7 }],
        unsupported: []
      },
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    const after = buildSyncPayloadSnapshots({
      metadata,
      fileManifest: {
        files: [{ ...file, zoteroVersion: 8 }],
        unsupported: []
      },
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(after.fileManifest).toEqual(before.fileManifest);
  });

  it('sets the Crossref DOI on Zenodo only for the external-DOI policy', () => {
    const metadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      creators: [],
      tags: []
    } as const;

    expect(buildZenodoWritePayload({
      doiPolicy: 'external-crossref',
      metadata
    }).metadata['doi']).toBe('10.53832/opendeved.1205');
    expect(buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata
    }).metadata['doi']).toBeUndefined();
  });

  it('preserves an existing Zenodo/DataCite DOI in snapshots even when the configured policy is external Crossref', () => {
    const metadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      creators: [],
      tags: []
    } as const;

    const snapshots = buildSyncPayloadSnapshots({
      metadata,
      fileManifest: { files: [], unsupported: [] },
      doiPolicy: 'external-crossref',
      existingZenodoVersionDoi: '10.5281/zenodo.20342806',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(snapshots.zenodoPayload).toEqual(buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }));
  });

  it('keeps external Crossref DOI snapshots external when the existing Zenodo DOI already matches Crossref', () => {
    const metadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      creators: [],
      tags: []
    } as const;

    const snapshots = buildSyncPayloadSnapshots({
      metadata,
      fileManifest: { files: [], unsupported: [] },
      doiPolicy: 'external-crossref',
      existingZenodoVersionDoi: '10.53832/opendeved.1205',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(snapshots.zenodoPayload).toEqual(buildZenodoWritePayload({
      doiPolicy: 'external-crossref',
      metadata,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }));
  });

  it('escapes resource URLs before appending them to Zenodo HTML descriptions', () => {
    const payload = buildZenodoWritePayload({
      doiPolicy: 'external-crossref',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Summary.',
        creators: [],
        tags: []
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345?a=1&b=<two>"'
    });

    expect(payload).toMatchObject({
      metadata: {
        description: 'Summary.\n\n<p>Available from <a href="https://docs.opendeved.net/lib/ABC12345?a=1&amp;b=&lt;two&gt;&quot;">https://docs.opendeved.net/lib/ABC12345?a=1&amp;b=&lt;two&gt;&quot;</a></p>'
      }
    });
  });

  it('does not preserve any client-supplied DOI fields in dual-DOI mode', () => {
    const payload = buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
        tags: []
      },
      existingMetadata: {
        doi: '10.53832/opendeved.1205',
        prereserve_doi: { doi: '10.5281/zenodo.502947', recid: 502947 }
      }
    });

    expect(payload.metadata['doi']).toBeUndefined();
    expect(payload.metadata['prereserve_doi']).toBeUndefined();
  });

  it('merges legacy Zenodo metadata without dropping provider-controlled or preserved fields', () => {
    const payload = buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        abstract: 'Updated summary',
        creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
        tags: []
      },
      existingMetadata: {
        title: 'Old title',
        upload_type: 'publication',
        publication_type: 'technicalnote',
        description: 'Old summary',
        creators: [{ name: 'Old Author' }],
        access_right: 'open',
        doi: '10.53832/opendeved.1205',
        prereserve_doi: { doi: '10.53832/opendeved.1205', recid: 502440 },
        communities: [{ identifier: 'opendeved' }],
        related_identifiers: [{
          identifier: 'zotero://select/groups/123/items/ABC12345',
          relation: 'isAlternateIdentifier',
          resource_type: 'other',
          scheme: 'url'
        }],
        license: 'cc-by-4.0',
        language: 'eng',
        keywords: ['existing']
      }
    });

    expect(payload).toEqual({
      metadata: {
        access_right: 'open',
        communities: [{ identifier: 'opendeved' }],
        creators: [{ name: 'Lovelace, Ada' }],
        description: 'Updated summary',
        keywords: ['existing'],
        language: 'eng',
        license: 'cc-by-4.0',
        publication_date: '2026-05-21',
        publication_type: 'report',
        related_identifiers: [{
          identifier: 'zotero://select/groups/123/items/ABC12345',
          relation: 'isAlternateIdentifier',
          resource_type: 'other',
          scheme: 'url'
        }],
        title: 'Evidence report v2',
        upload_type: 'publication'
      }
    });
  });

  it('captures version and concept identifiers from current response shape', () => {
    expect(parseZenodoRecordIdentifiers({
      id: '15043088',
      pids: { doi: { identifier: '10.5281/zenodo.15043088', provider: 'datacite' } },
      parent: {
        id: 'abcde-12345',
        pids: { doi: { identifier: '10.5281/zenodo.15043087', provider: 'datacite' } }
      },
      links: {
        self: 'https://zenodo.org/api/records/15043088',
        self_html: 'https://zenodo.org/records/15043088',
        latest: 'https://zenodo.org/api/records/15043088/versions/latest'
      }
    })).toEqual({
      latestRecordId: '15043088',
      parentId: 'abcde-12345',
      versionDoi: '10.5281/zenodo.15043088',
      conceptDoi: '10.5281/zenodo.15043087',
      links: {
        self: 'https://zenodo.org/api/records/15043088',
        selfHtml: 'https://zenodo.org/records/15043088',
        latest: 'https://zenodo.org/api/records/15043088/versions/latest'
      }
    });
  });

  it('fails loudly for legacy-only Zenodo shapes in the primary parser', () => {
    expect(() => parseZenodoRecordIdentifiers({
      id: 15043088,
      conceptrecid: 15043087,
      conceptdoi: '10.5281/zenodo.15043087'
    })).toThrow('current InvenioRDM');
  });

  describe('Kerko/resource URL appendix in description', () => {
    const baseMetadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      abstract: 'Summary.',
      creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
      tags: []
    } as const;

    const appendixUrl = 'https://docs.edtechhub.org/lib/95DU3BRT';
    const appendix = `<p>Available from <a href="${appendixUrl}">${appendixUrl}</a></p>`;

    it('appends an <a>-tagged resource URL paragraph after the abstract when resourceUrl is provided', () => {
      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        resourceUrl: appendixUrl
      });

      expect(payload.metadata['description']).toBe(`Summary.\n\n${appendix}`);
    });

    it('appends the appendix even when the metadata has no abstract', () => {
      const { abstract, ...metadataWithoutAbstract } = baseMetadata;
      void abstract;
      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: metadataWithoutAbstract,
        resourceUrl: appendixUrl
      });

      expect(payload.metadata['description']).toContain(appendix);
    });

    it('is idempotent: re-running with the same resourceUrl does not double-append', () => {
      const first = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        resourceUrl: appendixUrl
      });
      const second = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        resourceUrl: appendixUrl,
        existingMetadata: first.metadata
      });

      const appendixCount = (second.metadata['description'] as string).split(appendix).length - 1;
      expect(appendixCount).toBe(1);
    });

    it('does not touch description when no resourceUrl is provided', () => {
      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata
      });

      expect(payload.metadata['description']).toBe('Summary.');
    });
  });

  describe('Zotero back-link via legacy deposition related_identifiers', () => {
    const baseMetadata = {
      doi: '10.53832/opendeved.1205',
      itemType: 'report',
      title: 'Evidence report',
      publicationDate: '2026-05-20',
      creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
      tags: []
    } as const;

    it('emits a legacy related_identifiers back-link to the Zotero item when zoteroSelectUrl is provided', () => {
      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        zoteroSelectUrl: 'zotero://select/groups/2405685/items/95DU3BRT'
      });

      expect(payload.metadata['related_identifiers']).toEqual([
        {
          identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
          relation: 'isAlternateIdentifier',
          resource_type: 'other',
          scheme: 'url'
        }
      ]);
    });

    it('does not emit related_identifiers when no zoteroSelectUrl is provided', () => {
      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata
      });
      expect(payload.metadata['related_identifiers']).toBeUndefined();
    });

    it('merges the back-link into existing related_identifiers without duplicating it', () => {
      const existingBackLink = {
        identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
        relation: 'isAlternateIdentifier',
        resource_type: 'other',
        scheme: 'url'
      };
      const unrelated = {
        identifier: 'https://example.org/dataset/42',
        relation: 'isSupplementTo',
        resource_type: 'dataset',
        scheme: 'url'
      };

      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        zoteroSelectUrl: 'zotero://select/groups/2405685/items/95DU3BRT',
        existingMetadata: {
          related_identifiers: [unrelated, existingBackLink]
        }
      });

      expect(payload.metadata['related_identifiers']).toEqual([unrelated, existingBackLink]);
    });

    it('normalizes an existing InvenioRDM-shaped Zotero back-link when building a legacy payload', () => {
      const existingBackLink = {
        identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
        relation_type: { id: 'isalternateidentifier' },
        resource_type: { id: 'other' },
        scheme: 'url'
      };

      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        zoteroSelectUrl: 'zotero://select/groups/2405685/items/95DU3BRT',
        existingMetadata: {
          related_identifiers: [existingBackLink]
        }
      });

      expect(payload.metadata['related_identifiers']).toEqual([{
        identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
        relation: 'isAlternateIdentifier',
        resource_type: 'other',
        scheme: 'url'
      }]);
    });

    it('appends the back-link when existing related_identifiers do not contain it', () => {
      const unrelated = {
        identifier: 'https://example.org/dataset/42',
        relation: 'isSupplementTo',
        resource_type: 'dataset',
        scheme: 'url'
      };

      const payload = buildZenodoWritePayload({
        doiPolicy: 'external-crossref',
        metadata: baseMetadata,
        zoteroSelectUrl: 'zotero://select/groups/2405685/items/95DU3BRT',
        existingMetadata: {
          related_identifiers: [unrelated]
        }
      });

      expect(payload.metadata['related_identifiers']).toEqual([
        unrelated,
        {
          identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
          relation: 'isAlternateIdentifier',
          resource_type: 'other',
          scheme: 'url'
        }
      ]);
    });
  });
});
