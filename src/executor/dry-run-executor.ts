import type { PublicationSyncOperation, PublicationSyncPlan } from '../planner.js';
import type { ZenodoPublishJournalOperationType } from '../zenodo/journal.js';

export type DryRunAction =
  | {
      readonly kind: 'would_submit_crossref';
      readonly payloadHash: string;
      readonly clearsRelations?: true;
    }
  | { readonly kind: 'would_verify_pending_crossref'; readonly payloadHash: string }
  | {
      readonly kind: 'would_create_zenodo_record';
      readonly payloadHash: string;
      readonly fileManifestHash: string;
    }
  | { readonly kind: 'would_update_zenodo_metadata'; readonly payloadHash: string }
  | {
      readonly kind: 'would_update_zenodo_files';
      readonly payloadHash: string;
      readonly fileManifestHash: string;
      readonly removedFileKeys: readonly string[];
    }
  | {
      readonly kind: 'would_create_zenodo_version';
      readonly payloadHash: string;
      readonly fileManifestHash: string;
      readonly removedFileKeys: readonly string[];
    }
  | {
      readonly kind: 'would_discard_incomplete_zenodo_draft';
      readonly depositionId: string;
      readonly draftRecordId: string;
      readonly originalOperationType: ZenodoPublishJournalOperationType;
    }
  | {
      readonly kind: 'would_delete_orphaned_zenodo_draft';
      readonly depositionId: string;
    }
  | {
      readonly kind: 'would_publish_journaled_zenodo_draft';
      readonly depositionId: string;
      readonly draftRecordId: string;
      readonly originalOperationType: ZenodoPublishJournalOperationType;
      readonly payloadHash: string;
      readonly fileManifestHash?: string;
    };

export interface DryRunExecutionDescription {
  readonly recordKey: string;
  readonly status: PublicationSyncPlan['status'];
  readonly reason?: string;
  readonly waitingForFile?: boolean;
  readonly actions: readonly DryRunAction[];
}

export function describeDryRun(plan: PublicationSyncPlan): DryRunExecutionDescription {
  const recordKey = 'record' in plan ? plan.record.recordKey : '';
  if (plan.status === 'skipped' || plan.status === 'needs_attention') {
    return {
      recordKey,
      status: plan.status,
      reason: plan.reason,
      actions: []
    };
  }
  if (plan.status === 'waiting_for_file') {
    return {
      recordKey,
      status: plan.status,
      waitingForFile: true,
      actions: []
    };
  }
  return {
    recordKey,
    status: plan.status,
    ...(plan.waitingForFile ? { waitingForFile: true } : {}),
    actions: plan.operations.map(describeOperation)
  };
}

function describeOperation(operation: PublicationSyncOperation): DryRunAction {
  switch (operation.type) {
    case 'crossref_redeposit':
      return {
        kind: 'would_submit_crossref',
        payloadHash: operation.payloadHash,
        ...(operation.clearRelations ? { clearsRelations: true } : {})
      };
    case 'crossref_verify_pending':
      return { kind: 'would_verify_pending_crossref', payloadHash: operation.payloadHash };
    case 'zenodo_create':
      return {
        kind: 'would_create_zenodo_record',
        payloadHash: operation.payloadHash,
        fileManifestHash: operation.fileManifestHash
      };
    case 'zenodo_metadata_update':
      return { kind: 'would_update_zenodo_metadata', payloadHash: operation.payloadHash };
    case 'zenodo_file_update':
      return {
        kind: 'would_update_zenodo_files',
        payloadHash: operation.payloadHash,
        fileManifestHash: operation.fileManifestHash,
        removedFileKeys: operation.removedFileKeys
      };
    case 'zenodo_new_version':
      return {
        kind: 'would_create_zenodo_version',
        payloadHash: operation.payloadHash,
        fileManifestHash: operation.fileManifestHash,
        removedFileKeys: operation.removedFileKeys
      };
    case 'zenodo_discard_preparing_draft':
      return {
        kind: 'would_discard_incomplete_zenodo_draft',
        depositionId: operation.depositionId,
        draftRecordId: operation.draftRecordId,
        originalOperationType: operation.originalOperationType
      };
    case 'zenodo_cleanup_orphan_draft':
      return {
        kind: 'would_delete_orphaned_zenodo_draft',
        depositionId: operation.depositionId
      };
    case 'zenodo_publish_journaled_draft':
      return {
        kind: 'would_publish_journaled_zenodo_draft',
        depositionId: operation.depositionId,
        draftRecordId: operation.draftRecordId,
        originalOperationType: operation.originalOperationType,
        payloadHash: operation.payloadHash,
        ...(operation.fileManifestHash
          ? { fileManifestHash: operation.fileManifestHash }
          : {})
      };
  }
}
