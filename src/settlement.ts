import type { SyncOperation, SyncPlan } from './planner.js';
import { isCrossrefOperation, isZenodoFileOperation } from './operations.js';
import type { JsonValue } from './hash.js';
import type { SyncPayloadSnapshots } from './snapshots.js';

export interface ExternalSyncStatePatch {
  readonly zoteroLastSeenAt?: Date;
  readonly crossrefPayloadHash?: string | null;
  readonly crossrefPayloadSnapshot?: JsonValue;
  readonly crossrefPendingPayloadHash?: string | null;
  readonly crossrefPendingPayloadSnapshot?: JsonValue | null;
  readonly crossrefPendingBatchId?: string | null;
  readonly crossrefPendingFilename?: string | null;
  readonly crossrefPendingSubmittedAt?: Date | null;
  readonly crossrefPendingReason?: string | null;
  readonly zenodoPayloadHash?: string;
  readonly zenodoPayloadSnapshot?: JsonValue;
  readonly fileManifestHash?: string;
  readonly fileManifestSnapshot?: JsonValue;
  readonly zenodoLatestRecordId?: string;
  readonly zenodoParentId?: string;
  readonly zenodoConceptDoi?: string;
  readonly zenodoVersionDoi?: string;
  readonly driftDetectedAt?: Date | null;
  readonly lastFailureClass?: string | null;
  readonly lastFailureSummary?: string | null;
  readonly consecutiveFailureCount?: number;
}

export interface SyncStateSettlement {
  readonly statePatch: ExternalSyncStatePatch;
}

export type SyncOperationResult =
  | {
      readonly type: SyncOperation['type'];
      readonly status: 'succeeded';
      readonly zenodo?: ZenodoSettlementIdentifiers;
      readonly zenodoAdoptionOnly?: boolean;
      readonly zenodoOrphanDraftCleanup?: ZenodoOrphanDraftCleanup;
      readonly zenodoPayloadSnapshot?: JsonValue;
    }
  | {
      readonly type: SyncOperation['type'];
      readonly status: 'skipped';
      readonly reason: string;
    }
  | {
      readonly type: SyncOperation['type'];
      readonly status: 'pending';
      readonly pendingClass: string;
      readonly pendingSummary: string;
      readonly crossref?: CrossrefPendingSettlement;
    }
  | {
      readonly type: SyncOperation['type'];
      readonly status: 'failed';
      readonly failureClass: string;
      readonly failureSummary: string;
    };

export interface ZenodoSettlementIdentifiers {
  readonly latestRecordId: string;
  readonly parentId: string;
  readonly conceptDoi?: string;
  readonly versionDoi?: string;
}

export type ZenodoOrphanDraftCleanup =
  | {
      readonly status: 'deleted';
      readonly depositionId: string;
    }
  | {
      readonly status: 'failed';
      readonly depositionId: string;
      readonly failureClass: string;
      readonly failureSummary: string;
    };

export interface CrossrefPendingSettlement {
  readonly batchId?: string;
  readonly filename?: string;
  readonly submittedAt?: Date;
}

export interface SettleSyncStateInput {
  readonly plan: SyncPlan;
  readonly observedAt: Date;
  readonly previousConsecutiveFailureCount?: number;
  readonly previousCrossrefPendingBatchId?: string | null;
  readonly previousCrossrefPendingFilename?: string | null;
  readonly previousCrossrefPendingSubmittedAt?: Date | null;
  readonly crossrefPendingMaxAgeMs?: number;
  readonly operationResults?: readonly SyncOperationResult[];
  readonly payloadSnapshots?: SyncPayloadSnapshots;
}

export function settleSyncState(input: SettleSyncStateInput): SyncStateSettlement {
  if (input.plan.status === 'needs_attention') {
    return {
      statePatch: {
        zoteroLastSeenAt: input.observedAt,
        driftDetectedAt: input.plan.reason === 'DOI_DRIFT' ? input.observedAt : null,
        lastFailureClass: input.plan.reason,
        lastFailureSummary: `Record is unsafe to sync: ${input.plan.reason}`,
        consecutiveFailureCount: (input.previousConsecutiveFailureCount ?? 0) + 1
      }
    };
  }

  const statePatch: MutableExternalSyncStatePatch = {
    zoteroLastSeenAt: input.observedAt
  };
  if (input.plan.status === 'skipped') return { statePatch };

  const results = input.operationResults ?? [];
  const failedResult = results.find((result) => result.status === 'failed');
  const pendingResult = results.find((result) => result.status === 'pending');
  for (const operation of input.plan.operations) {
    if (!didOperationSucceed(results, operation.type)) continue;

    if (isCrossrefOperation(operation)) {
      statePatch.crossrefPayloadHash = operation.payloadHash;
      if (input.payloadSnapshots) statePatch.crossrefPayloadSnapshot = input.payloadSnapshots.crossrefPayload;
      clearCrossrefPendingState(statePatch);
    }

    if (operation.type !== 'zenodo_publish_journaled_draft' && isZenodoFileOperation(operation)) {
      const result = findSucceededResult(results, operation.type);
      if (result?.zenodoAdoptionOnly === true) {
        applyZenodoIdentifiersToPatch(statePatch, result.zenodo);
        continue;
      }
      statePatch.zenodoPayloadHash = operation.payloadHash;
      if (input.payloadSnapshots) statePatch.zenodoPayloadSnapshot = input.payloadSnapshots.zenodoPayload;
      statePatch.fileManifestHash = operation.fileManifestHash;
      if (input.payloadSnapshots) statePatch.fileManifestSnapshot = input.payloadSnapshots.fileManifest;
      applyZenodoIdentifiersToPatch(statePatch, result?.zenodo);
    }

    if (operation.type === 'zenodo_metadata_update') {
      const result = findSucceededResult(results, operation.type);
      if (result?.zenodoAdoptionOnly === true) {
        applyZenodoIdentifiersToPatch(statePatch, result.zenodo);
        continue;
      }
      statePatch.zenodoPayloadHash = operation.payloadHash;
      if (input.payloadSnapshots) statePatch.zenodoPayloadSnapshot = input.payloadSnapshots.zenodoPayload;
      applyZenodoIdentifiersToPatch(statePatch, result?.zenodo);
    }

    if (operation.type === 'zenodo_publish_journaled_draft') {
      const result = findSucceededResult(results, operation.type);
      if (result?.zenodoAdoptionOnly === true) {
        applyZenodoIdentifiersToPatch(statePatch, result.zenodo);
        continue;
      }
      statePatch.zenodoPayloadHash = operation.payloadHash;
      if (input.payloadSnapshots) statePatch.zenodoPayloadSnapshot = input.payloadSnapshots.zenodoPayload;
      if (operation.fileManifestHash) {
        statePatch.fileManifestHash = operation.fileManifestHash;
        if (input.payloadSnapshots) statePatch.fileManifestSnapshot = input.payloadSnapshots.fileManifest;
      }
      applyZenodoIdentifiersToPatch(statePatch, result?.zenodo);
    }
  }

  for (const operation of input.plan.operations) {
    const pending = findPendingResult(results, operation.type);
    if (!pending) continue;

    if (isCrossrefOperation(operation)) {
      statePatch.crossrefPendingPayloadHash = operation.payloadHash;
      if (input.payloadSnapshots) statePatch.crossrefPendingPayloadSnapshot = input.payloadSnapshots.crossrefPayload;
      statePatch.crossrefPendingBatchId = pending.crossref?.batchId ?? input.previousCrossrefPendingBatchId ?? null;
      statePatch.crossrefPendingFilename = pending.crossref?.filename ?? input.previousCrossrefPendingFilename ?? null;
      statePatch.crossrefPendingSubmittedAt = pending.crossref?.submittedAt ?? input.previousCrossrefPendingSubmittedAt ?? null;
      statePatch.crossrefPendingReason = pending.pendingSummary;
    }
  }

  if (failedResult) {
    if (failedResult.type === 'crossref_redeposit' && failedResult.failureClass === 'CROSSREF_FAILED') {
      clearCrossrefPendingState(statePatch);
    }
    return {
      statePatch: {
        ...statePatch,
        driftDetectedAt: null,
        lastFailureClass: failedResult.failureClass,
        lastFailureSummary: failedResult.failureSummary,
        consecutiveFailureCount: (input.previousConsecutiveFailureCount ?? 0) + 1
      }
    };
  }

  if (pendingResult) {
    const staleCrossrefPending = staleCrossrefPendingFailure(input, pendingResult);
    if (staleCrossrefPending) {
      return {
        statePatch: {
          ...statePatch,
          driftDetectedAt: null,
          lastFailureClass: staleCrossrefPending.failureClass,
          lastFailureSummary: staleCrossrefPending.failureSummary,
          consecutiveFailureCount: (input.previousConsecutiveFailureCount ?? 0) + 1
        }
      };
    }

    // Don't clear the failure breadcrumb / reset backoff if a planned op produced no result at all
    // (an incomplete run). An op counts as accounted-for if it succeeded, was skipped, or is itself
    // pending (legitimately in progress); a missing result means the run did not finish. A FAILED
    // sibling cannot reach here — it short-circuits in the failedResult branch above.
    const everyOperationAccountedFor = input.plan.operations.every((operation) => (
      didOperationComplete(results, operation.type) || Boolean(findPendingResult(results, operation.type))
    ));
    if (input.plan.status === 'write_required' && !everyOperationAccountedFor) {
      return { statePatch };
    }

    return {
      statePatch: {
        ...statePatch,
        driftDetectedAt: null,
        lastFailureClass: null,
        lastFailureSummary: null,
        consecutiveFailureCount: 0
      }
    };
  }

  if (input.plan.status === 'write_required' && !input.plan.operations.every((operation) => didOperationComplete(results, operation.type))) {
    return { statePatch };
  }

  return {
    statePatch: {
      ...statePatch,
      driftDetectedAt: null,
      lastFailureClass: null,
      lastFailureSummary: null,
      consecutiveFailureCount: 0
    }
  };
}

type MutableExternalSyncStatePatch = {
  -readonly [Key in keyof ExternalSyncStatePatch]: ExternalSyncStatePatch[Key];
};

function didOperationSucceed(results: readonly SyncOperationResult[], operationType: SyncOperation['type']): boolean {
  return Boolean(findSucceededResult(results, operationType));
}

function didOperationComplete(results: readonly SyncOperationResult[], operationType: SyncOperation['type']): boolean {
  return results.some((result) => (
    result.type === operationType && (result.status === 'succeeded' || result.status === 'skipped')
  ));
}

function findSucceededResult(
  results: readonly SyncOperationResult[],
  operationType: SyncOperation['type']
): Extract<SyncOperationResult, { readonly status: 'succeeded' }> | undefined {
  return results.find((result): result is Extract<SyncOperationResult, { readonly status: 'succeeded' }> => (
    result.type === operationType && result.status === 'succeeded'
  ));
}

function findPendingResult(
  results: readonly SyncOperationResult[],
  operationType: SyncOperation['type']
): Extract<SyncOperationResult, { readonly status: 'pending' }> | undefined {
  return results.find((result): result is Extract<SyncOperationResult, { readonly status: 'pending' }> => (
    result.type === operationType && result.status === 'pending'
  ));
}

function staleCrossrefPendingFailure(
  input: SettleSyncStateInput,
  pendingResult: Extract<SyncOperationResult, { readonly status: 'pending' }>
): { readonly failureClass: string; readonly failureSummary: string } | undefined {
  if (pendingResult.pendingClass !== 'CROSSREF_PENDING') return undefined;
  if (input.crossrefPendingMaxAgeMs === undefined) return undefined;
  const submittedAt = pendingResult.crossref?.submittedAt ?? input.previousCrossrefPendingSubmittedAt;
  if (!submittedAt) {
    return {
      failureClass: 'CROSSREF_PENDING_MISSING_SUBMITTED_AT',
      failureSummary: 'Crossref pending verification cannot age out because submittedAt is missing'
    };
  }
  const ageMs = input.observedAt.getTime() - submittedAt.getTime();
  if (ageMs <= input.crossrefPendingMaxAgeMs) return undefined;
  return {
    failureClass: 'CROSSREF_PENDING_STALE',
    failureSummary: `Crossref pending verification exceeded the configured max age: ${pendingResult.pendingSummary}`
  };
}

function clearCrossrefPendingState(statePatch: MutableExternalSyncStatePatch): void {
  statePatch.crossrefPendingPayloadHash = null;
  statePatch.crossrefPendingPayloadSnapshot = null;
  statePatch.crossrefPendingBatchId = null;
  statePatch.crossrefPendingFilename = null;
  statePatch.crossrefPendingSubmittedAt = null;
  statePatch.crossrefPendingReason = null;
}

function applyZenodoIdentifiersToPatch(
  statePatch: MutableExternalSyncStatePatch,
  identifiers: ZenodoSettlementIdentifiers | undefined
): void {
  if (!identifiers) return;
  statePatch.zenodoLatestRecordId = identifiers.latestRecordId;
  statePatch.zenodoParentId = identifiers.parentId;
  if (identifiers.conceptDoi) statePatch.zenodoConceptDoi = identifiers.conceptDoi;
  if (identifiers.versionDoi) statePatch.zenodoVersionDoi = identifiers.versionDoi;
}
