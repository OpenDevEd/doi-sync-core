import { describe, expect, it } from 'vitest';
import { parseProviderSyncState } from '../publication/state.js';

describe('provider sync state storage parser', () => {
  it('validates all durable state and restores pending dates', () => {
    const state = parseProviderSyncState({
      crossref: {
        environment: 'test',
        lastSuccess: {
          payloadHash: 'crossref-settled',
          payloadSnapshot: { title: 'Evidence report' }
        },
        pending: {
          stage: 'relation_clear',
          payloadHash: 'crossref-pending',
          submittedAt: '2026-08-12T10:00:00.000Z'
        }
      },
      zenodo: {
        environment: 'sandbox',
        identifierPolicy: 'mint-zenodo',
        lastSuccess: {
          payloadHash: 'zenodo-settled',
          fileManifestHash: 'files-settled',
          fileManifestSnapshot: { files: [] }
        },
        identifiers: {
          latestRecordId: '600001',
          parentId: '600000',
          versionDoi: '10.5072/zenodo.600001',
          conceptDoi: '10.5072/zenodo.600000'
        },
        orphanDraftCleanup: { depositionId: '502440' },
        journal: {
          operationType: 'zenodo_new_version',
          depositionId: '600002',
          draftRecordId: '600002',
          parentId: '600000',
          payloadHash: 'zenodo-pending',
          fileManifestHash: 'files-pending',
          status: 'ready_to_publish'
        }
      },
      failure: {
        provider: 'zenodo',
        failureClass: 'ZENODO_PENDING',
        summary: 'Waiting for Zenodo',
        consecutiveCount: 1
      }
    });

    expect(state.crossref?.pending?.submittedAt).toEqual(new Date('2026-08-12T10:00:00.000Z'));
    expect(state.zenodo?.journal?.operationType).toBe('zenodo_new_version');
  });

  it('rejects unknown durable fields instead of silently deleting them', () => {
    expect(() => parseProviderSyncState({
      crossref: {
        environment: 'test',
        futureField: 'not-yet-supported'
      }
    })).toThrow();
  });

  it('requires an exact approval on a ready file-correction journal', () => {
    expect(() => parseProviderSyncState({
      zenodo: {
        environment: 'sandbox', identifierPolicy: 'reuse-crossref',
        journal: {
          operationType: 'zenodo_file_update', depositionId: '42', draftRecordId: '42',
          payloadHash: 'payload', fileManifestHash: 'files', status: 'ready_to_publish'
        }
      }
    })).toThrow('Zenodo file correction journal requires approval');

    const state = parseProviderSyncState({
      zenodo: {
        environment: 'sandbox', identifierPolicy: 'reuse-crossref',
        firstPublishedAt: '2026-04-20T00:00:00.000Z',
        journal: {
          operationType: 'zenodo_file_update', depositionId: '42', draftRecordId: '42',
          payloadHash: 'payload', fileManifestHash: 'files', status: 'ready_to_publish',
          fileCorrectionApproval: {
            id: 'approval-1', kind: 'minor_correction', recordKey: 'REPORT01',
            doi: '10.53832/opendeved.1205', fileManifestHash: 'files',
            approvedAt: '2026-05-01T00:00:00.000Z'
          }
        }
      }
    });

    expect(state.zenodo?.firstPublishedAt).toEqual(new Date('2026-04-20T00:00:00.000Z'));
    expect(state.zenodo?.journal?.fileCorrectionApproval?.approvedAt).toEqual(
      new Date('2026-05-01T00:00:00.000Z')
    );
  });

  it('rejects duplicate consumed file-correction approval IDs', () => {
    expect(() => parseProviderSyncState({
      zenodo: {
        environment: 'sandbox', identifierPolicy: 'reuse-crossref',
        consumedFileCorrectionApprovalIds: ['approval-1', 'approval-1']
      }
    })).toThrow('Consumed Zenodo file correction approval IDs must be unique');
  });

  it.each(['crossref', 'zenodo', 'source', 'worker'] as const)(
    'accepts %s as a durable failure source',
    (provider) => {
      expect(parseProviderSyncState({
        failure: {
          provider,
          failureClass: 'SYNC_FAILED',
          summary: 'The record could not be synced',
          consecutiveCount: 1
        }
      }).failure?.provider).toBe(provider);
    }
  );
});
