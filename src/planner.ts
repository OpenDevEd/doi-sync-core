import type { CrossrefRelation } from './crossref/xml.js';
import {
  mapCrossrefRecord,
  type CrossrefMappedRecord,
  type CrossrefRecordValidationIssue
} from './crossref/record-mapper.js';
import { asRecord, asString } from './guards.js';
import { changesZenodoVersionDoi } from './operations.js';
import type { JsonValue } from './hash.js';
import { normalizeDoi } from './doi.js';
import {
  buildPublicationFileManifestHash,
  type PublicationFileManifest
} from './publication/files.js';
import {
  zenodoFileCorrectionPublishDeadline,
  zenodoFileCorrectionStartDeadline,
  type ZenodoFileCorrectionApproval
} from './publication/file-corrections.js';
import type {
  PublicationIdentifiers,
  PublicationRecordSnapshot
} from './publication/record.js';
import type { ProviderSyncState } from './publication/state.js';
import {
  zenodoReusedDoi,
  type PublicationTargetPolicy
} from './publication/targets.js';
import {
  buildPublicationPayloadHash,
  buildPublicationPayloadSnapshots
} from './snapshots.js';
import type { PublicationPayloadSnapshots } from './snapshots.js';
import type { ZenodoPublishJournalOperationType } from './zenodo/journal.js';
import {
  validateZenodoPublicationRecord,
  type ZenodoRecordValidationIssue
} from './zenodo/publication-mapper.js';

export type { ZenodoRecordValidationIssue } from './zenodo/publication-mapper.js';

export interface PlanPublicationSyncInput {
  readonly observedAt: Date;
  readonly record: PublicationRecordSnapshot;
  readonly files: PublicationFileManifest;
  readonly identifiers: PublicationIdentifiers;
  readonly targets: PublicationTargetPolicy;
  readonly state?: ProviderSyncState;
  readonly zenodoFileChangeApproval?: ZenodoFileCorrectionApproval;
}

export type PublicationSyncOperation =
  | {
      readonly type: 'crossref_redeposit';
      readonly payloadHash: string;
      readonly relation?: CrossrefRelation;
      readonly clearRelations?: true;
    }
  | {
      readonly type: 'crossref_verify_pending';
      readonly stage: 'relation_clear' | 'deposit';
      readonly payloadHash: string;
      readonly relation?: CrossrefRelation;
    }
  | { readonly type: 'zenodo_create'; readonly draftDepositionId?: string; readonly payloadHash: string; readonly fileManifestHash: string }
  | {
      readonly type: 'zenodo_metadata_update';
      readonly latestRecordId: string;
      readonly payloadHash: string;
    }
  | {
      readonly type: 'zenodo_file_update';
      readonly latestRecordId: string;
      readonly payloadHash: string;
      readonly fileManifestHash: string;
      readonly removedFileKeys: readonly string[];
      readonly approval: ZenodoFileCorrectionApproval;
      readonly publishBy: Date;
    }
  | {
      readonly type: 'zenodo_new_version';
      readonly latestRecordId: string;
      readonly payloadHash: string;
      readonly fileManifestHash: string;
      readonly removedFileKeys: readonly string[];
    }
  | {
      readonly type: 'zenodo_discard_preparing_draft';
      readonly originalOperationType: ZenodoPublishJournalOperationType;
      readonly depositionId: string;
      readonly draftRecordId: string;
    }
  | {
      readonly type: 'zenodo_cleanup_orphan_draft';
      readonly depositionId: string;
    }
  | {
      readonly type: 'zenodo_discard_expired_file_correction';
      readonly originalOperationType: 'zenodo_file_update';
      readonly depositionId: string;
      readonly draftRecordId: string;
      readonly reason: 'deadline_expired' | 'deadline_missing' | 'approval_missing';
    }
  | {
      readonly type: 'zenodo_publish_journaled_draft';
      readonly originalOperationType: ZenodoPublishJournalOperationType;
      readonly depositionId: string;
      readonly draftRecordId: string;
      readonly parentId?: string;
      readonly payloadHash: string;
      readonly fileManifestHash?: string;
      readonly fileCorrectionApproval?: ZenodoFileCorrectionApproval;
      readonly publishBy?: Date;
    };

export interface PublicationSyncHashes {
  readonly crossrefPayloadHash?: string;
  readonly zenodoPayloadHash?: string;
  readonly fileManifestHash: string;
}

interface PublicationActionablePlan {
	readonly record: PublicationRecordSnapshot;
	readonly files: PublicationFileManifest;
	readonly hashes: PublicationSyncHashes;
	readonly snapshots: PublicationPayloadSnapshots;
	readonly identifiers: PublicationIdentifiers;
	readonly targets: PublicationTargetPolicy;
	readonly crossrefRecord?: CrossrefMappedRecord;
	readonly waitingForFile?: boolean;
}

export type PublicationSyncPlan =
  | {
      readonly status: 'skipped';
      readonly reason: 'TARGETS_DISABLED';
      readonly operations: readonly [];
    }
  | {
      readonly status: 'needs_attention';
      readonly provider: 'crossref' | 'zenodo';
      readonly reason:
        | 'MISSING_MANAGED_CROSSREF_DOI'
        | 'MISSING_EXTERNAL_DOI'
        | 'MISSING_ZENODO_PROVIDER_RECORD_ID'
        | 'CROSSREF_VALIDATION_FAILED'
        | 'ZENODO_VALIDATION_FAILED'
        | 'ZENODO_IDENTIFIER_POLICY_IMMUTABLE'
        | 'ZENODO_FIRST_PUBLICATION_TIME_REQUIRED'
        | 'ZENODO_FILE_CORRECTION_APPROVAL_REQUIRED'
        | 'ZENODO_FILE_CORRECTION_WINDOW_CLOSED';
      readonly issues?: readonly (CrossrefRecordValidationIssue | ZenodoRecordValidationIssue)[];
      readonly operations: readonly [];
    }
  | {
      readonly status: 'waiting_for_file';
      readonly provider: 'zenodo';
      readonly operations: readonly [];
      readonly record: PublicationRecordSnapshot;
      readonly files: PublicationFileManifest;
      readonly hashes: PublicationSyncHashes;
      readonly snapshots: PublicationPayloadSnapshots;
      readonly identifiers: PublicationIdentifiers;
      readonly targets: PublicationTargetPolicy;
    }
  | (PublicationActionablePlan & {
      readonly status: 'noop';
      readonly operations: readonly [];
    })
  | (PublicationActionablePlan & {
      readonly status: 'write_required';
      readonly operations: readonly PublicationSyncOperation[];
    });

export function planPublicationSync(input: PlanPublicationSyncInput): PublicationSyncPlan {
  const { crossref, zenodo } = input.targets;
  if (!crossref.enabled && !zenodo.enabled) {
    return { status: 'skipped', reason: 'TARGETS_DISABLED', operations: [] };
  }

  const identifiers = normalizePublicationIdentifiers(input.identifiers);
  const managedCrossrefDoi = identifiers.managedCrossrefDoi;
  if (
    (crossref.enabled || (zenodo.enabled && zenodo.identifierPolicy === 'reuse-crossref'))
    && !managedCrossrefDoi
  ) {
    return {
      status: 'needs_attention',
      provider: crossref.enabled ? 'crossref' : 'zenodo',
      reason: 'MISSING_MANAGED_CROSSREF_DOI',
      operations: []
    };
  }

  if (zenodo.enabled && zenodo.identifierPolicy === 'reuse-external' && !identifiers.bibliographicDoi) {
    return {
      status: 'needs_attention',
      provider: 'zenodo',
      reason: 'MISSING_EXTERNAL_DOI',
      operations: []
    };
  }

  const crossrefMapping = crossref.enabled && managedCrossrefDoi
    ? mapCrossrefRecord(input.record, managedCrossrefDoi)
    : undefined;
  if (crossrefMapping && !crossrefMapping.ok) {
    return {
      status: 'needs_attention',
      provider: 'crossref',
      reason: 'CROSSREF_VALIDATION_FAILED',
      issues: crossrefMapping.issues,
      operations: []
    };
  }
  const crossrefRecord = crossrefMapping?.ok ? crossrefMapping.record : undefined;
  const zenodoIssues = zenodo.enabled ? validateZenodoPublicationRecord(input.record) : [];
  if (zenodoIssues.length > 0) {
    return {
      status: 'needs_attention',
      provider: 'zenodo',
      reason: 'ZENODO_VALIDATION_FAILED',
      issues: zenodoIssues,
      operations: []
    };
  }

  const crossrefState = crossref.enabled
    && input.state?.crossref?.environment === crossref.environment
    ? input.state.crossref
    : undefined;
  const zenodoState = zenodo.enabled
    && input.state?.zenodo?.environment === zenodo.environment
    ? input.state.zenodo
    : undefined;
  if (zenodo.enabled && zenodoState && zenodoState.identifierPolicy !== zenodo.identifierPolicy) {
    return {
      status: 'needs_attention',
      provider: 'zenodo',
      reason: 'ZENODO_IDENTIFIER_POLICY_IMMUTABLE',
      operations: []
    };
  }
  if (
    zenodo.enabled
    && !zenodoState?.identifiers
    && !zenodoState?.journal
    && (identifiers.zenodoVersionDoi || identifiers.zenodoConceptDoi)
  ) {
    return {
      status: 'needs_attention',
      provider: 'zenodo',
      reason: 'MISSING_ZENODO_PROVIDER_RECORD_ID',
      operations: []
    };
  }

  const zenodoVersionDoi = zenodoState?.identifiers
    ? zenodoState.identifiers.versionDoi
    : identifiers.zenodoVersionDoi;
  const relation = crossref.enabled
    && zenodo.enabled
    && zenodo.identifierPolicy === 'mint-zenodo'
    && zenodoVersionDoi
    ? {
        type: 'isSupplementedBy' as const,
        identifierType: 'doi' as const,
        identifier: zenodoVersionDoi,
        description: 'Archived file package'
      }
    : undefined;
  const crossrefIdentifiers: PublicationIdentifiers = managedCrossrefDoi
    ? { managedCrossrefDoi }
    : {};
  const snapshots = buildPublicationPayloadSnapshots({
    ...(crossref.enabled ? { crossref: {
      record: requireCrossrefRecord(crossrefRecord),
      ...(relation ? { relation } : {})
    } } : {}),
    ...(zenodo.enabled ? { zenodo: {
      record: input.record,
      identifiers: zenodo.identifierPolicy === 'reuse-crossref'
        ? crossrefIdentifiers
        : zenodo.identifierPolicy === 'reuse-external' && identifiers.bibliographicDoi
          ? { bibliographicDoi: identifiers.bibliographicDoi }
          : {},
      identifierPolicy: zenodo.identifierPolicy
    } } : {}),
    files: input.files
  });
  const hashes: PublicationSyncHashes = {
    ...(snapshots.crossrefPayload
      ? { crossrefPayloadHash: buildPublicationPayloadHash(snapshots.crossrefPayload) }
      : {}),
    ...(snapshots.zenodoPayload
      ? { zenodoPayloadHash: buildPublicationPayloadHash(snapshots.zenodoPayload) }
      : {}),
    fileManifestHash: buildPublicationFileManifestHash(input.files)
  };
  const hasZenodoRecoveryWork = Boolean(zenodoState?.journal || zenodoState?.orphanDraftCleanup);
  const waitingForFile = zenodo.enabled
    && input.files.files.length === 0
    && !hasZenodoRecoveryWork;
  const zenodoApprovalDoi = zenodo.enabled
    ? zenodoReusedDoi(zenodo.identifierPolicy, identifiers)
    : undefined;
  const zenodoPlanning = waitingForFile
    ? { operations: [] as const }
    : planZenodoPublicationOperations(input, hashes, zenodoState, zenodoApprovalDoi);
  if ('issue' in zenodoPlanning) {
    return {
      status: 'needs_attention',
      provider: 'zenodo',
      reason: zenodoPlanning.issue,
      operations: []
    };
  }
  const zenodoOperations = zenodoPlanning.operations;
  const crossrefOperations = planCrossrefPublicationOperations(
    input,
    hashes,
    relation,
    zenodoOperations,
    crossrefState
  );
  const operations = [...crossrefOperations, ...zenodoOperations];

  if (operations.length === 0 && waitingForFile) {
    return {
      status: 'waiting_for_file',
      provider: 'zenodo',
      operations: [],
      record: input.record,
      files: input.files,
      hashes,
      snapshots,
      identifiers,
      targets: input.targets
    };
  }

  const actionablePlan = {
    record: input.record,
    files: input.files,
    hashes,
    snapshots,
    identifiers,
    targets: input.targets,
    ...(crossrefRecord ? { crossrefRecord } : {}),
    ...(waitingForFile ? { waitingForFile: true as const } : {})
  };
  return operations.length > 0
    ? { ...actionablePlan, status: 'write_required', operations }
    : { ...actionablePlan, status: 'noop', operations: [] };
}

function normalizePublicationIdentifiers(input: PublicationIdentifiers): PublicationIdentifiers {
  const bibliographicDoi = normalizeDoi(input.bibliographicDoi);
  const managedCrossrefDoi = normalizeDoi(input.managedCrossrefDoi);
  const zenodoVersionDoi = normalizeDoi(input.zenodoVersionDoi);
  const zenodoConceptDoi = normalizeDoi(input.zenodoConceptDoi);
  return {
    ...(bibliographicDoi ? { bibliographicDoi } : {}),
    ...(managedCrossrefDoi ? { managedCrossrefDoi } : {}),
    ...(zenodoVersionDoi ? { zenodoVersionDoi } : {}),
    ...(zenodoConceptDoi ? { zenodoConceptDoi } : {})
  };
}

function requireCrossrefRecord(record: CrossrefMappedRecord | undefined): CrossrefMappedRecord {
  if (!record) throw new Error('Crossref mapping is required for an enabled Crossref target');
  return record;
}

function planCrossrefPublicationOperations(
  input: PlanPublicationSyncInput,
  hashes: PublicationSyncHashes,
  relation: CrossrefRelation | undefined,
  zenodoOperations: readonly PublicationSyncOperation[],
  state: ProviderSyncState['crossref'] | undefined
): readonly PublicationSyncOperation[] {
  if (!input.targets.crossref.enabled || !hashes.crossrefPayloadHash) return [];
  if (
    input.targets.zenodo.enabled
    && input.targets.zenodo.identifierPolicy === 'mint-zenodo'
    && zenodoOperations.some(changesZenodoVersionDoi)
  ) return [];
  if (state?.lastSuccess?.payloadHash === hashes.crossrefPayloadHash) return [];
  if (state?.pending?.payloadHash === hashes.crossrefPayloadHash) {
    return [{
      type: 'crossref_verify_pending',
      stage: state.pending.stage,
      payloadHash: hashes.crossrefPayloadHash,
      ...(relation ? { relation } : {})
    }];
  }
  return [{
    type: 'crossref_redeposit',
    payloadHash: hashes.crossrefPayloadHash,
    ...(relation || asRecord(state?.lastSuccess?.payloadSnapshot)?.['relation']
      ? { clearRelations: true as const }
      : {}),
    ...(relation ? { relation } : {})
  }];
}

function planZenodoPublicationOperations(
  input: PlanPublicationSyncInput,
  hashes: PublicationSyncHashes,
  state: ProviderSyncState['zenodo'] | undefined,
  approvalDoi: string | undefined
): { readonly operations: readonly PublicationSyncOperation[] } | {
  readonly issue:
    | 'ZENODO_FIRST_PUBLICATION_TIME_REQUIRED'
    | 'ZENODO_FILE_CORRECTION_APPROVAL_REQUIRED'
    | 'ZENODO_FILE_CORRECTION_WINDOW_CLOSED';
} {
  if (!input.targets.zenodo.enabled || !hashes.zenodoPayloadHash) return { operations: [] };
  if (state?.orphanDraftCleanup) {
    return { operations: [{
      type: 'zenodo_cleanup_orphan_draft',
      depositionId: state.orphanDraftCleanup.depositionId
    }] };
  }
  if (state?.journal?.status === 'preparing') {
    return { operations: [{
      type: 'zenodo_discard_preparing_draft',
      originalOperationType: state.journal.operationType,
      depositionId: state.journal.depositionId,
      draftRecordId: state.journal.draftRecordId
    }] };
  }
  if (state?.journal) {
    if (state.journal.operationType === 'zenodo_file_update') {
      const reason = !state.firstPublishedAt
        ? 'deadline_missing' as const
        : !isValidZenodoFileCorrectionApproval({
            approval: state.journal.fileCorrectionApproval,
            recordKey: input.record.recordKey,
            approvalDoi,
            fileManifestHash: state.journal.fileManifestHash,
            firstPublishedAt: state.firstPublishedAt,
            observedAt: input.observedAt,
            consumedApprovalIds: state.consumedFileCorrectionApprovalIds ?? []
          })
          ? 'approval_missing' as const
          : input.observedAt > zenodoFileCorrectionPublishDeadline(state.firstPublishedAt)
            ? 'deadline_expired' as const
            : undefined;
      if (reason) return { operations: [{
        type: 'zenodo_discard_expired_file_correction',
        originalOperationType: 'zenodo_file_update',
        depositionId: state.journal.depositionId,
        draftRecordId: state.journal.draftRecordId,
        reason
      }] };
    }
    return { operations: [{
      type: 'zenodo_publish_journaled_draft',
      originalOperationType: state.journal.operationType,
      depositionId: state.journal.depositionId,
      draftRecordId: state.journal.draftRecordId,
      ...(state.journal.parentId ? { parentId: state.journal.parentId } : {}),
      payloadHash: state.journal.payloadHash,
      ...(state.journal.fileManifestHash
        ? { fileManifestHash: state.journal.fileManifestHash }
        : {}),
      ...(state.journal.fileCorrectionApproval
        ? { fileCorrectionApproval: state.journal.fileCorrectionApproval }
        : {}),
      ...(state.journal.operationType === 'zenodo_file_update' && state.firstPublishedAt
        ? { publishBy: zenodoFileCorrectionPublishDeadline(state.firstPublishedAt) }
        : {})
    }] };
  }
  if (!state?.identifiers?.latestRecordId) {
    return { operations: [{
      type: 'zenodo_create',
      ...(state?.unpublishedDraft ? {draftDepositionId: state.unpublishedDraft.depositionId} : {}),
      payloadHash: hashes.zenodoPayloadHash,
      fileManifestHash: hashes.fileManifestHash
    }] };
  }

  const metadataChanged = state.lastSuccess?.payloadHash !== hashes.zenodoPayloadHash;
  const filesChanged = state.lastSuccess?.fileManifestHash !== hashes.fileManifestHash;
  if (!metadataChanged && !filesChanged) return { operations: [] };
  const removedFileKeys = removedPublicationFileKeys(
    state.lastSuccess?.fileManifestSnapshot,
    input.files
  );

  if (filesChanged && input.targets.zenodo.identifierPolicy === 'mint-zenodo') {
    return { operations: [{
      type: 'zenodo_new_version',
      latestRecordId: state.identifiers.latestRecordId,
      payloadHash: hashes.zenodoPayloadHash,
      fileManifestHash: hashes.fileManifestHash,
      removedFileKeys
    }] };
  }

  if (filesChanged) {
    if (!state.firstPublishedAt) return { issue: 'ZENODO_FIRST_PUBLICATION_TIME_REQUIRED' };
    const approval = input.zenodoFileChangeApproval;
    const startDeadline = zenodoFileCorrectionStartDeadline(state.firstPublishedAt);
    const validApproval = isValidZenodoFileCorrectionApproval({
      approval,
      recordKey: input.record.recordKey,
      approvalDoi,
      fileManifestHash: hashes.fileManifestHash,
      firstPublishedAt: state.firstPublishedAt,
      observedAt: input.observedAt,
      consumedApprovalIds: state.consumedFileCorrectionApprovalIds ?? []
    });
    if (!validApproval && input.observedAt > startDeadline) {
      return { issue: 'ZENODO_FILE_CORRECTION_WINDOW_CLOSED' };
    }
    if (!validApproval) return { issue: 'ZENODO_FILE_CORRECTION_APPROVAL_REQUIRED' };
    return { operations: [
      ...(metadataChanged
        ? [{
            type: 'zenodo_metadata_update' as const,
            latestRecordId: state.identifiers.latestRecordId,
            payloadHash: hashes.zenodoPayloadHash
          }]
        : []),
      {
        type: 'zenodo_file_update',
        latestRecordId: state.identifiers.latestRecordId,
        payloadHash: hashes.zenodoPayloadHash,
        fileManifestHash: hashes.fileManifestHash,
        removedFileKeys,
        approval: approval as ZenodoFileCorrectionApproval,
        publishBy: zenodoFileCorrectionPublishDeadline(state.firstPublishedAt)
      }
    ] };
  }

  return { operations: metadataChanged ? [{
    type: 'zenodo_metadata_update',
    latestRecordId: state.identifiers.latestRecordId,
    payloadHash: hashes.zenodoPayloadHash
  }] : [] };
}

function isValidZenodoFileCorrectionApproval(input: {
  readonly approval: ZenodoFileCorrectionApproval | undefined;
  readonly recordKey: string;
  readonly approvalDoi: string | undefined;
  readonly fileManifestHash: string | undefined;
  readonly firstPublishedAt: Date;
  readonly observedAt: Date;
  readonly consumedApprovalIds: readonly string[];
}): input is typeof input & { readonly approval: ZenodoFileCorrectionApproval } {
  const approval = input.approval;
  if (!approval || !input.approvalDoi || !input.fileManifestHash) return false;
  const startDeadline = zenodoFileCorrectionStartDeadline(input.firstPublishedAt);
  return approval.kind === 'minor_correction'
    && approval.recordKey === input.recordKey
    && normalizeDoi(approval.doi) === input.approvalDoi
    && approval.fileManifestHash === input.fileManifestHash
    && approval.approvedAt >= input.firstPublishedAt
    && approval.approvedAt <= startDeadline
    && approval.approvedAt <= input.observedAt
    && !input.consumedApprovalIds.includes(approval.id);
}

function removedPublicationFileKeys(
  previousSnapshot: JsonValue | undefined,
  current: PublicationFileManifest
): readonly string[] {
  const previous = asRecord(previousSnapshot)?.['files'];
  if (!Array.isArray(previous)) return [];
  const currentKeys = new Set(current.files.map(({ fileKey }) => fileKey));
  return previous.flatMap((entry) => {
    const key = asString(asRecord(entry)?.['fileKey']);
    return key && !currentKeys.has(key) ? [key] : [];
  });
}
