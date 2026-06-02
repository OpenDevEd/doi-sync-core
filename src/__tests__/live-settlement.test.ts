import { describe, expect, it } from 'vitest';
import { settleLiveSyncPlan } from '../live-settlement.js';
import type { SyncPlan } from '../planner.js';

const plan: SyncPlan = {
  status: 'write_required',
  operations: [{ type: 'zenodo_new_version', payloadHash: 'zenodo-hash-v2', fileManifestHash: 'files-v2', removedAttachmentKeys: [] }],
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
      supported: true
    }],
    unsupported: []
  },
  hashes: {
    crossrefPayloadHash: 'crossref-hash-v2',
    zenodoPayloadHash: 'zenodo-hash-v2',
    fileManifestHash: 'files-v2'
  }
};

describe('settleLiveSyncPlan', () => {
  it('settles provider results and exposes the Zenodo file-state record id', () => {
    const actualZenodoPayload = {
      pids: {
        doi: {
          identifier: '10.53832/opendeved.1205',
          provider: 'external'
        }
      },
      metadata: {
        title: 'Evidence report'
      }
    } as const;
    const result = settleLiveSyncPlan({
      plan,
      observedAt: new Date('2026-05-21T00:00:00.000Z'),
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345',
      operationResults: [{
        type: 'zenodo_new_version',
        status: 'succeeded',
        zenodo: {
          latestRecordId: '502440',
          parentId: '502439',
          versionDoi: '10.53832/opendeved.1205'
        },
        zenodoPayloadSnapshot: actualZenodoPayload
      }]
    });

    expect(result.zenodoFileRecordId).toBe('502440');
    expect(result.statePatch).toMatchObject({
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      zenodoVersionDoi: '10.53832/opendeved.1205',
      zenodoPayloadHash: 'zenodo-hash-v2',
      fileManifestHash: 'files-v2'
    });
    expect(result.payloadSnapshots?.zenodoPayload).toEqual(actualZenodoPayload);
    expect(result.statePatch.zenodoPayloadSnapshot).toEqual(actualZenodoPayload);
  });

  it('settles external-policy metadata updates with preserved Zenodo/DataCite DOI snapshots', () => {
    const metadataUpdatePlan: SyncPlan = {
      ...plan,
      operations: [{ type: 'zenodo_metadata_update', payloadHash: 'zenodo-hash-v2' }],
      fileManifest: { files: [], unsupported: [] },
      hashes: {
        crossrefPayloadHash: 'crossref-hash-v2',
        zenodoPayloadHash: 'zenodo-hash-v2',
        fileManifestHash: 'files-existing'
      }
    };
    const result = settleLiveSyncPlan({
      plan: metadataUpdatePlan,
      state: {
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      },
      observedAt: new Date('2026-05-21T00:00:00.000Z'),
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345',
      operationResults: [{
        type: 'zenodo_metadata_update',
        status: 'succeeded',
        zenodo: {
          latestRecordId: '20342806',
          parentId: '20342805',
          conceptDoi: '10.5281/zenodo.20342805',
          versionDoi: '10.5281/zenodo.20342806'
        }
      }]
    });

    expect(JSON.stringify(result.statePatch.zenodoPayloadSnapshot)).not.toContain('10.53832/opendeved.1205');
    expect(result.statePatch).toMatchObject({
      zenodoLatestRecordId: '20342806',
      zenodoParentId: '20342805',
      zenodoConceptDoi: '10.5281/zenodo.20342805',
      zenodoVersionDoi: '10.5281/zenodo.20342806',
      zenodoPayloadHash: 'zenodo-hash-v2'
    });
  });

  it('persists a recovered file hash during metadata-only settlement', () => {
    const metadataUpdatePlan: SyncPlan = {
      ...plan,
      operations: [{ type: 'zenodo_metadata_update', payloadHash: 'zenodo-hash-v2' }]
    };
    const result = settleLiveSyncPlan({
      plan: metadataUpdatePlan,
      state: {
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        zenodoPayloadHash: 'zenodo-hash-v1',
        fileManifestHash: 'files-v2'
      },
      observedAt: new Date('2026-05-21T00:00:00.000Z'),
      doiPolicy: 'dual',
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345',
      operationResults: [{
        type: 'zenodo_metadata_update',
        status: 'succeeded',
        zenodo: {
          latestRecordId: '502440',
          parentId: '502439',
          versionDoi: '10.5281/zenodo.502440'
        }
      }]
    });

    expect(result.statePatch).toMatchObject({
      zenodoPayloadHash: 'zenodo-hash-v2',
      fileManifestHash: 'files-v2'
    });
    expect(result.statePatch.fileManifestSnapshot).toBeDefined();
  });

  it('backfills current recovered Zenodo state without requiring another provider write', () => {
    const result = settleLiveSyncPlan({
      plan: { ...plan, status: 'noop', operations: [] },
      state: {
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        zenodoRecoveredFromZoteroWriteback: true,
        zenodoPayloadHash: 'zenodo-hash-v2',
        fileManifestHash: 'files-v2'
      },
      observedAt: new Date('2026-05-21T00:00:00.000Z'),
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345',
      operationResults: []
    });

    expect(result.zenodoFileRecordId).toBe('502440');
    expect(result.statePatch).toMatchObject({
      zenodoLatestRecordId: '502440',
      zenodoParentId: '502439',
      zenodoPayloadHash: 'zenodo-hash-v2',
      fileManifestHash: 'files-v2'
    });
  });

  it('does not mark Zotero-writeback recovery current when hashes are unknown', () => {
    const result = settleLiveSyncPlan({
      plan: { ...plan, status: 'noop', operations: [] },
      state: {
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        zenodoRecoveredFromZoteroWriteback: true
      },
      observedAt: new Date('2026-05-21T00:00:00.000Z'),
      doiPolicy: 'external-crossref',
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345',
      operationResults: []
    });

    expect(result.zenodoFileRecordId).toBeUndefined();
    expect(result.statePatch).not.toHaveProperty('zenodoPayloadHash');
    expect(result.statePatch).not.toHaveProperty('fileManifestHash');
  });
});
