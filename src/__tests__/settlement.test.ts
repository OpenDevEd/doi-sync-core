import { describe, expect, it } from 'vitest';
import { settleSyncState } from '../settlement.js';
import type { SyncPlan } from '../planner.js';

describe('sync state settlement', () => {
  it('does not advance provider hashes for a needs_attention record', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'needs_attention',
      reason: 'DOI_DRIFT',
      operations: [],
      drift: {
        drifted: true,
        canonicalDoi: '10.53832/opendeved.1205',
        conflicts: [{ source: 'zotero.DOI', doi: '10.53832/opendeved.9999' }]
      }
    };

    expect(settleSyncState({ plan, observedAt })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        driftDetectedAt: observedAt,
        lastFailureClass: 'DOI_DRIFT',
        lastFailureSummary: 'Record is unsafe to sync: DOI_DRIFT',
        consecutiveFailureCount: 1
      }
    });
  });

  it('advances only the Crossref hash when Crossref succeeds and Zenodo has no attachment-backed operation', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [
        { type: 'crossref_redeposit', status: 'succeeded' }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        crossrefPayloadHash: 'crossref-new',
        crossrefPendingPayloadHash: null,
        crossrefPendingPayloadSnapshot: null,
        crossrefPendingBatchId: null,
        crossrefPendingFilename: null,
        crossrefPendingSubmittedAt: null,
        crossrefPendingReason: null,
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('stores successful provider payload snapshots with the matching hashes', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const payloadSnapshots = {
      crossrefPayload: {
        metadata: {
          title: 'Evidence report'
        },
        resourceUrl: 'https://example.org/lib/ABC12345'
      },
      zenodoPayload: {
        metadata: {
          title: 'Evidence report'
        }
      },
      fileManifest: {
        files: [{
          zoteroAttachmentKey: 'PDF12345',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          zoteroMd5: 'abc123',
          zoteroMtime: null
        }]
      }
    } as const;
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' },
        { type: 'zenodo_new_version', payloadHash: 'zenodo-new', fileManifestHash: 'files-new', removedAttachmentKeys: [] }
      ],
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
          zoteroVersion: 4,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'abc123',
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

    expect(settleSyncState({
      plan,
      observedAt,
      payloadSnapshots,
      operationResults: [
        { type: 'crossref_redeposit', status: 'succeeded' },
        {
          type: 'zenodo_new_version',
          status: 'succeeded',
          zenodo: {
            latestRecordId: '502440',
            parentId: '502439'
          }
        }
      ]
    }).statePatch).toMatchObject({
      crossrefPayloadHash: 'crossref-new',
      crossrefPayloadSnapshot: payloadSnapshots.crossrefPayload,
      zenodoPayloadHash: 'zenodo-new',
      zenodoPayloadSnapshot: payloadSnapshots.zenodoPayload,
      fileManifestHash: 'files-new',
      fileManifestSnapshot: payloadSnapshots.fileManifest
    });
  });

  it('advances metadata + Crossref but never the file hash for an attention-flagged file conflict record', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      attention: { reason: 'ZOTERO_FILE_CONFLICT' },
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' },
        { type: 'zenodo_metadata_update', payloadHash: 'zenodo-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report corrected',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: { files: [], unsupported: [] },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-changed-but-blocked'
      }
    };

    const statePatch = settleSyncState({
      plan,
      observedAt,
      operationResults: [
        { type: 'crossref_redeposit', status: 'succeeded' },
        {
          type: 'zenodo_metadata_update',
          status: 'succeeded',
          zenodo: {
            latestRecordId: '504607',
            parentId: '504606',
            versionDoi: '10.53832/opendeved.1205'
          }
        }
      ]
    }).statePatch;

    expect(statePatch.crossrefPayloadHash).toBe('crossref-new');
    expect(statePatch.zenodoPayloadHash).toBe('zenodo-new');
    expect(statePatch.zenodoLatestRecordId).toBe('504607');
    expect(statePatch.zenodoParentId).toBe('504606');
    expect(statePatch.zenodoVersionDoi).toBe('10.53832/opendeved.1205');
    // The blocked file change must remain unsettled so it re-flags on the next run.
    expect(statePatch.fileManifestHash).toBeUndefined();
  });

  it('preserves the failure breadcrumb when a pending run left a sibling operation with no result', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' },
        { type: 'zenodo_metadata_update', payloadHash: 'zenodo-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: { files: [], unsupported: [] },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-new'
      }
    };

    const statePatch = settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 2,
      // Crossref is pending; the Zenodo metadata update produced NO result (an incomplete run).
      operationResults: [
        { type: 'crossref_redeposit', status: 'pending', pendingClass: 'CROSSREF_PENDING', pendingSummary: 'still indexing' }
      ]
    }).statePatch;

    // The run did not finish, so backoff/failure state must be preserved, not reset to 0/null.
    expect(statePatch.consecutiveFailureCount).toBeUndefined();
    expect(statePatch.lastFailureClass).toBeUndefined();
  });

  it('does not advance the Crossref hash when Crossref deposit fails', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 2,
      operationResults: [
        {
          type: 'crossref_redeposit',
          status: 'failed',
          failureClass: 'CROSSREF_VALIDATION',
          failureSummary: 'Crossref rejected the XML'
        }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        driftDetectedAt: null,
        lastFailureClass: 'CROSSREF_VALIDATION',
        lastFailureSummary: 'Crossref rejected the XML',
        consecutiveFailureCount: 3
      }
    });
  });

  it('clears pending Crossref submission state when a redeposit fails after upload journaling', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 2,
      operationResults: [
        {
          type: 'crossref_redeposit',
          status: 'failed',
          failureClass: 'CROSSREF_FAILED',
          failureSummary: 'Crossref submission doi-sync.xml failed'
        }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        crossrefPendingPayloadHash: null,
        crossrefPendingPayloadSnapshot: null,
        crossrefPendingBatchId: null,
        crossrefPendingFilename: null,
        crossrefPendingSubmittedAt: null,
        crossrefPendingReason: null,
        driftDetectedAt: null,
        lastFailureClass: 'CROSSREF_FAILED',
        lastFailureSummary: 'Crossref submission doi-sync.xml failed',
        consecutiveFailureCount: 3
      }
    });
  });

  it('stores accepted Crossref deposits as pending without counting them as failures', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const payloadSnapshots = {
      crossrefPayload: {
        metadata: { title: 'Evidence report' },
        resourceUrl: 'https://example.org/lib/ABC12345'
      },
      zenodoPayload: { metadata: { title: 'Evidence report' } },
      fileManifest: { files: [] }
    } as const;
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 2,
      payloadSnapshots,
      operationResults: [
        {
          type: 'crossref_redeposit',
          status: 'pending',
          pendingClass: 'CROSSREF_PENDING',
          pendingSummary: 'Crossref XML API metadata has not caught up: abstract',
          crossref: {
            batchId: 'batch-1',
            filename: 'doi-sync-batch-1.xml',
            submittedAt: observedAt
          }
        }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        crossrefPendingPayloadHash: 'crossref-new',
        crossrefPendingPayloadSnapshot: payloadSnapshots.crossrefPayload,
        crossrefPendingBatchId: 'batch-1',
        crossrefPendingFilename: 'doi-sync-batch-1.xml',
        crossrefPendingSubmittedAt: observedAt,
        crossrefPendingReason: 'Crossref XML API metadata has not caught up: abstract',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('settles a pending Crossref deposit after XML verification catches up', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const payloadSnapshots = {
      crossrefPayload: {
        metadata: { title: 'Evidence report' },
        resourceUrl: 'https://example.org/lib/ABC12345'
      },
      zenodoPayload: { metadata: { title: 'Evidence report' } },
      fileManifest: { files: [] }
    } as const;
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_verify_pending', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      payloadSnapshots,
      operationResults: [
        { type: 'crossref_verify_pending', status: 'succeeded' }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        crossrefPayloadHash: 'crossref-new',
        crossrefPayloadSnapshot: payloadSnapshots.crossrefPayload,
        crossrefPendingPayloadHash: null,
        crossrefPendingPayloadSnapshot: null,
        crossrefPendingBatchId: null,
        crossrefPendingFilename: null,
        crossrefPendingSubmittedAt: null,
        crossrefPendingReason: null,
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('preserves original Crossref pending submission fields while verification is still pending', () => {
    const originalSubmittedAt = new Date('2026-05-20T00:00:00.000Z');
    const observedAt = new Date('2026-05-21T00:00:00.000Z');
    const payloadSnapshots = {
      crossrefPayload: {
        metadata: { title: 'Evidence report' },
        resourceUrl: 'https://example.org/lib/ABC12345'
      },
      zenodoPayload: { metadata: { title: 'Evidence report' } },
      fileManifest: { files: [] }
    } as const;
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_verify_pending', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      previousCrossrefPendingBatchId: 'batch-abc',
      previousCrossrefPendingFilename: 'batch-abc.xml',
      previousCrossrefPendingSubmittedAt: originalSubmittedAt,
      payloadSnapshots,
      operationResults: [{
        type: 'crossref_verify_pending',
        status: 'pending',
        pendingClass: 'CROSSREF_PENDING',
        pendingSummary: 'Crossref XML API metadata has not caught up'
      }]
    }).statePatch).toMatchObject({
      crossrefPendingBatchId: 'batch-abc',
      crossrefPendingFilename: 'batch-abc.xml',
      crossrefPendingSubmittedAt: originalSubmittedAt
    });
  });

  it('escalates Crossref pending verification after the configured max age', () => {
    const originalSubmittedAt = new Date('2026-05-20T00:00:00.000Z');
    const observedAt = new Date('2026-05-20T03:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_verify_pending', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 2,
      previousCrossrefPendingBatchId: 'batch-abc',
      previousCrossrefPendingFilename: 'batch-abc.xml',
      previousCrossrefPendingSubmittedAt: originalSubmittedAt,
      crossrefPendingMaxAgeMs: 2 * 60 * 60 * 1000,
      operationResults: [{
        type: 'crossref_verify_pending',
        status: 'pending',
        pendingClass: 'CROSSREF_PENDING',
        pendingSummary: 'Crossref XML API metadata has not caught up'
      }]
    }).statePatch).toMatchObject({
      crossrefPendingPayloadHash: 'crossref-new',
      crossrefPendingBatchId: 'batch-abc',
      crossrefPendingFilename: 'batch-abc.xml',
      crossrefPendingSubmittedAt: originalSubmittedAt,
      crossrefPendingReason: 'Crossref XML API metadata has not caught up',
      lastFailureClass: 'CROSSREF_PENDING_STALE',
      lastFailureSummary: 'Crossref pending verification exceeded the configured max age: Crossref XML API metadata has not caught up',
      consecutiveFailureCount: 3
    });
  });

  it('escalates Crossref pending verification when submission time is missing', () => {
    const observedAt = new Date('2026-05-20T03:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_verify_pending', payloadHash: 'crossref-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-new',
        zenodoPayloadHash: 'zenodo-unsynced',
        fileManifestHash: 'empty-files-unsynced'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 1,
      crossrefPendingMaxAgeMs: 2 * 60 * 60 * 1000,
      operationResults: [{
        type: 'crossref_verify_pending',
        status: 'pending',
        pendingClass: 'CROSSREF_PENDING',
        pendingSummary: 'Crossref XML API metadata has not caught up'
      }]
    }).statePatch).toMatchObject({
      crossrefPendingPayloadHash: 'crossref-new',
      crossrefPendingSubmittedAt: null,
      crossrefPendingReason: 'Crossref XML API metadata has not caught up',
      lastFailureClass: 'CROSSREF_PENDING_MISSING_SUBMITTED_AT',
      lastFailureSummary: 'Crossref pending verification cannot age out because submittedAt is missing',
      consecutiveFailureCount: 2
    });
  });

  it('advances Zenodo metadata and file hashes only after Zenodo create succeeds', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-new', fileManifestHash: 'files-new' },
        { type: 'zotero_writeback' }
      ],
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
          zoteroVersion: 4,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'abc123',
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

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [
        {
          type: 'zenodo_create',
          status: 'succeeded',
          zenodo: {
            latestRecordId: '502440',
            parentId: '502439',
            conceptDoi: '10.5072/zenodo.502439',
            versionDoi: '10.5072/zenodo.502440'
          }
        },
        { type: 'zotero_writeback', status: 'succeeded' }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-new',
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        zenodoConceptDoi: '10.5072/zenodo.502439',
        zenodoVersionDoi: '10.5072/zenodo.502440',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('settles DOI-collision adoption with Zenodo identifiers without pretending payload and files were verified', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-new', fileManifestHash: 'files-new' }
      ],
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
          zoteroVersion: 4,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'abc123',
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

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [{
        type: 'zenodo_create',
        status: 'succeeded',
        zenodoAdoptionOnly: true,
        zenodo: {
          latestRecordId: '505547',
          parentId: '505546',
          versionDoi: '10.53832/opendeved.1205'
        }
      }]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        zenodoLatestRecordId: '505547',
        zenodoParentId: '505546',
        zenodoVersionDoi: '10.53832/opendeved.1205',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('settles journaled draft DOI-collision adoption without pretending payload and files were verified', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        {
          type: 'zenodo_publish_journaled_draft',
          originalOperationType: 'zenodo_create',
          depositionId: '505638',
          draftRecordId: '505638',
          payloadHash: 'zenodo-new',
          fileManifestHash: 'files-new'
        }
      ],
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
          zoteroVersion: 4,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'abc123',
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

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [{
        type: 'zenodo_publish_journaled_draft',
        status: 'succeeded',
        zenodoAdoptionOnly: true,
        zenodo: {
          latestRecordId: '504607',
          parentId: '504606',
          versionDoi: '10.53832/opendeved.1205'
        }
      }]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        zenodoLatestRecordId: '504607',
        zenodoParentId: '504606',
        zenodoVersionDoi: '10.53832/opendeved.1205',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('settles metadata-update DOI-collision adoption without pretending metadata was verified', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_metadata_update', payloadHash: 'zenodo-new' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
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

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [{
        type: 'zenodo_metadata_update',
        status: 'succeeded',
        zenodoAdoptionOnly: true,
        zenodo: {
          latestRecordId: '504607',
          parentId: '504606',
          versionDoi: '10.53832/opendeved.1205'
        }
      }]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        zenodoLatestRecordId: '504607',
        zenodoParentId: '504606',
        zenodoVersionDoi: '10.53832/opendeved.1205',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('treats deliberately skipped Zotero writeback as complete without blocking provider settlement', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-new', fileManifestHash: 'files-new' },
        { type: 'zotero_writeback' }
      ],
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
          zoteroVersion: 4,
          filename: 'report.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'abc123',
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

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [
        {
          type: 'zenodo_create',
          status: 'succeeded',
          zenodo: {
            latestRecordId: '502440',
            parentId: '502439',
            conceptDoi: '10.5072/zenodo.502439',
            versionDoi: '10.5072/zenodo.502440'
          }
        },
        { type: 'zotero_writeback', status: 'skipped', reason: 'ZOTERO_WRITEBACK_DISABLED' }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        zenodoPayloadHash: 'zenodo-new',
        fileManifestHash: 'files-new',
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439',
        zenodoConceptDoi: '10.5072/zenodo.502439',
        zenodoVersionDoi: '10.5072/zenodo.502440',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('advances only the Zenodo metadata hash after a published metadata update succeeds', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_metadata_update', payloadHash: 'zenodo-metadata-new' },
        { type: 'zotero_writeback' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report corrected',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-existing',
        zenodoPayloadHash: 'zenodo-metadata-new',
        fileManifestHash: 'files-existing'
      }
    };

    expect(settleSyncState({
      plan,
      observedAt,
      operationResults: [
        { type: 'zenodo_metadata_update', status: 'succeeded' },
        { type: 'zotero_writeback', status: 'succeeded' }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        zenodoPayloadHash: 'zenodo-metadata-new',
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });

  it('keeps failed Zenodo hashes pending even when Crossref succeeds in the same run', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-new' },
        { type: 'zenodo_new_version', payloadHash: 'zenodo-new', fileManifestHash: 'files-new', removedAttachmentKeys: ['OLDPDF12'] }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report corrected',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [{
          zoteroAttachmentKey: 'NEWPDF12',
          zoteroVersion: 2,
          filename: 'report-v2.pdf',
          contentType: 'application/pdf',
          linkMode: 'imported_file',
          source: 'zotero',
          zoteroMd5: 'new-md5',
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

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 1,
      operationResults: [
        { type: 'crossref_redeposit', status: 'succeeded' },
        {
          type: 'zenodo_new_version',
          status: 'failed',
          failureClass: 'ZENODO_VALIDATION',
          failureSummary: 'Zenodo rejected the draft'
        }
      ]
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        crossrefPayloadHash: 'crossref-new',
        crossrefPendingPayloadHash: null,
        crossrefPendingPayloadSnapshot: null,
        crossrefPendingBatchId: null,
        crossrefPendingFilename: null,
        crossrefPendingSubmittedAt: null,
        crossrefPendingReason: null,
        driftDetectedAt: null,
        lastFailureClass: 'ZENODO_VALIDATION',
        lastFailureSummary: 'Zenodo rejected the draft',
        consecutiveFailureCount: 2
      }
    });
  });

  it('does not clear previous failure state when a planned operation has no result', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-new', fileManifestHash: 'files-new' }
      ],
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
          zoteroVersion: 4,
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

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 4,
      operationResults: []
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt
      }
    });
  });

  it('clears stale failure markers on a clean noop without advancing provider hashes', () => {
    const observedAt = new Date('2026-05-20T00:00:00.000Z');
    const plan: SyncPlan = {
      status: 'noop',
      operations: [],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
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

    expect(settleSyncState({
      plan,
      observedAt,
      previousConsecutiveFailureCount: 2
    })).toEqual({
      statePatch: {
        zoteroLastSeenAt: observedAt,
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    });
  });
});
