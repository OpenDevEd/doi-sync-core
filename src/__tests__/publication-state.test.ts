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
});
