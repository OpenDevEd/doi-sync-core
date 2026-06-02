import type { SyncAttention, SyncOperation, SyncPlan } from '../planner.js';
import type { ZenodoPublishJournalOperationType } from '../zenodo/journal.js';

type SkippedReason = Extract<SyncPlan, { readonly status: 'skipped' }>['reason'];
type NeedsAttentionReason = Extract<SyncPlan, { readonly status: 'needs_attention' }>['reason'];

export type DryRunAction =
  | { readonly kind: 'would_submit_crossref'; readonly payloadHash: string }
  | { readonly kind: 'would_verify_pending_crossref'; readonly payloadHash: string }
  | { readonly kind: 'would_create_zenodo_record'; readonly payloadHash: string; readonly fileManifestHash: string }
  | { readonly kind: 'would_create_unpublished_zenodo_draft'; readonly payloadHash: string }
  | { readonly kind: 'would_update_unpublished_zenodo_draft'; readonly depositionId: string; readonly payloadHash: string }
  | { readonly kind: 'would_adopt_legacy_zenodo_deposition'; readonly depositionId: string; readonly payloadHash: string; readonly fileManifestHash: string }
  | { readonly kind: 'would_update_zenodo_metadata'; readonly payloadHash: string }
  | { readonly kind: 'would_create_zenodo_version'; readonly payloadHash: string; readonly fileManifestHash: string; readonly removedAttachmentKeys: readonly string[] }
  | {
      readonly kind: 'would_publish_journaled_zenodo_draft';
      readonly depositionId: string;
      readonly draftRecordId: string;
      readonly originalOperationType: ZenodoPublishJournalOperationType;
      readonly payloadHash: string;
      readonly fileManifestHash?: string;
    }
  | { readonly kind: 'would_settle_zotero_writeback' };

export type DryRunExecutionDescription =
  | {
      readonly recordId: string;
      readonly status: 'skipped';
      readonly reason: SkippedReason;
      readonly actions: readonly [];
    }
  | {
      readonly recordId: string;
      readonly status: 'needs_attention';
      readonly reason: NeedsAttentionReason;
      readonly actions: readonly [];
    }
  | {
      readonly recordId: string;
      readonly status: 'noop' | 'write_required';
      readonly actions: readonly DryRunAction[];
      readonly attention?: SyncAttention;
    };

export interface DescribeDryRunExecutionInput {
  readonly recordId: string;
  readonly plan: SyncPlan;
}

/** Converts a sync plan into human-readable dry-run actions without touching providers. */
export function describeDryRunExecution(input: DescribeDryRunExecutionInput): DryRunExecutionDescription {
  if (input.plan.status === 'skipped') {
    return {
      recordId: input.recordId,
      status: 'skipped',
      reason: input.plan.reason,
      actions: []
    };
  }

  if (input.plan.status === 'needs_attention') {
    return {
      recordId: input.recordId,
      status: 'needs_attention',
      reason: input.plan.reason,
      actions: []
    };
  }

  return {
    recordId: input.recordId,
    status: input.plan.status,
    actions: input.plan.operations.map(describeOperation),
    ...(input.plan.attention ? { attention: input.plan.attention } : {})
  };
}

function describeOperation(operation: SyncOperation): DryRunAction {
  switch (operation.type) {
    case 'crossref_redeposit':
      return { kind: 'would_submit_crossref', payloadHash: operation.payloadHash };
    case 'crossref_verify_pending':
      return { kind: 'would_verify_pending_crossref', payloadHash: operation.payloadHash };
    case 'zenodo_create':
      return {
        kind: 'would_create_zenodo_record',
        payloadHash: operation.payloadHash,
        fileManifestHash: operation.fileManifestHash
      };
    case 'zenodo_draft_create':
      return { kind: 'would_create_unpublished_zenodo_draft', payloadHash: operation.payloadHash };
    case 'zenodo_draft_update':
      return {
        kind: 'would_update_unpublished_zenodo_draft',
        depositionId: operation.depositionId,
        payloadHash: operation.payloadHash
      };
    case 'zenodo_legacy_deposition_adopt':
      return {
        kind: 'would_adopt_legacy_zenodo_deposition',
        depositionId: operation.depositionId,
        payloadHash: operation.payloadHash,
        fileManifestHash: operation.fileManifestHash
      };
    case 'zenodo_metadata_update':
      return { kind: 'would_update_zenodo_metadata', payloadHash: operation.payloadHash };
    case 'zenodo_new_version':
      return {
        kind: 'would_create_zenodo_version',
        payloadHash: operation.payloadHash,
        fileManifestHash: operation.fileManifestHash,
        removedAttachmentKeys: operation.removedAttachmentKeys
      };
    case 'zenodo_publish_journaled_draft':
      return {
        kind: 'would_publish_journaled_zenodo_draft',
        depositionId: operation.depositionId,
        draftRecordId: operation.draftRecordId,
        originalOperationType: operation.originalOperationType,
        payloadHash: operation.payloadHash,
        ...(operation.fileManifestHash ? { fileManifestHash: operation.fileManifestHash } : {})
      };
    case 'zotero_writeback':
      return { kind: 'would_settle_zotero_writeback' };
  }
}
