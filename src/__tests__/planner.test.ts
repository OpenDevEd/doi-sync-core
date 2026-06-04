import { describe, expect, it } from 'vitest';
import { planRecordSync } from '../planner.js';
import { toJsonValue } from '../json.js';
import type { ZoteroParentItem } from '../metadata.js';
import { buildSyncPayloadSnapshots } from '../snapshots.js';
import { sha256Hex } from '../hash.js';

const zoteroItem: ZoteroParentItem = {
  key: 'ABC12345',
  version: 12,
  data: {
    itemType: 'report',
    title: 'Evidence report',
    DOI: '10.53832/opendeved.1205',
    date: '2026-05-20',
    abstractNote: 'Summary',
    institution: 'Open Development & Education',
    creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
    tags: [{ tag: 'evidence' }],
    callNumber: 'opendeved.1205'
  }
};

describe('sync planner', () => {
  it('skips records unless DOI activation is ACTIVE', () => {
    const plan = planRecordSync({
      record: record({ doiActivated: false }),
      zoteroItem,
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan).toEqual({ status: 'skipped', reason: 'DOI_NOT_ACTIVE' });
  });

  it('blocks all external writes when Zotero DOI drift is detected', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem: {
        ...zoteroItem,
        data: { ...zoteroItem.data, DOI: '10.53832/other.999' }
      },
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('needs_attention');
    if (plan.status !== 'needs_attention') throw new Error('expected needs_attention plan');
    expect(plan.reason).toBe('DOI_DRIFT');
    expect(plan.operations).toEqual([]);
  });

  it('blocks all external writes when the Zotero parent item is deleted', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem: {
        ...zoteroItem,
        data: { ...zoteroItem.data, deleted: 1 }
      },
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan).toEqual({
      status: 'needs_attention',
      reason: 'ZOTERO_ITEM_DELETED',
      operations: []
    });
  });

  it('blocks repeated Zenodo creates after an unresolved DOI already-exists collision', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc123')],
      state: {
        lastFailureClass: 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED',
        lastFailureSummary: 'Zenodo says DOI already exists, but lookup found no published record',
        consecutiveFailureCount: 1
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan).toEqual({
      status: 'needs_attention',
      reason: 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED',
      operations: []
    });
  });

  it('blocks Zenodo creates after an ambiguous preflight DOI lookup', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc123')],
      state: {
        lastFailureClass: 'ZENODO_DOI_LOOKUP_AMBIGUOUS',
        lastFailureSummary: 'Zenodo exact DOI lookup found multiple published records',
        consecutiveFailureCount: 1
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan).toEqual({
      status: 'needs_attention',
      reason: 'ZENODO_DOI_LOOKUP_AMBIGUOUS',
      operations: []
    });
  });

  it('does not keep blocking after an unresolved DOI collision has been recovered as an unsubmitted draft', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc123')],
      state: {
        zenodoLegacyDepositionId: '17585551',
        zenodoLegacyDepositionState: 'unsubmitted',
        lastFailureClass: 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED',
        lastFailureSummary: 'Zenodo says DOI already exists, but exact DOI lookup found no published record',
        consecutiveFailureCount: 2
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map((operation) => operation.type)).toEqual([
      'crossref_redeposit',
      'zenodo_legacy_deposition_adopt',
      'zotero_writeback'
    ]);
  });

  it('plans first-time Crossref redeposit and Zenodo creation for active records', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_create', 'zotero_writeback']);
  });

  it('selects only configured publish-tagged PDFs before duplicate filename checks', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [
        importedPdf('PUBLISH1', 'report.pdf', 'abc123', ['PublishPDF']),
        importedPdf('OLDPDF1', 'old.pdf', 'def456', ['_Obsolete']),
        importedPdf('OLDPDF2', 'old.pdf', 'ghi789', ['_Obsolete'])
      ],
      policy: {
        callNumberDoiPrefix: '10.53832',
        doiPolicy: 'dual',
        fallbackPublicationDate: '1970-01-01',
        zoteroPdfTags: ['_publish', 'publishPDF']
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.fileManifest.files.map((file) => file.zoteroAttachmentKey)).toEqual(['PUBLISH1']);
    expect(plan.fileManifest.unsupported).toEqual([]);
    expect(plan.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_create', 'zotero_writeback']);
  });

  it('waits to create the first Zenodo record until Zotero has an uploadable attachment', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_draft_create', 'zotero_writeback']);
  });

  it('updates an unpublished Zenodo draft while Zotero still has no uploadable attachment', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record(),
      zoteroItem: {
        ...zoteroItem,
        data: {
          ...zoteroItem.data,
          title: 'Evidence report corrected'
        }
      },
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoLegacyDepositionId: '504449',
        zenodoLegacyDepositionState: 'unsubmitted',
        zenodoJournaledDraftOperationType: 'zenodo_draft_create',
        zenodoJournaledDraftDepositionId: '504449',
        zenodoJournaledDraftRecordId: '504449',
        zenodoRecoveredZenodoPayloadHash: baseline.hashes.zenodoPayloadHash
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_draft_update', 'zotero_writeback']);
  });

  it('does not update an unpublished Zenodo draft when its metadata is already current and no file is available', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoLegacyDepositionId: '504449',
        zenodoLegacyDepositionState: 'unsubmitted',
        zenodoJournaledDraftOperationType: 'zenodo_draft_create',
        zenodoJournaledDraftDepositionId: '504449',
        zenodoJournaledDraftRecordId: '504449',
        zenodoRecoveredZenodoPayloadHash: baseline.hashes.zenodoPayloadHash
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('noop');
    if (current.status !== 'noop') throw new Error('expected noop plan');
    expect(current.operations).toEqual([]);
  });

  it('publishes an unpublished Zenodo draft once Zotero gets an uploadable attachment', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc123')],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoLegacyDepositionId: '504449',
        zenodoLegacyDepositionState: 'unsubmitted',
        zenodoJournaledDraftOperationType: 'zenodo_draft_create',
        zenodoJournaledDraftDepositionId: '504449',
        zenodoJournaledDraftRecordId: '504449',
        zenodoRecoveredZenodoPayloadHash: baseline.hashes.zenodoPayloadHash
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['zenodo_legacy_deposition_adopt', 'zotero_writeback']);
  });

  it('skips Zenodo file operations when Zotero has a blocking duplicate filename conflict', () => {
    const plan = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [
        importedPdf('PDF12345', 'report.pdf', 'abc123'),
        importedPdf('PDF67890', 'report.pdf', 'def456'),
        importedPdf('APPENDIX', 'appendix.pdf', 'ghi789')
      ],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.fileManifest.unsupported.filter((attachment) => attachment.blocksZenodoFiles)).toHaveLength(2);
    expect(plan.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_draft_create', 'zotero_writeback']);
    // The dropped (conflicting) files are surfaced as attention on the create path too.
    expect(plan.attention).toEqual({ reason: 'ZOTERO_FILE_CONFLICT' });
  });

  it('redeposits Crossref with a Zenodo version DOI relation after Zenodo is published', () => {
    const zoteroChildren = [importedPdf('PDF12345', 'report.pdf', 'abc')] as const;
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren,
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren,
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        previousAttachmentKeys: ['PDF12345'],
        zenodoLatestRecordId: '15043088',
        zenodoParentId: '15043087',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.hashes.crossrefPayloadHash).not.toBe(baseline.hashes.crossrefPayloadHash);
    expect(current.operations).toContainEqual({
      type: 'crossref_redeposit',
      payloadHash: current.hashes.crossrefPayloadHash,
      relation: {
        type: 'isSupplementedBy',
        identifierType: 'doi',
        identifier: '10.5281/zenodo.15043088',
        description: 'Archived file package'
      }
    });
  });

  it('does not add a Crossref relation when a legacy Zenodo record uses the Crossref DOI as its DOI', () => {
    const zoteroChildren = [{
      key: 'PDF12345',
      version: 1,
      data: {
        itemType: 'attachment',
        linkMode: 'imported_file',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        md5: 'abc'
      }
    }] as const;
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren,
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 17585570 }),
      zoteroItem,
      zoteroChildren,
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        previousAttachmentKeys: ['PDF12345'],
        zenodoLatestRecordId: '17585570',
        zenodoParentId: '17585569',
        zenodoVersionDoi: '10.53832/opendeved.1205'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.hashes.crossrefPayloadHash).toBe(baseline.hashes.crossrefPayloadHash);
    expect(current.operations.some((operation) => operation.type === 'crossref_redeposit')).toBe(false);
  });

  it('verifies an accepted pending Crossref deposit instead of redepositing the same payload', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [],
      state: {
        crossrefPendingPayloadHash: baseline.hashes.crossrefPayloadHash,
        crossrefPendingPayloadSnapshot: { metadata: { title: 'Evidence report' } }
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations).toEqual([
      { type: 'crossref_verify_pending', payloadHash: baseline.hashes.crossrefPayloadHash },
      { type: 'zenodo_draft_create', payloadHash: baseline.hashes.zenodoPayloadHash },
      { type: 'zotero_writeback' }
    ]);
  });

  it('plans Zenodo new version, not metadata edit, when files changed on an existing Zenodo record', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'old-md5'
        }
      }],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');
    const relationSettled = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'old-md5'
        }
      }],
      state: {
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (relationSettled.status === 'skipped' || relationSettled.status === 'needs_attention') throw new Error('unexpected relation-settled plan');

    const current = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'new-md5')],
      state: {
        crossrefPayloadHash: relationSettled.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['zenodo_new_version', 'zotero_writeback']);
  });

  it('plans same-record Zenodo file updates for external Crossref DOI records instead of new versions', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'new-md5')],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoVersionDoi: '10.53832/opendeved.1205'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.attention).toBeUndefined();
    expect(current.operations.map((operation) => operation.type)).toEqual(['zenodo_file_update', 'zotero_writeback']);
    expect(current.operations[0]).toMatchObject({
      type: 'zenodo_file_update',
      removedAttachmentKeys: []
    });
    expect(current.operations.some((operation) => operation.type === 'zenodo_new_version')).toBe(false);
  });

  it('still edits published Zenodo metadata for external Crossref DOI records when files are unchanged', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem: {
        ...zoteroItem,
        data: {
          ...zoteroItem.data,
          title: 'Evidence report corrected'
        }
      },
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoVersionDoi: '10.53832/opendeved.1205'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_metadata_update', 'zotero_writeback']);
  });

  it('syncs Crossref, Zenodo metadata, and same-record files for external Crossref DOI records when metadata and files change', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem: {
        ...zoteroItem,
        data: { ...zoteroItem.data, title: 'Evidence report corrected' }
      },
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'new-md5')],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoVersionDoi: '10.53832/opendeved.1205'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_metadata_update', 'zenodo_file_update', 'zotero_writeback']);
    expect(current.attention).toBeUndefined();
    expect(current.operations.some((operation) => operation.type === 'zenodo_new_version')).toBe(false);
  });

  it('preserves the current Zenodo/DataCite DOI when external-Crossref policy updates metadata on an existing dual record', () => {
    const baseline = planRecordSync({
      record: record({ knownZenodoRecordId: 20342806 }),
      zoteroItem,
      zoteroChildren: [],
      state: {
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 20342806 }),
      zoteroItem: {
        ...zoteroItem,
        data: { ...zoteroItem.data, title: 'Evidence report corrected' }
      },
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_metadata_update', 'zotero_writeback']);
    expect(current.hashes.zenodoPayloadHash).toBe(sha256Hex(buildSyncPayloadSnapshots({
      metadata: current.metadata,
      fileManifest: current.fileManifest,
      doiPolicy: 'external-crossref',
      existingZenodoVersionDoi: '10.5281/zenodo.20342806',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }).zenodoPayload));
    expect(current.operations[0]).toMatchObject({
      type: 'crossref_redeposit',
      relation: {
        type: 'isSupplementedBy',
        identifier: '10.5281/zenodo.20342806'
      }
    });
  });

  it('versions an existing Zenodo/DataCite record when files change even if the configured policy is external Crossref', () => {
    const baseline = planRecordSync({
      record: record({ knownZenodoRecordId: 20342806 }),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      state: {
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 20342806 }),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'new-md5')],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.attention).toBeUndefined();
    expect(current.operations.map((operation) => operation.type)).toEqual(['zenodo_new_version', 'zotero_writeback']);
  });

  it('never plans a partial Zenodo new version for a published record with a duplicate-filename conflict, even in dual mode', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc123')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem: {
        ...zoteroItem,
        data: { ...zoteroItem.data, title: 'Evidence report corrected' }
      },
      // A second attachment with the same filename but different content = blocking conflict.
      zoteroChildren: [
        importedPdf('PDF12345', 'report.pdf', 'abc123'),
        importedPdf('PDF67890', 'report.pdf', 'def456')
      ],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    // The conflict must NOT publish a partial new version (which would also advance fileManifestHash
    // and bury the conflict). Metadata + Crossref still sync; the conflict is flagged via attention.
    expect(current.operations.some((operation) => operation.type === 'zenodo_new_version')).toBe(false);
    expect(current.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_metadata_update', 'zotero_writeback']);
    expect(current.attention).toEqual({ reason: 'ZOTERO_FILE_CONFLICT' });
  });

  it('flags a duplicate-filename conflict on a published record even when the surviving file set is unchanged', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc123')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      // The published report.pdf is unchanged; two NEW same-named attachments are added (a conflict),
      // so the surviving-file hash does not change yet the record is still in conflict.
      zoteroChildren: [
        importedPdf('PDF12345', 'report.pdf', 'abc123'),
        importedPdf('DUPAAAAA', 'dup.pdf', 'x1'),
        importedPdf('DUPBBBBB', 'dup.pdf', 'x2')
      ],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    // The conflict is surfaced from its mere presence (not a hash delta), and never plans a file op.
    if (current.status === 'skipped') throw new Error('unexpected skipped plan');
    if (current.status === 'needs_attention') {
      expect(current.reason).toBe('ZOTERO_FILE_CONFLICT');
      expect(current.operations).toEqual([]);
    } else {
      expect(current.attention).toEqual({ reason: 'ZOTERO_FILE_CONFLICT' });
      expect(current.operations.some((operation) => operation.type === 'zenodo_new_version' || operation.type === 'zenodo_create')).toBe(false);
    }
  });

  it('plans a Zenodo new version when the current Zotero item removed all uploadable attachments', () => {
    const baseline = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'old-md5'
        }
      }],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');
    const relationSettled = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'old-md5'
        }
      }],
      state: {
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (relationSettled.status === 'skipped' || relationSettled.status === 'needs_attention') throw new Error('unexpected relation-settled plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: relationSettled.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        previousAttachmentKeys: ['PDF12345'],
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['zenodo_new_version', 'zotero_writeback']);
    expect(current.operations[0]).toMatchObject({
      type: 'zenodo_new_version',
      removedAttachmentKeys: ['PDF12345']
    });
  });

  it('detects removed attachments from migrated file state when previous attachment keys are missing', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        previousFiles: [{
          zoteroAttachmentKey: 'PDF12345',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          zoteroMd5: 'old-md5',
          zoteroMtime: null,
          zenodoRecordId: '15043088'
        }],
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoVersionDoi: '10.53832/opendeved.1205'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.attention).toBeUndefined();
    expect(current.operations[0]).toMatchObject({
      type: 'zenodo_file_update',
      removedAttachmentKeys: ['PDF12345']
    });
    expect(current.operations.some((operation) => operation.type === 'zenodo_new_version')).toBe(false);
  });

  it('detects removed attachments from the previous file manifest snapshot when migrated file rows are missing', () => {
    const baseline = planRecordSync({
      record: record(),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'old-md5')],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        fileManifestSnapshot: toJsonValue(baseline.fileManifest),
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoVersionDoi: '10.53832/opendeved.1205'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'external-crossref', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.attention).toBeUndefined();
    expect(current.operations[0]).toMatchObject({
      type: 'zenodo_file_update',
      removedAttachmentKeys: ['PDF12345']
    });
    expect(current.operations.some((operation) => operation.type === 'zenodo_new_version')).toBe(false);
  });

  it('updates Zenodo files when metadata changes and the current Zotero item removed all uploadable attachments', () => {
    const previous = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'old-md5'
        }
      }],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (previous.status === 'skipped' || previous.status === 'needs_attention') throw new Error('unexpected previous plan');

    const changedZoteroItem = {
      ...zoteroItem,
      data: {
        ...zoteroItem.data,
        title: 'Evidence report with corrected title'
      }
    };
    const currentHashes = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem: changedZoteroItem,
      zoteroChildren: [],
      state: {
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (currentHashes.status === 'skipped' || currentHashes.status === 'needs_attention') throw new Error('unexpected current hash plan');

    const current = planRecordSync({
      record: record({ knownZenodoRecordId: 15043088 }),
      zoteroItem: changedZoteroItem,
      zoteroChildren: [],
      state: {
        crossrefPayloadHash: currentHashes.hashes.crossrefPayloadHash,
        zenodoPayloadHash: previous.hashes.zenodoPayloadHash,
        fileManifestHash: previous.hashes.fileManifestHash,
        previousAttachmentKeys: ['PDF12345'],
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345',
        zenodoConceptDoi: '10.5281/zenodo.15043087',
        zenodoVersionDoi: '10.5281/zenodo.15043088'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations.map((operation) => operation.type)).toEqual(['zenodo_new_version', 'zotero_writeback']);
  });

  it('plans legacy deposition adoption instead of Zenodo creation when an unsubmitted deposition exists', () => {
    const plan = planRecordSync({
      record: record({ knownZenodoRecordId: 17585551 }),
      zoteroItem,
      zoteroChildren: [importedPdf('PDF12345', 'report.pdf', 'abc')],
      state: {
        zenodoLegacyDepositionId: '17585551',
        zenodoLegacyDepositionState: 'unsubmitted'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map((operation) => operation.type)).toEqual([
      'crossref_redeposit',
      'zenodo_legacy_deposition_adopt',
      'zotero_writeback'
    ]);
  });

  it('updates an unsubmitted legacy Zenodo deposition while Zotero has no uploadable attachment', () => {
    const plan = planRecordSync({
      record: record({ knownZenodoRecordId: 17585551 }),
      zoteroItem,
      zoteroChildren: [],
      state: {
        zenodoLegacyDepositionId: '17585551',
        zenodoLegacyDepositionState: 'unsubmitted'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map((operation) => operation.type)).toEqual(['crossref_redeposit', 'zenodo_draft_update', 'zotero_writeback']);
  });

  it('plans direct publication for a matching journaled Zenodo draft', () => {
    const baseline = planRecordSync({
      record: record({ knownZenodoRecordId: 0 }),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'abc'
        }
      }],
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const plan = planRecordSync({
      record: record({ knownZenodoRecordId: 0 }),
      zoteroItem,
      zoteroChildren: [{
        key: 'PDF12345',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'abc'
        }
      }],
      state: {
        zenodoLegacyDepositionId: '503004',
        zenodoLegacyDepositionState: 'unsubmitted',
        zenodoJournaledDraftOperationType: 'zenodo_create',
        zenodoJournaledDraftDepositionId: '503004',
        zenodoJournaledDraftRecordId: '503004',
        zenodoRecoveredZenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        zenodoRecoveredFileManifestHash: baseline.hashes.fileManifestHash
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations).toEqual([
      { type: 'crossref_redeposit', payloadHash: baseline.hashes.crossrefPayloadHash },
      {
        type: 'zenodo_publish_journaled_draft',
        originalOperationType: 'zenodo_create',
        depositionId: '503004',
        draftRecordId: '503004',
        payloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash
      },
      { type: 'zotero_writeback' }
    ]);
  });

  it('plans Zotero writeback when a stale managed DOI child link should be cleaned up', () => {
    const children = [{
      key: 'CURRENT1',
      version: 3,
      data: {
        itemType: 'attachment',
        linkMode: 'linked_url',
        title: '🔄Look up this DOI (once activated) [ABC12345]',
        url: 'https://doi.org/10.53832/opendeved.1205',
        tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
      }
    }, {
      key: 'STALE999',
      version: 4,
      data: {
        itemType: 'attachment',
        linkMode: 'linked_url',
        title: '🔄Look up this DOI (once activated) [OLDKEY12]',
        url: 'https://doi.org/10.53832/opendeved.9999',
        tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
      }
    }, {
      key: 'ZENODO1',
      version: 5,
      data: {
        itemType: 'attachment',
        linkMode: 'linked_url',
        title: '🔄View entry on Zenodo (deposit) [ABC12345]',
        url: 'https://zenodo.org/deposit/15043088',
        tags: [{ tag: '_r:zenodoDeposit' }, { tag: '_r:zotzen' }]
      }
    }, {
      key: 'ZENODO2',
      version: 6,
      data: {
        itemType: 'attachment',
        linkMode: 'linked_url',
        title: '🔄View entry on Zenodo (record) [ABC12345]',
        url: 'https://zenodo.org/record/15043088',
        tags: [{ tag: '_r:zenodoRecord' }, { tag: '_r:zotzen' }]
      }
    }] as const;

    const currentRecord = record({
      crossrefDoi: '10.53832/opendeved.1205',
      knownZenodoRecordId: 15043088
    });
    const currentParent = {
      ...zoteroItem,
      data: {
        ...zoteroItem.data,
        DOI: '10.53832/opendeved.1205',
        extra: [
          'DOI: 10.53832/opendeved.1205',
          'ZenodoArchiveID: 15043088',
          'ZenodoArchiveConcept: abcde-12345'
        ].join('\n'),
        url: 'https://my.educationevidence.io/lib/record/ABC12345'
      }
    };
    const baseline = planRecordSync({
      record: currentRecord,
      zoteroItem: currentParent,
      zoteroChildren: children,
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zenodoBaseUrl: 'https://zenodo.org'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: currentRecord,
      zoteroItem: currentParent,
      zoteroChildren: children,
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        previousAttachmentKeys: [],
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345'
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zenodoBaseUrl: 'https://zenodo.org'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations).toEqual([{ type: 'zotero_writeback' }]);
  });

  it('plans Zotero writeback to delete stale Zenodo child links when the Zenodo id is lost from state', () => {
    const currentRecord = record({ knownZenodoRecordId: 15043088 });
    const currentParent = {
      ...zoteroItem,
      data: {
        ...zoteroItem.data,
        extra: [
          'DOI: 10.53832/opendeved.1205',
          'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205'
        ].join('\n'),
        url: 'https://my.educationevidence.io/lib/record/ABC12345'
      }
    };
    const children: Parameters<typeof planRecordSync>[0]['zoteroChildren'] = [{
      key: 'DOI_LINK',
      version: 1,
      data: {
        itemType: 'attachment',
        linkMode: 'linked_url',
        title: '🔄Look up this DOI (once activated) [ABC12345]',
        url: 'https://doi.org/10.53832/opendeved.1205',
        tags: [{ tag: '_r:doi' }, { tag: '_r:crossref' }, { tag: '_r:zotzen' }]
      }
    }, {
      key: 'STALE_ZENODO',
      version: 2,
      data: {
        itemType: 'attachment',
        linkMode: 'linked_url',
        title: '🔄View entry on Zenodo (record) [ABC12345]',
        url: 'https://zenodo.org/record/15043088',
        tags: [{ tag: '_r:zenodoRecord' }, { tag: '_r:zotzen' }]
      }
    }];
    const baseline = planRecordSync({
      record: currentRecord,
      zoteroItem: currentParent,
      zoteroChildren: children,
      state: {
        crossrefPayloadHash: 'old-crossref',
        zenodoPayloadHash: 'old-zenodo',
        fileManifestHash: 'old-files',
        previousAttachmentKeys: []
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zenodoBaseUrl: 'https://zenodo.org'
    });
    if (baseline.status === 'skipped' || baseline.status === 'needs_attention') throw new Error('unexpected baseline plan');

    const current = planRecordSync({
      record: currentRecord,
      zoteroItem: currentParent,
      zoteroChildren: children,
      state: {
        crossrefPayloadHash: baseline.hashes.crossrefPayloadHash,
        zenodoPayloadHash: baseline.hashes.zenodoPayloadHash,
        fileManifestHash: baseline.hashes.fileManifestHash,
        previousAttachmentKeys: []
      },
      policy: { callNumberDoiPrefix: '10.53832', doiPolicy: 'dual', fallbackPublicationDate: '1970-01-01' },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zenodoBaseUrl: 'https://zenodo.org'
    });

    expect(current.status).toBe('write_required');
    if (current.status !== 'write_required') throw new Error('expected write-required plan');
    expect(current.operations).toEqual([{ type: 'zotero_writeback' }]);
  });
});

function record(overrides: Partial<Parameters<typeof planRecordSync>[0]['record']> = {}): Parameters<typeof planRecordSync>[0]['record'] {
  return {
    id: 'rec-1',
    zoteroItemKey: 'ABC12345',
    crossrefDoi: '10.53832/opendeved.1205',
    doiActivated: true,
    ...overrides
  };
}

function importedPdf(
  key: string,
  filename: string,
  md5: string,
  tags: readonly string[] = ['publishPDF']
): Parameters<typeof planRecordSync>[0]['zoteroChildren'][number] {
  return {
    key,
    version: 1,
    data: {
      itemType: 'attachment',
      linkMode: 'imported_file',
      filename,
      contentType: 'application/pdf',
      md5,
      tags: tags.map((tag) => ({ tag }))
    }
  };
}
