import { normalizeDoi, type DoiDriftResult } from './doi.js';
import type { CrossrefRelation } from './crossref/xml.js';
import { buildFileManifest, DEFAULT_ZOTERO_PDF_TAGS, diffFileManifest, type FileManifest, type ZoteroChildItem } from './files.js';
import { asRecord, asString } from './guards.js';
import { sha256Hex } from './hash.js';
import type { JsonValue } from './hash.js';
import { buildCanonicalMetadataSnapshot, type CanonicalMetadataSnapshot, type ZoteroParentItem } from './metadata.js';
import { changesZenodoVersionDoi } from './operations.js';
import { buildSyncPayloadSnapshots } from './snapshots.js';
import { planZoteroIdentifierLinkReconciliation } from './zotero/identifier-links.js';
import { analyzeZoteroDoiDrift } from './zotero/doi.js';
import { buildZoteroWritebackData, buildZoteroWritebackIdentifiers, planZoteroWriteback } from './zotero/writeback.js';
import { effectiveZenodoDoiPolicy } from './zenodo/doi-policy.js';
import type { ZenodoPublishJournalOperationType } from './zenodo/journal.js';
import type { DoiPolicy } from './zenodo/records.js';
import { isRecoveredZenodoCurrent } from './zenodo/state-hints.js';

export interface DoiSyncRecord {
  readonly id: string;
  readonly zoteroItemKey: string;
  readonly crossrefDoi: string;
  readonly doiActivated: boolean;
  readonly knownZenodoRecordId?: string | number | null;
}

export interface SyncPolicy {
  readonly callNumberDoiPrefix: string;
  readonly doiPolicy: DoiPolicy;
  readonly fallbackPublicationDate: string;
  readonly zoteroPdfTags?: readonly string[] | null | undefined;
}

export interface ExternalSyncState {
  readonly crossrefPayloadHash?: string | null;
  readonly crossrefPayloadSnapshot?: JsonValue | null;
  readonly crossrefPendingPayloadHash?: string | null;
  readonly crossrefPendingPayloadSnapshot?: JsonValue | null;
  readonly crossrefPendingBatchId?: string | null;
  readonly crossrefPendingFilename?: string | null;
  readonly crossrefPendingSubmittedAt?: Date | null;
  readonly crossrefPendingReason?: string | null;
  readonly zenodoPayloadHash?: string | null;
  readonly zenodoPayloadSnapshot?: JsonValue | null;
  readonly fileManifestHash?: string | null;
  readonly fileManifestSnapshot?: JsonValue | null;
  readonly previousAttachmentKeys?: readonly string[] | null;
  readonly previousFiles?: readonly ExternalSyncFileState[] | null;
  readonly zenodoLatestRecordId?: string | null;
  readonly zenodoParentId?: string | null;
  readonly zenodoConceptDoi?: string | null;
  readonly zenodoVersionDoi?: string | null;
  readonly zenodoLegacyDepositionId?: string | null;
  readonly zenodoLegacyDepositionState?: 'unsubmitted' | null;
  readonly zenodoRecoveredFromZoteroWriteback?: boolean;
  readonly zenodoRecoveredFromPrePublishJournal?: boolean;
  readonly zenodoRecoveredFromFileSnapshot?: boolean;
  readonly zenodoRecoveredZenodoPayloadHash?: string | null;
  readonly zenodoRecoveredFileManifestHash?: string | null;
  readonly zenodoJournaledDraftOperationType?: ZenodoPublishJournalOperationType | null;
  readonly zenodoJournaledDraftDepositionId?: string | null;
  readonly zenodoJournaledDraftRecordId?: string | null;
  readonly zenodoJournaledDraftParentId?: string | null;
  readonly lastFailureClass?: string | null;
  readonly lastFailureSummary?: string | null;
  readonly consecutiveFailureCount?: number | null;
}

export interface ExternalSyncFileState {
  readonly zoteroAttachmentKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly zoteroMd5?: string | null;
  readonly zoteroMtime?: number | null;
  readonly zenodoRecordId?: string | null;
}

export interface PlanRecordSyncInput {
  readonly record: DoiSyncRecord;
  readonly zoteroItem: ZoteroParentItem;
  readonly zoteroChildren: readonly ZoteroChildItem[];
  readonly state?: ExternalSyncState;
  readonly policy: SyncPolicy;
  readonly resourceUrl: string;
  readonly zenodoBaseUrl?: string;
  /** Zotero `zotero://select/...` URL emitted into the legacy Zenodo deposition `related_identifiers` write payload. */
  readonly zoteroSelectUrl?: string;
}

export type SyncOperation =
  | { readonly type: 'crossref_redeposit'; readonly payloadHash: string; readonly relation?: CrossrefRelation }
  | { readonly type: 'crossref_verify_pending'; readonly payloadHash: string; readonly relation?: CrossrefRelation }
  | { readonly type: 'zenodo_create'; readonly payloadHash: string; readonly fileManifestHash: string }
  | { readonly type: 'zenodo_draft_create'; readonly payloadHash: string }
  | { readonly type: 'zenodo_draft_update'; readonly depositionId: string; readonly payloadHash: string }
  | { readonly type: 'zenodo_legacy_deposition_adopt'; readonly depositionId: string; readonly payloadHash: string; readonly fileManifestHash: string }
  | { readonly type: 'zenodo_metadata_update'; readonly payloadHash: string }
  | { readonly type: 'zenodo_file_update'; readonly payloadHash: string; readonly fileManifestHash: string; readonly removedAttachmentKeys: readonly string[] }
  | { readonly type: 'zenodo_new_version'; readonly payloadHash: string; readonly fileManifestHash: string; readonly removedAttachmentKeys: readonly string[] }
  | {
      readonly type: 'zenodo_publish_journaled_draft';
      readonly originalOperationType: ZenodoPublishJournalOperationType;
      readonly depositionId: string;
      readonly draftRecordId: string;
      readonly parentId?: string;
      readonly payloadHash: string;
      readonly fileManifestHash?: string;
    }
  | { readonly type: 'zotero_writeback' };

export interface SyncHashes {
  readonly crossrefPayloadHash: string;
  readonly zenodoPayloadHash: string;
  readonly fileManifestHash: string;
}

/**
 * A non-fatal condition that prevents one part of a sync from being applied while the rest of the
 * record still syncs. Unlike a `needs_attention` plan status (which blocks the whole record), an
 * attention marker rides alongside the operations that CAN still run.
 */
export type SyncAttention =
  | { readonly reason: 'ZOTERO_FILE_CONFLICT' };

export type SyncPlan =
  | { readonly status: 'skipped'; readonly reason: 'DOI_NOT_ACTIVE' | 'MISSING_REQUIRED_IDENTIFIERS' }
  | { readonly status: 'needs_attention'; readonly reason: 'DOI_DRIFT'; readonly operations: readonly []; readonly drift: DoiDriftResult }
  | { readonly status: 'needs_attention'; readonly reason: 'ZOTERO_ITEM_DELETED'; readonly operations: readonly [] }
  | { readonly status: 'needs_attention'; readonly reason: 'ZOTERO_FILE_CONFLICT'; readonly operations: readonly [] }
  | { readonly status: 'needs_attention'; readonly reason: 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED'; readonly operations: readonly [] }
  | { readonly status: 'needs_attention'; readonly reason: 'ZENODO_DOI_LOOKUP_AMBIGUOUS'; readonly operations: readonly [] }
  | {
      readonly status: 'noop' | 'write_required';
      readonly operations: readonly SyncOperation[];
      readonly metadata: CanonicalMetadataSnapshot;
      readonly fileManifest: FileManifest;
      readonly hashes: SyncHashes;
      /** Present when part of the desired sync could not be planned (e.g. a blocked file change) but other operations still run. */
      readonly attention?: SyncAttention;
    };

interface BuildOperationsResult {
  readonly operations: readonly SyncOperation[];
  readonly attention?: SyncAttention;
}

export function planRecordSync(input: PlanRecordSyncInput): SyncPlan {
  if (!input.record.doiActivated) return { status: 'skipped', reason: 'DOI_NOT_ACTIVE' };
  if (!input.record.crossrefDoi.trim() || !input.record.zoteroItemKey.trim()) return { status: 'skipped', reason: 'MISSING_REQUIRED_IDENTIFIERS' };

  const data = input.zoteroItem.data;
  if (isDeletedZoteroItem(data.deleted)) {
    return {
      status: 'needs_attention',
      reason: 'ZOTERO_ITEM_DELETED',
      operations: []
    };
  }

  const drift = analyzeZoteroDoiDrift({
    recordDoi: input.record.crossrefDoi,
    zoteroDoi: data.DOI,
    zoteroLowercaseDoi: data.doi,
    extra: data.extra,
    callNumber: data.callNumber,
    callNumberDoiPrefix: input.policy.callNumberDoiPrefix
  });

  if (drift.drifted) {
    return {
      status: 'needs_attention',
      reason: 'DOI_DRIFT',
      operations: [],
      drift
    };
  }

  const unsafeZenodoDoiRecoveryReason = unsafeZenodoDoiRecoveryBlockReason(input);
  if (unsafeZenodoDoiRecoveryReason) {
    return {
      status: 'needs_attention',
      reason: unsafeZenodoDoiRecoveryReason,
      operations: []
    };
  }

  const metadata = buildCanonicalMetadataSnapshot({
    recordDoi: input.record.crossrefDoi,
    zoteroItem: input.zoteroItem,
    callNumberDoiPrefix: input.policy.callNumberDoiPrefix,
    fallbackPublicationDate: input.policy.fallbackPublicationDate
  });
  const fileManifest = buildFileManifest(input.zoteroChildren, {
    extensions: ['pdf'],
    allowedTags: input.policy.zoteroPdfTags ?? DEFAULT_ZOTERO_PDF_TAGS
  });
  const crossrefRelation = buildCrossrefZenodoRelation(input.state, input.record.crossrefDoi);
  const zenodoDoiPolicy = effectiveZenodoDoiPolicy({
    configuredPolicy: input.policy.doiPolicy,
    crossrefDoi: input.record.crossrefDoi,
    existingVersionDoi: input.state?.zenodoVersionDoi
  });
  const hashes = buildSyncHashes(metadata, fileManifest, zenodoDoiPolicy, input.resourceUrl, crossrefRelation, input.zoteroSelectUrl);
  const { operations, attention } = buildOperations(input, hashes, fileManifest, crossrefRelation, zenodoDoiPolicy);

  // A pure attention case (the blocked part is the only thing that changed) is still surfaced as a
  // blocking needs_attention so it shows up as action-needed rather than a silent noop.
  if (operations.length === 0 && attention) {
    return { status: 'needs_attention', reason: attention.reason, operations: [] };
  }

  return {
    status: operations.length > 0 ? 'write_required' : 'noop',
    operations,
    metadata,
    fileManifest,
    hashes,
    ...(attention ? { attention } : {})
  };
}

function buildSyncHashes(
  metadata: CanonicalMetadataSnapshot,
  fileManifest: FileManifest,
  doiPolicy: DoiPolicy,
  resourceUrl: string,
  crossrefRelation: CrossrefRelation | undefined,
  zoteroSelectUrl: string | undefined
): SyncHashes {
  const snapshots = buildSyncPayloadSnapshots({
    metadata,
    fileManifest,
    doiPolicy,
    resourceUrl,
    ...(crossrefRelation ? { crossrefRelation } : {}),
    ...(zoteroSelectUrl ? { zoteroSelectUrl } : {})
  });

  return {
    crossrefPayloadHash: sha256Hex(snapshots.crossrefPayload),
    zenodoPayloadHash: sha256Hex(snapshots.zenodoPayload),
    fileManifestHash: sha256Hex(snapshots.fileManifest)
  };
}

function buildOperations(
  input: PlanRecordSyncInput,
  hashes: SyncHashes,
  fileManifest: FileManifest,
  crossrefRelation: CrossrefRelation | undefined,
  zenodoDoiPolicy: DoiPolicy
): BuildOperationsResult {
  const state = input.state;
  const operations: SyncOperation[] = [];
  const blockingFileConflict = hasBlockingFileConflicts(fileManifest);
  const hasUploadableFiles = fileManifest.files.length > 0 && !blockingFileConflict;
  // When the "no uploadable files" branches below are taken because of a blocking conflict (rather
  // than a genuine absence of files), surface it so the dropped files are visibly action-needed.
  const conflictAttention: SyncAttention | undefined = blockingFileConflict ? { reason: 'ZOTERO_FILE_CONFLICT' } : undefined;

  const journaledDraftOperation = planJournaledDraftPublish(state, hashes);
  if (journaledDraftOperation) {
    operations.push(journaledDraftOperation);
    if (journaledDraftOperation.fileManifestHash) operations.push({ type: 'zotero_writeback' });
    return buildOperationsResult(prependCrossrefOperation(state, hashes, crossrefRelation, operations));
  }

  if (hasUploadableFiles && state?.zenodoLegacyDepositionId && state.zenodoLegacyDepositionState === 'unsubmitted') {
    operations.push({
      type: 'zenodo_legacy_deposition_adopt',
      depositionId: state.zenodoLegacyDepositionId,
      payloadHash: hashes.zenodoPayloadHash,
      fileManifestHash: hashes.fileManifestHash
    });
    operations.push({ type: 'zotero_writeback' });
    return buildOperationsResult(prependCrossrefOperation(state, hashes, crossrefRelation, operations));
  }

  if (!hasUploadableFiles && state?.zenodoLegacyDepositionId && state.zenodoLegacyDepositionState === 'unsubmitted') {
    if (unpublishedDraftPayloadHash(state) !== hashes.zenodoPayloadHash) {
      operations.push({
        type: 'zenodo_draft_update',
        depositionId: state.zenodoLegacyDepositionId,
        payloadHash: hashes.zenodoPayloadHash
      });
      operations.push({ type: 'zotero_writeback' });
    }
    return buildOperationsResult(prependCrossrefOperation(state, hashes, crossrefRelation, operations), conflictAttention);
  }

  const hasZenodoRecord = Boolean(state?.zenodoLatestRecordId) || Boolean(knownZenodoRecordId(input.record));
  if (!hasZenodoRecord) {
    if (!hasUploadableFiles) {
      operations.push({
        type: 'zenodo_draft_create',
        payloadHash: hashes.zenodoPayloadHash
      });
      operations.push({ type: 'zotero_writeback' });
      return buildOperationsResult(prependCrossrefOperation(state, hashes, crossrefRelation, operations), conflictAttention);
    }

    operations.push({
      type: 'zenodo_create',
      payloadHash: hashes.zenodoPayloadHash,
      fileManifestHash: hashes.fileManifestHash
    });
    operations.push({ type: 'zotero_writeback' });
    return buildOperationsResult(prependCrossrefOperation(state, hashes, crossrefRelation, operations));
  }

  const removedAttachmentKeys = diffFileManifest({
    previousAttachmentKeys: previousAttachmentKeysForDiff(state, fileManifest),
    current: fileManifest
  }).removedAttachmentKeys;
  const recoveredZenodoIsCurrent = isRecoveredZenodoCurrent(state, hashes);
  const settledZenodoPayloadHash = recoveredZenodoIsCurrent ? hashes.zenodoPayloadHash : state?.zenodoPayloadHash;
  const settledFileManifestHash = recoveredZenodoIsCurrent ? hashes.fileManifestHash : state?.fileManifestHash;

  const zenodoFilesChanged = settledFileManifestHash !== hashes.fileManifestHash || removedAttachmentKeys.length > 0;
  const zenodoMetadataChanged = settledZenodoPayloadHash !== hashes.zenodoPayloadHash;
  let attention: SyncAttention | undefined;

  if (blockingFileConflict) {
    // A blocking duplicate-filename conflict means we cannot determine the correct file set, so we
    // must never publish a partial Zenodo version (which would also advance fileManifestHash and
    // bury the conflict). This holds for EVERY DOI policy, and we flag it from the mere PRESENCE of
    // a conflict (not just a hash delta) so "additive" conflicts that leave the prior file set
    // untouched are surfaced too. Metadata + Crossref still sync; fileManifestHash is never advanced
    // (no file op is planned), so it keeps re-flagging until the conflict is resolved in Zotero.
    attention = { reason: 'ZOTERO_FILE_CONFLICT' };
    if (zenodoMetadataChanged) {
      operations.push({ type: 'zenodo_metadata_update', payloadHash: hashes.zenodoPayloadHash });
    }
  } else if (zenodoFilesChanged && zenodoDoiPolicy === 'external-crossref') {
    if (zenodoMetadataChanged) {
      operations.push({ type: 'zenodo_metadata_update', payloadHash: hashes.zenodoPayloadHash });
    }
    operations.push({
      type: 'zenodo_file_update',
      payloadHash: hashes.zenodoPayloadHash,
      fileManifestHash: hashes.fileManifestHash,
      removedAttachmentKeys
    });
    operations.push({ type: 'zotero_writeback' });
  } else if (zenodoFilesChanged) {
    operations.push({
      type: 'zenodo_new_version',
      payloadHash: hashes.zenodoPayloadHash,
      fileManifestHash: hashes.fileManifestHash,
      removedAttachmentKeys
    });
    operations.push({ type: 'zotero_writeback' });
  } else if (zenodoMetadataChanged) {
    operations.push({
      type: 'zenodo_metadata_update',
      payloadHash: hashes.zenodoPayloadHash
    });
  }

  if (!operations.some((operation) => operation.type === 'zotero_writeback') && shouldPlanZoteroWriteback(input, state)) {
    operations.push({ type: 'zotero_writeback' });
  }

  return buildOperationsResult(prependCrossrefOperation(state, hashes, crossrefRelation, operations), attention);
}

function buildOperationsResult(operations: readonly SyncOperation[], attention?: SyncAttention): BuildOperationsResult {
  return {
    operations,
    ...(attention ? { attention } : {})
  };
}

function hasBlockingFileConflicts(fileManifest: FileManifest): boolean {
  return fileManifest.unsupported.some((attachment) => attachment.blocksZenodoFiles === true);
}

type UnsafeZenodoDoiRecoveryReason = Extract<SyncPlan, { readonly status: 'needs_attention' }>['reason'] & (
  'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED' | 'ZENODO_DOI_LOOKUP_AMBIGUOUS'
);

function unsafeZenodoDoiRecoveryBlockReason(input: PlanRecordSyncInput): UnsafeZenodoDoiRecoveryReason | null {
  if (input.state?.zenodoLatestRecordId || knownZenodoRecordId(input.record)) return null;
  if (input.state?.zenodoLegacyDepositionId && input.state.zenodoLegacyDepositionState === 'unsubmitted') return null;
  if (input.state?.lastFailureClass === 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED') return 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED';
  if (input.state?.lastFailureClass === 'ZENODO_DOI_LOOKUP_AMBIGUOUS') return 'ZENODO_DOI_LOOKUP_AMBIGUOUS';
  return null;
}

function previousAttachmentKeysForDiff(state: ExternalSyncState | undefined, fileManifest: FileManifest): readonly string[] {
  if (state?.previousAttachmentKeys) return state.previousAttachmentKeys;
  if (state?.previousFiles) return state.previousFiles.map((file) => file.zoteroAttachmentKey);
  const snapshotKeys = previousAttachmentKeysFromSnapshot(state?.fileManifestSnapshot);
  if (snapshotKeys.length > 0) return snapshotKeys;
  return fileManifest.files.map((file) => file.zoteroAttachmentKey);
}

function previousAttachmentKeysFromSnapshot(snapshot: JsonValue | null | undefined): readonly string[] {
  const files = asRecord(snapshot)?.['files'];
  if (!Array.isArray(files)) return [];
  return files.flatMap((entry) => {
    const key = asString(asRecord(entry)?.['zoteroAttachmentKey']);
    return key ? [key] : [];
  });
}

function prependCrossrefOperation(
  state: ExternalSyncState | undefined,
  hashes: SyncHashes,
  crossrefRelation: CrossrefRelation | undefined,
  operations: readonly SyncOperation[]
): readonly SyncOperation[] {
  if (state?.crossrefPayloadHash === hashes.crossrefPayloadHash) return operations;
  if (crossrefRelation && operations.some(changesZenodoVersionDoi)) return operations;

  if (state?.crossrefPendingPayloadHash === hashes.crossrefPayloadHash) {
    return [{
      type: 'crossref_verify_pending',
      payloadHash: hashes.crossrefPayloadHash,
      ...(crossrefRelation ? { relation: crossrefRelation } : {})
    }, ...operations];
  }

  const operation: Extract<SyncOperation, { readonly type: 'crossref_redeposit' }> = {
    type: 'crossref_redeposit',
    payloadHash: hashes.crossrefPayloadHash,
    ...(crossrefRelation ? { relation: crossrefRelation } : {})
  };

  return [operation, ...operations];
}

function unpublishedDraftPayloadHash(state: ExternalSyncState): string | null | undefined {
  return state.zenodoRecoveredZenodoPayloadHash ?? state.zenodoPayloadHash;
}

export function crossrefRelationFromPlan(plan: SyncPlan): CrossrefRelation | undefined {
  if (!('operations' in plan)) return undefined;
  const operation = plan.operations.find((candidate) => candidate.type === 'crossref_redeposit' || candidate.type === 'crossref_verify_pending');
  if (operation?.type === 'crossref_redeposit' || operation?.type === 'crossref_verify_pending') return operation.relation;
  return undefined;
}

export function buildCrossrefZenodoRelation(state: ExternalSyncState | undefined, crossrefDoi: string): CrossrefRelation | undefined {
  const versionDoi = state?.zenodoVersionDoi?.trim();
  if (!versionDoi) return undefined;
  if (normalizeDoi(versionDoi) === normalizeDoi(crossrefDoi)) return undefined;

  return {
    type: 'isSupplementedBy',
    identifierType: 'doi',
    identifier: versionDoi,
    description: 'Archived file package'
  };
}

function planJournaledDraftPublish(state: ExternalSyncState | undefined, hashes: SyncHashes): Extract<SyncOperation, { readonly type: 'zenodo_publish_journaled_draft' }> | null {
  const operationType = state?.zenodoJournaledDraftOperationType;
  const depositionId = state?.zenodoJournaledDraftDepositionId;
  const draftRecordId = state?.zenodoJournaledDraftRecordId;
  if (!operationType || !depositionId || !draftRecordId) return null;
  if (operationType === 'zenodo_draft_create' || operationType === 'zenodo_draft_update') return null;
  if (state.zenodoRecoveredZenodoPayloadHash !== hashes.zenodoPayloadHash) return null;
  if (operationType !== 'zenodo_metadata_update' && state.zenodoRecoveredFileManifestHash !== hashes.fileManifestHash) return null;

  return {
    type: 'zenodo_publish_journaled_draft',
    originalOperationType: operationType,
    depositionId,
    draftRecordId,
    ...(state.zenodoJournaledDraftParentId ? { parentId: state.zenodoJournaledDraftParentId } : {}),
    payloadHash: hashes.zenodoPayloadHash,
    ...(operationType === 'zenodo_metadata_update' ? {} : { fileManifestHash: hashes.fileManifestHash })
  };
}

function shouldPlanZoteroWriteback(input: PlanRecordSyncInput, state: ExternalSyncState | undefined): boolean {
  const identifiers = buildZoteroWritebackIdentifiers({
    crossrefDoi: input.record.crossrefDoi,
    zenodo: state?.zenodoLatestRecordId && state.zenodoParentId ? state : null
  });
  const writeback = planZoteroWriteback({
    itemVersion: input.zoteroItem.version,
    publicResourceUrl: input.resourceUrl,
    data: buildZoteroWritebackData(input.zoteroItem),
    identifiers
  });
  if (writeback.type !== 'noop') return true;

  return planZoteroIdentifierLinkReconciliation({
    parentItemKey: input.record.zoteroItemKey,
    children: input.zoteroChildren,
    identifiers,
    zenodoBaseUrl: input.zenodoBaseUrl ?? 'https://zenodo.org'
  }).length > 0;
}

function isDeletedZoteroItem(value: ZoteroParentItem['data']['deleted']): boolean {
  return value === true || value === 1;
}

function knownZenodoRecordId(record: DoiSyncRecord): string | null {
  const value = record.knownZenodoRecordId;
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === '0') return null;
  return trimmed;
}
