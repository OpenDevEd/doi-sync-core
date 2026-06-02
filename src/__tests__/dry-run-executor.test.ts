import { describe, expect, it } from 'vitest';
import { describeDryRunExecution } from '../executor/dry-run-executor.js';
import type { SyncPlan } from '../planner.js';

describe('dry-run executor description', () => {
  it('turns write-required operations into non-mutating action descriptions', () => {
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'crossref_redeposit', payloadHash: 'crossref-hash' },
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'files-hash' },
        {
          type: 'zenodo_legacy_deposition_adopt',
          depositionId: '17585551',
          payloadHash: 'legacy-hash',
          fileManifestHash: 'legacy-files-hash'
        },
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
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'files-hash'
      }
    };

    expect(describeDryRunExecution({ recordId: 'rec-1', plan })).toEqual({
      recordId: 'rec-1',
      status: 'write_required',
      actions: [
        { kind: 'would_submit_crossref', payloadHash: 'crossref-hash' },
        { kind: 'would_create_zenodo_record', payloadHash: 'zenodo-hash', fileManifestHash: 'files-hash' },
        {
          kind: 'would_adopt_legacy_zenodo_deposition',
          depositionId: '17585551',
          payloadHash: 'legacy-hash',
          fileManifestHash: 'legacy-files-hash'
        },
        { kind: 'would_settle_zotero_writeback' }
      ]
    });
  });

  it('preserves skipped and needs_attention plans without creating actions', () => {
    expect(describeDryRunExecution({
      recordId: 'rec-1',
      plan: { status: 'skipped', reason: 'DOI_NOT_ACTIVE' }
    })).toEqual({
      recordId: 'rec-1',
      status: 'skipped',
      reason: 'DOI_NOT_ACTIVE',
      actions: []
    });
  });
});
