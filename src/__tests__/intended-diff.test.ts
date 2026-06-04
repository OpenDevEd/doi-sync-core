import { describe, expect, it } from 'vitest';
import { buildIntendedDiff } from '../intended-diff.js';
import type { SyncPlan } from '../planner.js';
import { buildSyncPayloadSnapshots } from '../snapshots.js';

const metadata = {
  doi: '10.53832/opendeved.1207',
  itemType: 'report',
  title: 'WISE AI Testbed Evaluation Framework',
  publicationDate: '2026-05-20',
  creators: [],
  tags: []
} as const;

describe('intended sync diffs', () => {
  it('describes Crossref and Zenodo create intent without needing provider writes', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' },
        { type: 'zenodo_create', payloadHash: 'zenodo-new', fileManifestHash: 'files-new' },
        { type: 'zotero_writeback' }
      ],
      metadata,
      fileManifest: {
        files: [{
          zoteroAttachmentKey: 'PDF12345',
          zoteroVersion: 1,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          supported: true
        }],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-new'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 0
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207',
          extra: ''
        }
      },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    expect(diff.sections.map((section) => section.provider)).toEqual(['crossref', 'zenodo', 'zotero']);

    const [crossref, zenodo, zotero] = diff.sections;

    // Crossref summary lines + payload hash + resource URL
    expect(crossref?.lines).toEqual(expect.arrayContaining([
      { kind: 'add', text: 'submit/update DOI 10.53832/opendeved.1207', url: 'https://doi.org/10.53832/opendeved.1207' },
      { kind: 'update', target: 'crossref.payloadHash', text: 'payload hash: none -> crossref-new' },
      { kind: 'info', text: 'resource URL: https://docs.opendeved.net/lib/ABC12345', url: 'https://docs.opendeved.net/lib/ABC12345' }
    ]));

    // Zenodo summary lines + file upload + payload/manifest hashes
    expect(zenodo?.lines).toEqual(expect.arrayContaining([
      { kind: 'add', text: 'create and publish a Zenodo record' },
      { kind: 'add', target: 'zenodo.files', text: 'upload 1 file: report.pdf (application/pdf)' },
      { kind: 'update', target: 'zenodo.metadataHash', text: 'metadata hash: none -> zenodo-new' },
      { kind: 'update', target: 'zenodo.fileManifestHash', text: 'file hash: none -> files-new' }
    ]));

    expect(zotero?.lines).toEqual([
      { kind: 'info', text: 'Zenodo identifiers are pending provider success' },
      { kind: 'info', text: 'parent DOI/Extra/url and managed child links will be planned after Zenodo succeeds' }
    ]);
  });

  it('emits a reason-specific Action needed section for attention-flagged plans', () => {
    const baseInput = {
      record: { id: 'rec-1', zoteroItemKey: 'ABC12345', crossrefDoi: '10.53832/opendeved.1207', doiActivated: true, knownZenodoRecordId: 0 },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: { key: 'ABC12345', version: 7, data: { itemType: 'report', DOI: '10.53832/opendeved.1207', extra: '' } },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    } as const;
    const fileManifest = { files: [], unsupported: [] } as const;
    const hashes = { crossrefPayloadHash: 'crossref-new', zenodoPayloadHash: 'zenodo-new', fileManifestHash: 'files-new' } as const;

    const conflictPlan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'crossref_redeposit', payloadHash: 'crossref-new' }],
      metadata,
      fileManifest,
      hashes,
      attention: { reason: 'ZOTERO_FILE_CONFLICT' }
    };
    const conflictDiff = buildIntendedDiff({ ...baseInput, plan: conflictPlan });
    // Attention is surfaced first so a budget-limited notification can't truncate it off.
    expect(conflictDiff.sections[0]?.title).toBe('Action needed');
    const conflictAction = conflictDiff.sections.find((section) => section.title === 'Action needed');
    expect(conflictAction?.lines[0]?.text).toContain('duplicate');

  });

  it('does not show temporary ZenodoArchiveID removals while a Zenodo adopt is pending provider success', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_legacy_deposition_adopt', depositionId: '502947', payloadHash: 'zenodo-new', fileManifestHash: 'files-new' },
        { type: 'zotero_writeback' }
      ],
      metadata,
      fileManifest: {
        files: [{
          zoteroAttachmentKey: 'PDF12345',
          zoteroVersion: 1,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          supported: true
        }],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-new'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 502947
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207',
          extra: [
            'DOI: 10.53832/opendeved.1207',
            'ZenodoArchiveID: 502947',
            'ZenodoArchiveConcept: 502946'
          ].join('\n'),
          url: 'https://docs.opendeved.net/lib/ABC12345'
        }
      },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    expect(diff.sections.find((section) => section.provider === 'zotero')).toEqual({
      provider: 'zotero',
      title: 'Zotero writeback',
      lines: [
        { kind: 'info', text: 'Zenodo identifiers are pending provider success' },
        { kind: 'info', text: 'parent DOI/Extra/url and managed child links will be planned after Zenodo succeeds' }
      ]
    });
  });

  it('describes exact Zotero writeback changes after Zenodo identifiers are settled', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zotero_writeback' }],
      metadata,
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing',
        previousAttachmentKeys: [],
        zenodoLatestRecordId: '502947',
        zenodoParentId: '502946',
        zenodoConceptDoi: '10.5072/zenodo.502946',
        zenodoVersionDoi: '10.5072/zenodo.502947',
        consecutiveFailureCount: 0
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 0
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207',
          extra: '',
          url: ''
        }
      },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    expect(diff.sections).toEqual([{
      provider: 'zotero',
      title: 'Zotero writeback',
      lines: [
        { kind: 'update', target: 'zotero.url', text: 'parent URL: none -> https://docs.opendeved.net/lib/ABC12345', before: '', after: 'https://docs.opendeved.net/lib/ABC12345', url: 'https://docs.opendeved.net/lib/ABC12345' },
        { kind: 'add', target: 'zotero.extra', text: 'DOI: 10.53832/opendeved.1207', before: null, after: 'DOI: 10.53832/opendeved.1207' },
        { kind: 'add', target: 'zotero.extra', text: 'ZenodoArchiveID: 502947', before: null, after: 'ZenodoArchiveID: 502947' },
        { kind: 'add', target: 'zotero.extra', text: 'ZenodoArchiveConcept: 502946', before: null, after: 'ZenodoArchiveConcept: 502946' },
        { kind: 'add', target: 'zotero.extra', text: 'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1207', before: null, after: 'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1207' },
        { kind: 'add', text: 'child link: Zenodo deposit', url: 'https://sandbox.zenodo.org/deposit/502947' },
        { kind: 'add', text: 'child link: Zenodo record', url: 'https://sandbox.zenodo.org/record/502947' },
        { kind: 'add', text: 'child link: DOI lookup', url: 'https://doi.org/10.53832/opendeved.1207' }
      ]
    }]);
  });

  it('describes managed Zotero child link updates and stale duplicate deletes', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zotero_writeback' }],
      metadata,
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing',
        previousAttachmentKeys: [],
        zenodoLatestRecordId: '502947',
        zenodoParentId: '502946',
        consecutiveFailureCount: 0
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 0
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207',
          extra: [
            'DOI: 10.53832/opendeved.1207',
            'ZenodoArchiveID: 502947',
            'ZenodoArchiveConcept: 502946'
          ].join('\n'),
          url: 'https://docs.opendeved.net/lib/ABC12345'
        }
      },
      zoteroChildren: [{
        key: 'OLDLINK1',
        version: 7,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [OLDKEY12]',
          url: 'https://doi.org/10.53832/opendeved.9999',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'DUPLINK2',
        version: 8,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [OLDER999]',
          url: 'https://doi.org/10.53832/opendeved.9998',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    expect(diff.sections).toEqual([{
      provider: 'zotero',
      title: 'Zotero writeback',
      lines: [
        { kind: 'add', target: 'zotero.extra', text: 'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1207', before: null, after: 'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1207' },
        { kind: 'add', text: 'child link: Zenodo deposit', url: 'https://sandbox.zenodo.org/deposit/502947' },
        { kind: 'add', text: 'child link: Zenodo record', url: 'https://sandbox.zenodo.org/record/502947' },
        {
          kind: 'update',
          target: 'zotero.child.OLDLINK1',
          text: 'child link: DOI lookup',
          before: 'https://doi.org/10.53832/opendeved.9999',
          after: 'https://doi.org/10.53832/opendeved.1207',
          url: 'https://doi.org/10.53832/opendeved.1207'
        },
        {
          kind: 'add',
          target: 'zotero.child.OLDLINK1.tags',
          text: 'tag: _r:crossref'
        },
        {
          kind: 'remove',
          target: 'zotero.child.DUPLINK2',
          text: 'stale managed child link: DOI lookup',
          before: 'https://doi.org/10.53832/opendeved.9998',
          after: null
        }
      ]
    }]);
  });

  it('emits per-field add lines for the planned Zenodo metadata on a draft create (DIFF-2)', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zenodo_draft_create', payloadHash: 'zenodo-new' }],
      metadata: {
        doi: '10.53832/opendeved.1207',
        itemType: 'report',
        title: 'WISE AI Testbed Evaluation Framework',
        publicationDate: '2026-05-20',
        abstract: 'Summary.',
        creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
        tags: []
      },
      fileManifest: { files: [], unsupported: [] },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 0
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: { itemType: 'report', DOI: '10.53832/opendeved.1207', extra: '' }
      },
      zoteroChildren: [],
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroSelectUrl: 'zotero://select/groups/123/items/ABC12345'
    });

    const zenodoLines = diff.sections.find((section) => section.provider === 'zenodo')?.lines ?? [];
    expect(diff.sections.find((section) => section.provider === 'zenodo')?.title).toBe('Zenodo legacy deposition payload');
    const targets = zenodoLines.map((line) => line.target).filter((target): target is string => Boolean(target));

    // Should include per-field add lines for the legacy deposition write payload.
    expect(targets).toContain('zenodo.metadata.title');
    expect(targets).toContain('zenodo.metadata.description');
    expect(targets).toContain('zenodo.metadata.related_identifiers');
    expect(targets).toContain('zenodo.metadata.doi');
    // And keep the trailing hash summary
    expect(targets).toContain('zenodo.metadataHash');

    // The description line carries the Kerko appendix
    const descriptionLine = zenodoLines.find((line) => line.target === 'zenodo.metadata.description');
    expect(descriptionLine?.kind).toBe('add');
    expect(descriptionLine?.after).toContain('<p>Available from');
  });

  it('surfaces tag-delta lines (add + remove) on Zotero child-link updates', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zotero_writeback' }],
      metadata,
      fileManifest: { files: [], unsupported: [] },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing',
        previousAttachmentKeys: [],
        zenodoLatestRecordId: '502947',
        zenodoParentId: '502946',
        consecutiveFailureCount: 0
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 0
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207',
          extra: [
            'DOI: 10.53832/opendeved.1207',
            'ZenodoArchiveID: 502947',
            'ZenodoArchiveConcept: 502946'
          ].join('\n'),
          url: 'https://docs.opendeved.net/lib/ABC12345'
        }
      },
      zoteroChildren: [{
        key: 'DOILINK',
        version: 4,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [ABC12345]',
          url: 'https://doi.org/10.53832/opendeved.1207',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }, { tag: '_r:legacy_extra' }]
        }
      }],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    const tagLines = diff.sections
      .flatMap((section) => section.lines)
      .filter((line) => line.target === 'zotero.child.DOILINK.tags');

    expect(tagLines).toEqual([
      { kind: 'add', target: 'zotero.child.DOILINK.tags', text: 'tag: _r:crossref' }
    ]);
  });

  it('describes provider metadata fields that changed when previous payload snapshots exist', () => {
    const previousMetadata = {
      ...metadata,
      title: 'Old evidence title'
    };
    const fileManifest = {
      files: [],
      unsupported: []
    } as const;
    const previousSnapshots = buildSyncPayloadSnapshots({
      metadata: previousMetadata,
      fileManifest,
      doiPolicy: 'dual',
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345'
    });
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' },
        { type: 'zenodo_metadata_update', payloadHash: 'zenodo-new' }
      ],
      metadata,
      fileManifest,
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        crossrefPayloadHash: 'crossref-old',
        crossrefPayloadSnapshot: previousSnapshots.crossrefPayload,
        zenodoPayloadHash: 'zenodo-old',
        zenodoPayloadSnapshot: previousSnapshots.zenodoPayload,
        fileManifestHash: 'files-existing',
        fileManifestSnapshot: previousSnapshots.fileManifest,
        previousAttachmentKeys: [],
        consecutiveFailureCount: 0
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 502947
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207',
          extra: ''
        }
      },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    expect(diff.sections[0]?.lines).toContainEqual({
      kind: 'update',
      target: 'crossref.metadata.title',
      text: 'metadata.title',
      before: 'Old evidence title',
      after: 'WISE AI Testbed Evaluation Framework'
    });
    expect(diff.sections[1]?.lines).toContainEqual({
      kind: 'update',
      target: 'zenodo.metadata.title',
      text: 'metadata.title',
      before: 'Old evidence title',
      after: 'WISE AI Testbed Evaluation Framework'
    });
  });

  it('describes the Crossref relation diff when a Zenodo version DOI becomes available', () => {
    const fileManifest = {
      files: [],
      unsupported: []
    } as const;
    const previousSnapshots = buildSyncPayloadSnapshots({
      metadata,
      fileManifest,
      doiPolicy: 'dual',
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345'
    });
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{
        type: 'crossref_redeposit',
        payloadHash: 'crossref-with-relation',
        relation: {
          type: 'isSupplementedBy',
          identifierType: 'doi',
          identifier: '10.5281/zenodo.20342806',
          description: 'Archived file package'
        }
      }],
      metadata,
      fileManifest,
      hashes: {
        crossrefPayloadHash: 'crossref-with-relation',
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        crossrefPayloadHash: 'crossref-without-relation',
        crossrefPayloadSnapshot: previousSnapshots.crossrefPayload,
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing',
        previousAttachmentKeys: [],
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806',
        consecutiveFailureCount: 0
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 20342806
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207'
        }
      },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://zenodo.org'
    });

    expect(diff.sections[0]?.lines).toContainEqual({
      kind: 'add',
      target: 'crossref.relation.identifier',
      text: 'relation.identifier',
      before: null,
      after: '10.5281/zenodo.20342806'
    });
  });

  it('does not present an external-Crossref Zenodo DOI overwrite for an existing Zenodo/DataCite record', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zenodo_metadata_update', payloadHash: 'zenodo-new' }],
      metadata,
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-existing'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        zenodoPayloadHash: 'zenodo-existing',
        fileManifestHash: 'files-existing',
        previousAttachmentKeys: [],
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 20342806
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207'
        }
      },
      zoteroChildren: [],
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://zenodo.org'
    });

    const zenodoLines = diff.sections.flatMap((section) => section.provider === 'zenodo' ? section.lines : []);
    expect(zenodoLines.some((line) => line.target === 'zenodo.metadata.doi')).toBe(false);
    expect(JSON.stringify(zenodoLines)).not.toContain('10.53832/opendeved.1207');
  });

  it('describes attachment-level Zenodo version diffs from worker file state', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{
        type: 'zenodo_new_version',
        payloadHash: 'zenodo-new',
        fileManifestHash: 'files-new',
        removedAttachmentKeys: ['OLDPDF']
      }],
      metadata,
      fileManifest: {
        files: [{
          zoteroAttachmentKey: 'PDF12345',
          zoteroVersion: 5,
          filename: 'report-v2.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'new-md5',
          zoteroMtime: 999,
          supported: true
        }],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-new'
      }
    };

    const diff = buildIntendedDiff({
      plan,
      state: {
        zenodoPayloadHash: 'zenodo-old',
        fileManifestHash: 'files-old',
        previousAttachmentKeys: ['OLDPDF', 'PDF12345'],
        previousFiles: [
          {
            zoteroAttachmentKey: 'OLDPDF',
            filename: 'old.pdf',
            contentType: 'application/pdf',
            zoteroMd5: 'old-md5',
            zoteroMtime: 111,
            zenodoRecordId: '502100'
          },
          {
            zoteroAttachmentKey: 'PDF12345',
            filename: 'report.pdf',
            contentType: 'application/pdf',
            zoteroMd5: 'previous-md5',
            zoteroMtime: 888,
            zenodoRecordId: '502100'
          }
        ],
        zenodoLatestRecordId: '502100',
        zenodoParentId: '502099',
        consecutiveFailureCount: 0
      },
      record: {
        id: 'rec-1',
        zoteroItemKey: 'ABC12345',
        crossrefDoi: '10.53832/opendeved.1207',
        doiActivated: true,
        knownZenodoRecordId: 0
      },
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      zoteroParent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1207'
        }
      },
      zoteroChildren: [],
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org'
    });

    expect(diff.sections[0]?.lines).toContainEqual({
      kind: 'remove',
      target: 'zenodo.files',
      text: 'remove old.pdf (application/pdf) [OLDPDF]',
      before: 'old.pdf | application/pdf | md5=old-md5 | mtime=111',
      after: null
    });
    expect(diff.sections[0]?.lines).toContainEqual({
      kind: 'update',
      target: 'zenodo.files',
      text: 'file changed: report-v2.pdf [PDF12345]',
      before: 'report.pdf | application/pdf | md5=previous-md5 | mtime=888',
      after: 'report-v2.pdf | application/pdf | md5=new-md5 | mtime=999'
    });
  });
});
