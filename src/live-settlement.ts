import { buildCrossrefZenodoRelation, crossrefRelationFromPlan, type ExternalSyncState, type SyncPlan } from './planner.js';
import { isZenodoFileOperation } from './operations.js';
import { settleSyncState, type ExternalSyncStatePatch, type SyncOperationResult } from './settlement.js';
import { buildSyncPayloadSnapshots, type SyncPayloadSnapshots } from './snapshots.js';
import type { DoiPolicy } from './zenodo/records.js';
import { isRecoveredZenodoCurrent } from './zenodo/state-hints.js';
import type { JsonValue } from './hash.js';

export interface SettleLiveSyncPlanInput {
  readonly plan: SyncPlan;
  readonly state?: ExternalSyncState;
  readonly operationResults: readonly SyncOperationResult[];
  readonly observedAt: Date;
  readonly crossrefPendingMaxAgeMs?: number;
  readonly doiPolicy: DoiPolicy;
  readonly resourceUrl: string;
  /** Zotero `zotero://select/...` URL used to keep settled payload snapshots in sync with the executor input. */
  readonly zoteroSelectUrl?: string;
}

export interface LiveSyncPlanSettlement {
  readonly statePatch: ExternalSyncStatePatch;
  readonly payloadSnapshots?: SyncPayloadSnapshots;
  readonly zenodoFileRecordId?: string;
}

/** Converts live operation results into a worker-state patch and payload snapshots. */
export function settleLiveSyncPlan(input: SettleLiveSyncPlanInput): LiveSyncPlanSettlement {
  const payloadSnapshots = applyActualZenodoPayloadSnapshot(
    buildOptionalPayloadSnapshots(input),
    input.operationResults
  );
  const settlement = settleSyncState({
    plan: input.plan,
    observedAt: input.observedAt,
    ...(input.state?.consecutiveFailureCount == null ? {} : { previousConsecutiveFailureCount: input.state.consecutiveFailureCount }),
    ...(input.state?.crossrefPendingBatchId === undefined ? {} : { previousCrossrefPendingBatchId: input.state.crossrefPendingBatchId }),
    ...(input.state?.crossrefPendingFilename === undefined ? {} : { previousCrossrefPendingFilename: input.state.crossrefPendingFilename }),
    ...(input.state?.crossrefPendingSubmittedAt === undefined ? {} : { previousCrossrefPendingSubmittedAt: input.state.crossrefPendingSubmittedAt }),
    ...(input.crossrefPendingMaxAgeMs === undefined ? {} : { crossrefPendingMaxAgeMs: input.crossrefPendingMaxAgeMs }),
    operationResults: input.operationResults,
    ...(payloadSnapshots ? { payloadSnapshots } : {})
  });
  const statePatch = {
    ...(payloadSnapshots ? recoveredZenodoStatePatch(input.plan, input.state, payloadSnapshots) : {}),
    ...(payloadSnapshots ? settledSnapshotBackfillPatch(input.plan, input.state, payloadSnapshots) : {}),
    ...settlement.statePatch
  };
  const zenodoFileRecordId = successfulZenodoFileRecordId(input.plan, input.operationResults)
    ?? recoveredZenodoFileRecordId(input.plan, input.state);

  return {
    statePatch,
    ...(payloadSnapshots ? { payloadSnapshots } : {}),
    ...(zenodoFileRecordId ? { zenodoFileRecordId } : {})
  };
}

function applyActualZenodoPayloadSnapshot(
  snapshots: SyncPayloadSnapshots | undefined,
  results: readonly SyncOperationResult[]
): SyncPayloadSnapshots | undefined {
  if (!snapshots) return undefined;
  const actualZenodoPayload = results.find(hasZenodoPayloadSnapshot)?.zenodoPayloadSnapshot;
  return actualZenodoPayload
    ? { ...snapshots, zenodoPayload: actualZenodoPayload }
    : snapshots;
}

function hasZenodoPayloadSnapshot(
  result: SyncOperationResult
): result is Extract<SyncOperationResult, { readonly status: 'succeeded' }> & { readonly zenodoPayloadSnapshot: JsonValue } {
  return result.status === 'succeeded' && result.zenodoPayloadSnapshot !== undefined;
}

function buildOptionalPayloadSnapshots(input: SettleLiveSyncPlanInput): SyncPayloadSnapshots | undefined {
  if (input.plan.status !== 'write_required' && input.plan.status !== 'noop') return undefined;
  const crossrefRelation = crossrefRelationForPayloadSnapshot(input.plan, input.state);
  return buildSyncPayloadSnapshots({
    metadata: input.plan.metadata,
    fileManifest: input.plan.fileManifest,
    doiPolicy: input.doiPolicy,
    existingZenodoVersionDoi: input.state?.zenodoVersionDoi,
    resourceUrl: input.resourceUrl,
    ...(crossrefRelation ? { crossrefRelation } : {}),
    ...(input.zoteroSelectUrl ? { zoteroSelectUrl: input.zoteroSelectUrl } : {})
  });
}

function successfulZenodoFileRecordId(plan: SyncPlan, results: readonly SyncOperationResult[]): string | undefined {
  if (plan.status !== 'write_required') return undefined;
  const hasPlannedFileOperation = plan.operations.some(isZenodoFileOperation);
  if (!hasPlannedFileOperation) return undefined;

  const result = results.find((entry): entry is Extract<SyncOperationResult, { readonly status: 'succeeded' }> => (
    entry.status === 'succeeded'
    && plan.operations.some((operation) => operation.type === entry.type && isZenodoFileOperation(operation))
    && Boolean(entry.zenodo?.latestRecordId)
  ));
  return result?.zenodo?.latestRecordId;
}

function recoveredZenodoFileRecordId(plan: SyncPlan, state: ExternalSyncState | undefined): string | undefined {
  if (!('fileManifest' in plan)) return undefined;
  if (!isRecoveredZenodoCurrent(state, plan.hashes)) return undefined;
  return state?.zenodoLatestRecordId ?? undefined;
}

function recoveredZenodoStatePatch(
  plan: SyncPlan,
  state: ExternalSyncState | undefined,
  payloadSnapshots: SyncPayloadSnapshots
): ExternalSyncStatePatch {
  if (!('hashes' in plan)) return {};
  if (!isRecoveredZenodoCurrent(state, plan.hashes)) return {};
  if (!state?.zenodoLatestRecordId || !state.zenodoParentId) return {};

  return {
    zenodoLatestRecordId: state.zenodoLatestRecordId,
    zenodoParentId: state.zenodoParentId,
    ...(state.zenodoConceptDoi ? { zenodoConceptDoi: state.zenodoConceptDoi } : {}),
    ...(state.zenodoVersionDoi ? { zenodoVersionDoi: state.zenodoVersionDoi } : {}),
    zenodoPayloadHash: plan.hashes.zenodoPayloadHash,
    zenodoPayloadSnapshot: payloadSnapshots.zenodoPayload,
    fileManifestHash: plan.hashes.fileManifestHash,
    fileManifestSnapshot: payloadSnapshots.fileManifest
  };
}

function settledSnapshotBackfillPatch(
  plan: SyncPlan,
  state: ExternalSyncState | undefined,
  payloadSnapshots: SyncPayloadSnapshots
): ExternalSyncStatePatch {
  if (!('hashes' in plan)) return {};

  return {
    ...(state?.crossrefPayloadHash === plan.hashes.crossrefPayloadHash
      ? { crossrefPayloadSnapshot: payloadSnapshots.crossrefPayload }
      : {}),
    ...(state?.zenodoLatestRecordId && state.zenodoPayloadHash === plan.hashes.zenodoPayloadHash
      ? { zenodoPayloadSnapshot: payloadSnapshots.zenodoPayload }
      : {}),
    ...(state?.zenodoLatestRecordId && state.fileManifestHash === plan.hashes.fileManifestHash
      ? {
          fileManifestHash: plan.hashes.fileManifestHash,
          fileManifestSnapshot: payloadSnapshots.fileManifest
        }
      : {})
  };
}

function crossrefRelationForPayloadSnapshot(plan: SyncPlan, state: ExternalSyncState | undefined) {
  if (!('metadata' in plan)) return undefined;
  return crossrefRelationFromPlan(plan) ?? buildCrossrefZenodoRelation(state, plan.metadata.doi);
}
