import { describe, expect, it } from 'vitest';
import {
  mergeZenodoVerificationIntoState,
  readZoteroWritebackZenodoHint,
  recoverZenodoFileStateFromSnapshot,
  recoverZenodoStateFromPublishJournalVerification,
  recoverZenodoStateFromZoteroWritebackVerification,
  zenodoPublishJournalVerificationRecordIds
} from '../zenodo/state-hints.js';
import { sha256Hex } from '../hash.js';
import { buildFileManifestSnapshot } from '../snapshots.js';
import type { FileManifest } from '../files.js';
import type { ZenodoPublishJournalEntry } from '../zenodo/journal.js';
import type { ZenodoRecordSnapshot, ZenodoVerificationResult } from '../zenodo/records.js';

const published: ZenodoVerificationResult = {
  kind: 'published_record',
  identifiers: {
    latestRecordId: '502440',
    parentId: '502439',
    conceptDoi: '10.5072/zenodo.502439',
    versionDoi: '10.5072/zenodo.502440',
    links: {}
  }
};

const journal: ZenodoPublishJournalEntry = {
  id: 'journal-1',
  recordId: 'rec-1',
  operationType: 'zenodo_create',
  zenodoPayloadHash: 'zenodo-hash',
  fileManifestHash: 'file-hash',
  depositionId: '502440',
  draftRecordId: '502440',
  parentId: '502439',
  status: 'ready_to_publish'
};

const matchingFileManifest: FileManifest = {
  files: [{
    zoteroAttachmentKey: 'PDF12345',
    zoteroVersion: 7,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    linkMode: 'imported_file',
    source: 'zotero',
    zoteroMd5: '405563f26c8e68ad6d715f0f811942ce',
    supported: true
  }],
  unsupported: []
};

const matchingRecordSnapshot: ZenodoRecordSnapshot = {
  identifiers: published.identifiers,
  metadata: {},
  files: [{
    key: 'report.pdf',
    checksum: 'md5:405563f26c8e68ad6d715f0f811942ce',
    contentType: 'application/pdf'
  }]
};

describe('Zenodo state hints', () => {
  it('recovers published identifiers from managed Zotero Extra writeback', () => {
    const hint = readZoteroWritebackZenodoHint('ZenodoArchiveID: 502440\nZenodoArchiveConcept: 502439');

    expect(hint).toEqual({ latestRecordId: '502440', parentId: '502439' });
    expect(recoverZenodoStateFromZoteroWritebackVerification({
      hint: hint!,
      verified: published
    })).toMatchObject({
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      zenodoRecoveredFromZoteroWriteback: true
    });
  });

  it('maps journal verification into current published or unpublished state', () => {
    expect(zenodoPublishJournalVerificationRecordIds(journal)).toEqual(['502440']);
    expect(recoverZenodoStateFromPublishJournalVerification({
      journal,
      verified: published
    })).toMatchObject({
      zenodoLatestRecordId: '502440',
      zenodoRecoveredFromPrePublishJournal: true,
      zenodoRecoveredZenodoPayloadHash: 'zenodo-hash',
      zenodoRecoveredFileManifestHash: 'file-hash'
    });

    expect(recoverZenodoStateFromPublishJournalVerification({
      journal,
      verified: {
        kind: 'legacy_unsubmitted_deposition',
        deposition: {
          depositionId: '502440',
          recordId: '502440',
          submitted: false,
          state: 'unsubmitted',
          fileCount: 0,
          links: {}
        }
      }
    })).toMatchObject({
      zenodoLegacyDepositionId: '502440',
      zenodoJournaledDraftDepositionId: '502440',
      zenodoRecoveredZenodoPayloadHash: 'zenodo-hash'
    });
  });

  it('does not treat a preparing current draft file-update journal as published just because the old record is readable', () => {
    expect(recoverZenodoStateFromPublishJournalVerification({
      journal: {
        ...journal,
        operationType: 'zenodo_new_version',
        status: 'preparing',
        depositionId: '502440',
        draftRecordId: '502440'
      },
      verified: published
    })).toBeUndefined();
  });

  it('recovers identifiers but not journal hashes when a journal was closed by adopting a different DOI record', () => {
    expect(recoverZenodoStateFromPublishJournalVerification({
      journal: {
        ...journal,
        status: 'published',
        publishedRecordId: '504607'
      },
      verified: {
        kind: 'published_record',
        identifiers: {
          latestRecordId: '504607',
          parentId: '504606',
          versionDoi: '10.53832/opendeved.1205',
          links: {}
        }
      }
    })).toEqual({
      zenodoLatestRecordId: '504607',
      zenodoParentId: '504606',
      zenodoVersionDoi: '10.53832/opendeved.1205',
      zenodoRecoveredFromPrePublishJournal: true
    });
  });

  it('merges direct MEE Zenodo record verification into sync state', () => {
    expect(mergeZenodoVerificationIntoState({ verified: published })).toMatchObject({
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      zenodoConceptDoi: '10.5072/zenodo.502439',
      zenodoVersionDoi: '10.5072/zenodo.502440'
    });
  });

  it('recovers missing file state when Zenodo checksums already match the Zotero manifest', () => {
    const fileManifestSnapshot = buildFileManifestSnapshot(matchingFileManifest);

    expect(recoverZenodoFileStateFromSnapshot({
      state: {
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        fileManifestHash: null
      },
      fileManifest: matchingFileManifest,
      snapshot: matchingRecordSnapshot
    })).toMatchObject({
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      fileManifestHash: sha256Hex(fileManifestSnapshot),
      fileManifestSnapshot
    });
  });

  it('keeps the worker DB file hash authoritative when it already exists', () => {
    const state = {
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      fileManifestHash: 'db-file-hash'
    };

    expect(recoverZenodoFileStateFromSnapshot({
      state,
      fileManifest: matchingFileManifest,
      snapshot: {
        ...matchingRecordSnapshot,
        files: [{ key: 'report.pdf', checksum: 'md5:ffffffffffffffffffffffffffffffff' }]
      }
    })).toEqual(state);
  });

  it('does not recover file state when Zenodo checksums differ from Zotero', () => {
    expect(recoverZenodoFileStateFromSnapshot({
      state: {
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        fileManifestHash: null
      },
      fileManifest: matchingFileManifest,
      snapshot: {
        ...matchingRecordSnapshot,
        files: [{ key: 'report.pdf', checksum: 'md5:ffffffffffffffffffffffffffffffff' }]
      }
    })).toEqual({
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      fileManifestHash: null
    });
  });
});
