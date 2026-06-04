import type {
  CrossrefDepositOutcome,
  CrossrefReportPaperDepositInput,
  CrossrefReportPaperVerifyInput,
  CrossrefXmlApiVerification
} from '../crossref/client.js';
import type { CrossrefDepositRelation } from '../crossref/xml.js';
import type { CrossrefEnvironment } from '../crossref/deposit.js';
import { crossrefDepositTimestamp } from '../crossref/timestamp.js';
import type { FileManifestEntry, ZoteroChildItem } from '../files.js';
import type { CanonicalMetadataSnapshot, ZoteroParentItem } from '../metadata.js';
import { isZenodoFileOperation, isZenodoOperation, requiresZenodoRecordId, type ZenodoRecordIdRequiredOperation, type ZenodoSyncOperation } from '../operations.js';
import type { ExternalSyncState, DoiSyncRecord, SyncOperation, SyncPlan } from '../planner.js';
import type { SyncOperationResult, ZenodoOrphanDraftCleanup, ZenodoSettlementIdentifiers } from '../settlement.js';
import type { MarkZenodoPublishDraftPublishedInput, ProviderStateEnvironment, RecordZenodoPublishDraftInput, ZenodoPreparedDraft, ZenodoPublishJournalOperationType } from '../zenodo/journal.js';
import { effectiveZenodoDoiPolicy } from '../zenodo/doi-policy.js';
import type { DoiPolicy, ZenodoDoiLookupResult, ZenodoRecordIdentifiers, ZenodoUnsubmittedDraftDoiLookupResult } from '../zenodo/records.js';
import { ProviderHttpError } from '../resilience/errors.js';
import { buildZoteroGroupSelectUrl } from '../zotero/select-link.js';
import type { AddTagsToZoteroItemInput, ApplyManagedZoteroWritebackInput, CreateLinkedUrlAttachmentInput, DeleteZoteroItemInput, DownloadAttachmentFileInput, DownloadedAttachmentFile, PatchLinkedUrlAttachmentInput } from '../zotero/client.js';
import { planZoteroIdentifierLinkReconciliation } from '../zotero/identifier-links.js';
import { planZoteroSuccessTagApplications } from '../zotero/success-tags.js';
import { buildZoteroWritebackData, buildZoteroWritebackIdentifiers } from '../zotero/writeback.js';

type ActionableSyncPlan = Extract<SyncPlan, { readonly operations: readonly SyncOperation[] }>;
type WriteRequiredSyncPlan = ActionableSyncPlan & { readonly status: 'write_required' };

export interface CrossrefReportPaperDepositor {
  readonly submitReportPaper: (input: CrossrefReportPaperDepositInput) => Promise<CrossrefDepositOutcome>;
  readonly verifyReportPaper: (input: CrossrefReportPaperVerifyInput) => Promise<CrossrefXmlApiVerification>;
}

export interface RecordCrossrefPendingDepositInput {
  readonly recordId: string;
  readonly environment: ProviderStateEnvironment;
  readonly payloadHash: string;
  readonly batchId: string;
  readonly filename: string;
  readonly submittedAt: Date;
  readonly pendingReason: string;
}

export interface CrossrefSubmissionJournalWriter {
  readonly recordCrossrefPendingDeposit: (input: RecordCrossrefPendingDepositInput) => Promise<void>;
}

export interface ZenodoWriter {
  readonly findRecordByDoi?: (input: {
    readonly token: string;
    readonly doi: string;
  }) => Promise<ZenodoDoiLookupResult>;
  readonly findDraftByDoi?: (input: {
    readonly token: string;
    readonly doi: string;
  }) => Promise<ZenodoUnsubmittedDraftDoiLookupResult>;
  readonly deleteUnpublishedDraft?: (input: {
    readonly token: string;
    readonly depositionId: string;
  }) => Promise<void>;
  readonly prepareCreateRecord: (input: {
    readonly token: string;
    readonly doiPolicy: DoiPolicy;
    readonly metadata: CanonicalMetadataSnapshot;
    readonly files: readonly ZenodoLiveUploadFile[];
    readonly zoteroSelectUrl?: string;
    readonly resourceUrl?: string;
    readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
  }) => Promise<ZenodoPreparedDraft>;
  readonly prepareAdoptLegacyDeposition: (input: {
    readonly token: string;
    readonly depositionId: string;
    readonly doiPolicy: DoiPolicy;
    readonly metadata: CanonicalMetadataSnapshot;
    readonly files: readonly ZenodoLiveUploadFile[];
    readonly zoteroSelectUrl?: string;
    readonly resourceUrl?: string;
    readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
  }) => Promise<ZenodoPreparedDraft>;
  readonly prepareUpdateRecordMetadata: (input: {
    readonly token: string;
    readonly latestRecordId: string;
    readonly doiPolicy: DoiPolicy;
    readonly metadata: CanonicalMetadataSnapshot;
    readonly zoteroSelectUrl?: string;
    readonly resourceUrl?: string;
    readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
  }) => Promise<ZenodoPreparedDraft>;
  readonly prepareUpdateRecordFiles: (input: {
    readonly token: string;
    readonly latestRecordId: string;
    readonly doiPolicy: DoiPolicy;
    readonly metadata: CanonicalMetadataSnapshot;
    readonly files: readonly ZenodoLiveUploadFile[];
    readonly zoteroSelectUrl?: string;
    readonly resourceUrl?: string;
    readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
  }) => Promise<ZenodoPreparedDraft>;
  readonly prepareNewVersion: (input: {
    readonly token: string;
    readonly latestRecordId: string;
    readonly doiPolicy: DoiPolicy;
    readonly metadata: CanonicalMetadataSnapshot;
    readonly files: readonly ZenodoLiveUploadFile[];
    readonly zoteroSelectUrl?: string;
    readonly resourceUrl?: string;
    readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
  }) => Promise<ZenodoPreparedDraft>;
  readonly publishDraft: (input: {
    readonly token: string;
    readonly draft: ZenodoPreparedDraft;
  }) => Promise<ZenodoRecordIdentifiers>;
}

export interface ZoteroWriter {
  readonly downloadAttachmentFile: (input: DownloadAttachmentFileInput) => Promise<DownloadedAttachmentFile>;
  readonly applyManagedWriteback: (input: ApplyManagedZoteroWritebackInput) => Promise<void>;
  readonly createLinkedUrlAttachment: (input: CreateLinkedUrlAttachmentInput) => Promise<{ readonly key: string }>;
  readonly patchLinkedUrlAttachment: (input: PatchLinkedUrlAttachmentInput) => Promise<void>;
  readonly deleteItem: (input: DeleteZoteroItemInput) => Promise<void>;
  readonly addTagsToItem?: (input: AddTagsToZoteroItemInput) => Promise<void>;
}

export interface ZenodoLiveUploadFile {
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ProviderExecutionCredentials {
  readonly zoteroGroupId: string;
  readonly zoteroApiKey: string;
  readonly zenodoToken: string;
}

export interface ProviderExecutionContext {
  readonly record: DoiSyncRecord;
  readonly credentials: ProviderExecutionCredentials;
  readonly syncState?: ExternalSyncState;
}

export interface LiveExecutorCrossrefConfig {
  readonly environment: CrossrefEnvironment;
  readonly loginId: string;
  readonly password: string;
  readonly depositorName: string;
  readonly emailAddress: string;
  readonly registrant: string;
  readonly batchIdPrefix?: string;
}

export interface ExecuteLiveSyncPlanInput {
  readonly context: ProviderExecutionContext;
  readonly plan: SyncPlan;
  readonly resourceUrl: string;
  readonly zoteroParent: ZoteroParentItem;
  readonly zoteroChildren: readonly ZoteroChildItem[];
  readonly providers: {
    readonly crossref: CrossrefReportPaperDepositor;
    readonly zenodo: ZenodoWriter;
    readonly zotero: ZoteroWriter;
  };
  readonly crossref: LiveExecutorCrossrefConfig;
  readonly providerStateEnvironment: ProviderStateEnvironment;
  readonly crossrefJournal?: CrossrefSubmissionJournalWriter;
  readonly zenodoJournal?: ZenodoPublishJournalWriter;
  readonly doiPolicy: DoiPolicy;
  readonly zenodoBaseUrl: string;
  readonly zoteroWritebackEnabled: boolean;
  readonly now?: () => Date;
}

export interface ZenodoPublishJournalWriter {
  readonly recordZenodoPublishDraft: (input: RecordZenodoPublishDraftInput) => Promise<void>;
  readonly markZenodoPublishDraftPublished: (input: MarkZenodoPublishDraftPublishedInput) => Promise<void>;
}

/** Executes a write-required sync plan against Crossref, Zenodo, and optional Zotero writeback ports. */
export async function executeLiveSyncPlan(input: ExecuteLiveSyncPlanInput): Promise<readonly SyncOperationResult[]> {
  const plan = input.plan;
  if (!isWriteRequiredSyncPlan(plan)) return [];
  const writePlan = plan;

  const results: SyncOperationResult[] = [];
  let latestZenodo = identifiersFromState(input.context);
  let zenodoSubmitted = Boolean(latestZenodo?.latestRecordId);
  const uploadedAttachmentKeys = new Set<string>();

  for (const operation of writePlan.operations) {
    if (operation.type === 'crossref_redeposit') {
      results.push(await executeCrossrefOperation(input, writePlan, operation));
      continue;
    }

    if (operation.type === 'crossref_verify_pending') {
      results.push(await executeCrossrefPendingVerificationOperation(input, writePlan, operation));
      continue;
    }

    if (isZenodoOperation(operation)) {
      const result = await executeZenodoOperation(input, writePlan, operation, latestZenodo);
      // Only a succeeded result updates the identifiers, so latestZenodo always stays last-known-good.
      latestZenodo = mergeZenodoIdentifiers(latestZenodo, result);
      if (result.status === 'succeeded' && publishesZenodoRecord(operation)) zenodoSubmitted = true;
      if (result.status === 'succeeded' && isZenodoFileOperation(operation)) {
        for (const file of writePlan.fileManifest.files) {
          uploadedAttachmentKeys.add(file.zoteroAttachmentKey);
        }
      }
      results.push(result);
      continue;
    }

    if (operation.type === 'zotero_writeback') {
      if (!input.zoteroWritebackEnabled) {
        results.push(skipped(operation.type, 'ZOTERO_WRITEBACK_DISABLED'));
        continue;
      }
      // A failed Zenodo op does NOT block the writeback. It writes the canonical Crossref DOI and
      // reconciles links using last-known-good Zenodo identifiers (never identifiers from a failed
      // op); Zenodo-derived parts are simply absent until a Zenodo op succeeds.
      results.push(await executeZoteroWritebackOperation(input, latestZenodo, {
        zenodoSubmitted,
        uploadedAttachmentKeys: [...uploadedAttachmentKeys]
      }));
      continue;
    }

  }

  return results;
}

function publishesZenodoRecord(operation: ZenodoSyncOperation): boolean {
  return operation.type !== 'zenodo_draft_create' && operation.type !== 'zenodo_draft_update';
}

function isWriteRequiredSyncPlan(plan: SyncPlan): plan is WriteRequiredSyncPlan {
  return plan.status === 'write_required';
}

async function executeZenodoOperation(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  operation: ZenodoSyncOperation,
  latestZenodo: ZenodoSettlementIdentifiers | null
): Promise<SyncOperationResult> {
  if (operation.type === 'zenodo_publish_journaled_draft') {
    return executeJournaledDraftPublishOperation(input, operation);
  }

  if (operation.type === 'zenodo_draft_create') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeUnpublishedZenodoDraftOperation(input, operation, () => (
      input.providers.zenodo.prepareCreateRecord({
        token: input.context.credentials.zenodoToken,
        doiPolicy: input.doiPolicy,
        metadata: plan.metadata,
        files: [],
        zoteroSelectUrl: zenodoBackLinkUrl(input),
        resourceUrl: input.resourceUrl,
        onPreparedDraft
      })
    ));
  }

  if (operation.type === 'zenodo_draft_update') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeUnpublishedZenodoDraftOperation(input, operation, () => (
      input.providers.zenodo.prepareAdoptLegacyDeposition({
        token: input.context.credentials.zenodoToken,
        depositionId: operation.depositionId,
        doiPolicy: input.doiPolicy,
        metadata: plan.metadata,
        files: [],
        zoteroSelectUrl: zenodoBackLinkUrl(input),
        resourceUrl: input.resourceUrl,
        onPreparedDraft
      })
    ));
  }

  if (operation.type === 'zenodo_create') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeJournaledZenodoOperation(input, operation, {
      prepare: () => prepareCreateRecordWithFiles(input, plan, onPreparedDraft),
      publish: publishZenodoDraft(input)
    });
  }

  if (operation.type === 'zenodo_legacy_deposition_adopt') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeJournaledZenodoOperation(input, operation, {
      prepare: () => prepareAdoptLegacyDepositionWithFiles(input, plan, operation.depositionId, onPreparedDraft),
      publish: publishZenodoDraft(input)
    });
  }

  const latestRecordId = latestZenodo?.latestRecordId;
  if (requiresZenodoRecordId(operation) && !latestRecordId) {
    return missingZenodoRecordResult(operation);
  }
  if (!latestRecordId) {
    return failed(operation.type, 'ZENODO_MISSING_RECORD', 'Cannot update Zenodo without a latest record id');
  }

  if (operation.type === 'zenodo_metadata_update') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeJournaledZenodoOperation(input, operation, {
      prepare: () => input.providers.zenodo.prepareUpdateRecordMetadata({
        token: input.context.credentials.zenodoToken,
        latestRecordId,
        doiPolicy: existingRecordZenodoDoiPolicy(input, latestZenodo),
        metadata: plan.metadata,
        zoteroSelectUrl: zenodoBackLinkUrl(input),
        resourceUrl: input.resourceUrl,
        onPreparedDraft
      }),
      publish: publishZenodoDraft(input)
    });
  }

  if (operation.type === 'zenodo_file_update') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeJournaledZenodoOperation(input, operation, {
      prepare: () => prepareUpdateRecordFiles(input, plan, latestRecordId, latestZenodo, onPreparedDraft),
      publish: publishZenodoDraft(input)
    });
  }

  if (operation.type === 'zenodo_new_version') {
    const onPreparedDraft = journalPreparingZenodoDraft(input, operation);
    return executeJournaledZenodoOperation(input, operation, {
      prepare: () => prepareNewVersionWithFiles(input, plan, latestRecordId, latestZenodo, onPreparedDraft),
      publish: publishZenodoDraft(input)
    });
  }

  return unreachableZenodoOperation(operation);
}

function missingZenodoRecordResult(operation: ZenodoRecordIdRequiredOperation): SyncOperationResult {
  if (operation.type === 'zenodo_metadata_update') {
    return failed(operation.type, 'ZENODO_MISSING_RECORD', 'Cannot update Zenodo metadata without a latest record id');
  }
  if (operation.type === 'zenodo_file_update') {
    return failed(operation.type, 'ZENODO_MISSING_RECORD', 'Cannot update Zenodo files without a latest record id');
  }
  if (operation.type === 'zenodo_new_version') {
    return failed(operation.type, 'ZENODO_MISSING_RECORD', 'Cannot create a Zenodo version without a latest record id');
  }
  return unreachableZenodoOperation(operation);
}

function crossrefBatchIdPrefix(config: LiveExecutorCrossrefConfig): string {
  const prefix = config.batchIdPrefix?.trim() || 'doi-sync';
  return prefix.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function crossrefBatchId(input: ExecuteLiveSyncPlanInput, operation: Extract<SyncOperation, { readonly type: 'crossref_redeposit' }>): string {
  const stablePayload = operation.payloadHash.slice(0, 24);
  return [
    crossrefBatchIdPrefix(input.crossref),
    input.context.record.id,
    stablePayload
  ].map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-')).join('-');
}

function crossrefRelationDeleteBatchId(input: ExecuteLiveSyncPlanInput, operation: Extract<SyncOperation, { readonly type: 'crossref_redeposit' }>): string {
  return `${crossrefBatchId(input, operation)}-delete-relations`;
}

async function executeCrossrefOperation(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  operation: Extract<SyncOperation, { readonly type: 'crossref_redeposit' }>
): Promise<SyncOperationResult> {
  try {
    if (operation.relation) {
      const deleteOutcome = await submitCrossrefReportPaper(input, plan, operation, {
        relation: 'delete-all',
        batchId: crossrefRelationDeleteBatchId(input, operation)
      });
      if (deleteOutcome.status === 'failed') {
        return failed(operation.type, 'CROSSREF_FAILED', `Crossref submission ${deleteOutcome.filename} failed`);
      }
      if (deleteOutcome.status === 'pending' && !wasCrossrefSubmissionAccepted(deleteOutcome)) {
        return {
          type: operation.type,
          status: 'pending',
          pendingClass: 'CROSSREF_PENDING',
          pendingSummary: deleteOutcome.xmlVerification?.reason ?? `Crossref submission ${deleteOutcome.filename} is still pending`,
          crossref: {
            batchId: crossrefRelationDeleteBatchId(input, operation),
            filename: deleteOutcome.filename,
            submittedAt: input.now?.() ?? new Date()
          }
        };
      }
    }

    const outcome = await submitCrossrefReportPaper(input, plan, operation, {
      ...(operation.relation ? { relation: operation.relation } : {})
    });
    if (outcome.status === 'succeeded') return { type: operation.type, status: 'succeeded' };
    if (outcome.status === 'pending') {
      return {
        type: operation.type,
        status: 'pending',
        pendingClass: 'CROSSREF_PENDING',
        pendingSummary: outcome.xmlVerification?.reason ?? `Crossref submission ${outcome.filename} is still pending`,
        crossref: {
          batchId: crossrefBatchId(input, operation),
          filename: outcome.filename,
          submittedAt: input.now?.() ?? new Date()
        }
      };
    }
    return failed(operation.type, 'CROSSREF_FAILED', `Crossref submission ${outcome.filename} failed`);
  } catch (error) {
    return failedFromError(operation.type, error);
  }
}

function wasCrossrefSubmissionAccepted(outcome: CrossrefDepositOutcome): boolean {
  return outcome.status === 'succeeded' || outcome.diagnostic?.status === 'success';
}

async function submitCrossrefReportPaper(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  operation: Extract<SyncOperation, { readonly type: 'crossref_redeposit' }>,
  options: {
    readonly relation?: CrossrefDepositRelation;
    readonly batchId?: string;
  } = {}
): Promise<CrossrefDepositOutcome> {
    const now = input.now?.() ?? new Date();
    const batchId = options.batchId ?? crossrefBatchId(input, operation);
    const filename = `${batchId}.xml`;
    return input.providers.crossref.submitReportPaper({
      ...input.crossref,
      batchId,
      timestamp: crossrefDepositTimestamp(now),
      filename,
      metadata: plan.metadata,
      resourceUrl: input.resourceUrl,
      ...(options.relation ? { relation: options.relation } : {}),
      onSubmitted: () => input.crossrefJournal?.recordCrossrefPendingDeposit({
        recordId: input.context.record.id,
        environment: input.providerStateEnvironment,
        payloadHash: operation.payloadHash,
        batchId,
        filename,
        submittedAt: now,
        pendingReason: `Crossref submission ${filename} accepted; verification pending`
      }) ?? Promise.resolve()
    });
}

async function executeCrossrefPendingVerificationOperation(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  operation: Extract<SyncOperation, { readonly type: 'crossref_verify_pending' }>
): Promise<SyncOperationResult> {
  try {
    const verification = await input.providers.crossref.verifyReportPaper({
      environment: input.crossref.environment,
      emailAddress: input.crossref.emailAddress,
      metadata: plan.metadata,
      resourceUrl: input.resourceUrl,
      ...(operation.relation ? { relation: operation.relation } : {})
    });
    if (verification?.status === 'matched') return { type: operation.type, status: 'succeeded' };
    return {
      type: operation.type,
      status: 'pending',
      pendingClass: 'CROSSREF_PENDING',
      pendingSummary: verification?.reason ?? 'Crossref XML API metadata has not caught up'
    };
  } catch (error) {
    return failedFromError(operation.type, error);
  }
}

function zenodoBackLinkUrl(input: ExecuteLiveSyncPlanInput): string {
  return buildZoteroGroupSelectUrl({
    groupId: input.context.credentials.zoteroGroupId,
    itemKey: input.context.record.zoteroItemKey
  });
}

async function prepareCreateRecordWithFiles(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>
): Promise<ZenodoPreparedDraft> {
  const files = await downloadZenodoFiles(input.context.credentials, plan.fileManifest.files, input.providers.zotero);
  return input.providers.zenodo.prepareCreateRecord({
    token: input.context.credentials.zenodoToken,
    doiPolicy: input.doiPolicy,
    metadata: plan.metadata,
    files,
    zoteroSelectUrl: zenodoBackLinkUrl(input),
    resourceUrl: input.resourceUrl,
    ...(onPreparedDraft ? { onPreparedDraft } : {})
  });
}

async function prepareAdoptLegacyDepositionWithFiles(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  depositionId: string,
  onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>
): Promise<ZenodoPreparedDraft> {
  const files = await downloadZenodoFiles(input.context.credentials, plan.fileManifest.files, input.providers.zotero);
  return input.providers.zenodo.prepareAdoptLegacyDeposition({
    token: input.context.credentials.zenodoToken,
    depositionId,
    doiPolicy: input.doiPolicy,
    metadata: plan.metadata,
    files,
    zoteroSelectUrl: zenodoBackLinkUrl(input),
    resourceUrl: input.resourceUrl,
    ...(onPreparedDraft ? { onPreparedDraft } : {})
  });
}

async function prepareNewVersionWithFiles(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  latestRecordId: string,
  latestZenodo: ZenodoSettlementIdentifiers | null,
  onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>
): Promise<ZenodoPreparedDraft> {
  const files = await downloadZenodoFiles(input.context.credentials, plan.fileManifest.files, input.providers.zotero);
  return input.providers.zenodo.prepareNewVersion({
    token: input.context.credentials.zenodoToken,
    latestRecordId,
    doiPolicy: existingRecordZenodoDoiPolicy(input, latestZenodo),
    metadata: plan.metadata,
    files,
    zoteroSelectUrl: zenodoBackLinkUrl(input),
    resourceUrl: input.resourceUrl,
    ...(onPreparedDraft ? { onPreparedDraft } : {})
  });
}

async function prepareUpdateRecordFiles(
  input: ExecuteLiveSyncPlanInput,
  plan: WriteRequiredSyncPlan,
  latestRecordId: string,
  latestZenodo: ZenodoSettlementIdentifiers | null,
  onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>
): Promise<ZenodoPreparedDraft> {
  const files = await downloadZenodoFiles(input.context.credentials, plan.fileManifest.files, input.providers.zotero);
  return input.providers.zenodo.prepareUpdateRecordFiles({
    token: input.context.credentials.zenodoToken,
    latestRecordId,
    doiPolicy: existingRecordZenodoDoiPolicy(input, latestZenodo),
    metadata: plan.metadata,
    files,
    zoteroSelectUrl: zenodoBackLinkUrl(input),
    resourceUrl: input.resourceUrl,
    ...(onPreparedDraft ? { onPreparedDraft } : {})
  });
}

function existingRecordZenodoDoiPolicy(
  input: ExecuteLiveSyncPlanInput,
  latestZenodo: ZenodoSettlementIdentifiers | null
): DoiPolicy {
  return effectiveZenodoDoiPolicy({
    configuredPolicy: input.doiPolicy,
    crossrefDoi: input.context.record.crossrefDoi,
    existingVersionDoi: latestZenodo?.versionDoi ?? input.context.syncState?.zenodoVersionDoi
  });
}

function journalPreparingZenodoDraft(
  input: ExecuteLiveSyncPlanInput,
  operation: Extract<SyncOperation, { readonly type: ZenodoPublishJournalOperationType }>
): (draft: ZenodoPreparedDraft) => Promise<void> {
  return async (draft) => {
    await input.zenodoJournal?.recordZenodoPublishDraft({
      recordId: input.context.record.id,
      environment: input.providerStateEnvironment,
      operationType: operation.type,
      zenodoPayloadHash: operation.payloadHash,
      ...operationFileManifestHash(operation),
      depositionId: draft.depositionId,
      draftRecordId: draft.draftRecordId,
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      status: 'preparing',
      observedAt: input.now?.() ?? new Date()
    });
  };
}

function publishZenodoDraft(
  input: ExecuteLiveSyncPlanInput
): (draft: ZenodoPreparedDraft) => Promise<ZenodoRecordIdentifiers> {
  return (draft) => input.providers.zenodo.publishDraft({
    token: input.context.credentials.zenodoToken,
    draft
  });
}

async function executeUnpublishedZenodoDraftOperation(
  input: ExecuteLiveSyncPlanInput,
  operation: Extract<SyncOperation, { readonly type: 'zenodo_draft_create' | 'zenodo_draft_update' }>,
  prepare: () => Promise<ZenodoPreparedDraft>
): Promise<SyncOperationResult> {
  if (!input.zenodoJournal) {
    return failed(operation.type, 'ZENODO_JOURNAL_REQUIRED', 'Cannot create an unpublished Zenodo draft without journal storage');
  }

  let draft: ZenodoPreparedDraft;
  try {
    draft = await prepare();
  } catch (error) {
    return failedFromError(operation.type, error);
  }

  await input.zenodoJournal.recordZenodoPublishDraft({
    recordId: input.context.record.id,
    environment: input.providerStateEnvironment,
    operationType: operation.type,
    zenodoPayloadHash: operation.payloadHash,
    depositionId: draft.depositionId,
    draftRecordId: draft.draftRecordId,
    ...(draft.parentId ? { parentId: draft.parentId } : {}),
    observedAt: input.now?.() ?? new Date()
  });

  return {
    type: operation.type,
    status: 'succeeded',
    ...(draft.payloadSnapshot ? { zenodoPayloadSnapshot: draft.payloadSnapshot } : {}),
    ...draftSettlementIdentifiers(draft)
  };
}

async function executeJournaledDraftPublishOperation(
  input: ExecuteLiveSyncPlanInput,
  operation: Extract<SyncOperation, { readonly type: 'zenodo_publish_journaled_draft' }>
): Promise<SyncOperationResult> {
  if (!input.zenodoJournal) return zenodoJournalRequired(operation.type, 'Cannot publish a Zenodo draft without journal storage');

  const draft: ZenodoPreparedDraft = {
    depositionId: operation.depositionId,
    draftRecordId: operation.draftRecordId,
    ...(operation.parentId ? { parentId: operation.parentId } : {}),
    ...(operation.originalOperationType === 'zenodo_file_update' ? { api: 'invenio_record' as const } : {})
  };

  let identifiers: ZenodoRecordIdentifiers;
  try {
    identifiers = await input.providers.zenodo.publishDraft({
      token: input.context.credentials.zenodoToken,
      draft
    });
  } catch (error) {
    const recovered = await recoverZenodoDoiConflict(input, operation.type, error);
    if (recovered) {
      if (recovered.identifiers) {
        const cleanup = await cleanupOrphanZenodoCreateDraftAfterAdoption(input, operation.originalOperationType, draft, recovered.identifiers);
        await input.zenodoJournal.markZenodoPublishDraftPublished({
          recordId: input.context.record.id,
          environment: input.providerStateEnvironment,
          depositionId: draft.depositionId,
          publishedRecordId: recovered.identifiers.latestRecordId,
          identifiers: recovered.identifiers,
          observedAt: input.now?.() ?? new Date()
        });
        return withZenodoOrphanDraftCleanup(recovered.result, cleanup);
      }
      return recovered.result;
    }
    return failedFromError(operation.type, error);
  }

  await input.zenodoJournal?.markZenodoPublishDraftPublished({
    recordId: input.context.record.id,
    environment: input.providerStateEnvironment,
    depositionId: draft.depositionId,
    publishedRecordId: identifiers.latestRecordId,
    identifiers,
    observedAt: input.now?.() ?? new Date()
  });

  return {
    type: operation.type,
    status: 'succeeded',
    ...(draft.payloadSnapshot ? { zenodoPayloadSnapshot: draft.payloadSnapshot } : {}),
    zenodo: toSettlementZenodoIdentifiers(identifiers)
  };
}

async function executeJournaledZenodoOperation(
  input: ExecuteLiveSyncPlanInput,
  operation: Extract<SyncOperation, { readonly type: ZenodoPublishJournalOperationType }>,
  handlers: {
    readonly prepare: () => Promise<ZenodoPreparedDraft>;
    readonly publish: (draft: ZenodoPreparedDraft) => Promise<ZenodoRecordIdentifiers>;
  }
): Promise<SyncOperationResult> {
  if (!input.zenodoJournal) return zenodoJournalRequired(operation.type, 'Cannot publish a Zenodo draft without journal storage');

  let draft: ZenodoPreparedDraft;
  try {
    draft = await handlers.prepare();
  } catch (error) {
    const recovered = operation.type === 'zenodo_create'
      ? await recoverZenodoDoiConflict(input, operation.type, error)
      : null;
    if (recovered) return recovered.result;
    return failedFromError(operation.type, error);
  }

  const observedAt = input.now?.() ?? new Date();
  await input.zenodoJournal?.recordZenodoPublishDraft({
    recordId: input.context.record.id,
    environment: input.providerStateEnvironment,
    operationType: operation.type,
    zenodoPayloadHash: operation.payloadHash,
    ...operationFileManifestHash(operation),
    depositionId: draft.depositionId,
    draftRecordId: draft.draftRecordId,
    ...(draft.parentId ? { parentId: draft.parentId } : {}),
    observedAt
  });

  let identifiers: ZenodoRecordIdentifiers;
  try {
    identifiers = await handlers.publish(draft);
  } catch (error) {
    const recovered = await recoverZenodoDoiConflict(input, operation.type, error);
    if (recovered) {
      if (recovered.identifiers) {
        const cleanup = await cleanupOrphanZenodoCreateDraftAfterAdoption(input, operation.type, draft, recovered.identifiers);
        await input.zenodoJournal?.markZenodoPublishDraftPublished({
          recordId: input.context.record.id,
          environment: input.providerStateEnvironment,
          depositionId: draft.depositionId,
          publishedRecordId: recovered.identifiers.latestRecordId,
          identifiers: recovered.identifiers,
          observedAt
        });
        return withZenodoOrphanDraftCleanup(recovered.result, cleanup);
      }
      return recovered.result;
    }
    return failedFromError(operation.type, error);
  }

  await input.zenodoJournal?.markZenodoPublishDraftPublished({
    recordId: input.context.record.id,
    environment: input.providerStateEnvironment,
    depositionId: draft.depositionId,
    publishedRecordId: identifiers.latestRecordId,
    identifiers,
    observedAt
  });

  return {
    type: operation.type,
    status: 'succeeded',
    ...(draft.payloadSnapshot ? { zenodoPayloadSnapshot: draft.payloadSnapshot } : {}),
    zenodo: toSettlementZenodoIdentifiers(identifiers)
  };
}

function zenodoJournalRequired(type: SyncOperationResult['type'], summary: string): SyncOperationResult {
  return failed(type, 'ZENODO_JOURNAL_REQUIRED', summary);
}

function operationFileManifestHash(
  operation: Extract<SyncOperation, { readonly type: ZenodoPublishJournalOperationType }>
): { readonly fileManifestHash?: string } {
  return 'fileManifestHash' in operation ? { fileManifestHash: operation.fileManifestHash } : {};
}

function unreachableZenodoOperation(operation: never): never {
  throw new Error(`Unsupported Zenodo operation: ${JSON.stringify(operation)}`);
}

async function executeZoteroWritebackOperation(
  input: ExecuteLiveSyncPlanInput,
  zenodo: ZenodoSettlementIdentifiers | null,
  successTags: {
    readonly zenodoSubmitted: boolean;
    readonly uploadedAttachmentKeys: readonly string[];
  }
): Promise<SyncOperationResult> {
  try {
    await input.providers.zotero.applyManagedWriteback({
      groupId: input.context.credentials.zoteroGroupId,
      apiKey: input.context.credentials.zoteroApiKey,
      itemKey: input.context.record.zoteroItemKey,
      itemVersion: input.zoteroParent.version,
      publicResourceUrl: input.resourceUrl,
      data: buildZoteroWritebackData(input.zoteroParent),
      identifiers: buildZoteroWritebackIdentifiers({ crossrefDoi: input.context.record.crossrefDoi, zenodo })
    });
    for (const action of planZoteroIdentifierLinkReconciliation({
      parentItemKey: input.context.record.zoteroItemKey,
      children: input.zoteroChildren,
      zenodoBaseUrl: input.zenodoBaseUrl,
      identifiers: buildZoteroWritebackIdentifiers({ crossrefDoi: input.context.record.crossrefDoi, zenodo })
    })) {
      if (action.type === 'create') {
        await input.providers.zotero.createLinkedUrlAttachment({
          groupId: input.context.credentials.zoteroGroupId,
          apiKey: input.context.credentials.zoteroApiKey,
          parentItemKey: input.context.record.zoteroItemKey,
          title: action.title,
          url: action.url,
          tags: action.tags
        });
      }
      if (action.type === 'update') {
        await input.providers.zotero.patchLinkedUrlAttachment({
          groupId: input.context.credentials.zoteroGroupId,
          apiKey: input.context.credentials.zoteroApiKey,
          attachmentKey: action.attachmentKey,
          ifUnmodifiedSinceVersion: action.itemVersion,
          patch: {
            title: action.title,
            url: action.url,
            tags: action.tags.map((tag) => ({ tag }))
          }
        });
      }
      if (action.type === 'delete') {
        await input.providers.zotero.deleteItem({
          groupId: input.context.credentials.zoteroGroupId,
          apiKey: input.context.credentials.zoteroApiKey,
          itemKey: action.attachmentKey,
          ifUnmodifiedSinceVersion: action.itemVersion
        });
      }
    }
    await applyZoteroSuccessTags(input, successTags);
    return { type: 'zotero_writeback', status: 'succeeded' };
  } catch (error) {
    return failedFromError('zotero_writeback', error);
  }
}

async function applyZoteroSuccessTags(
  input: ExecuteLiveSyncPlanInput,
  successTags: {
    readonly zenodoSubmitted: boolean;
    readonly uploadedAttachmentKeys: readonly string[];
  }
): Promise<void> {
  if (!input.providers.zotero.addTagsToItem) return;

  for (const application of planZoteroSuccessTagApplications({
    parentItemKey: input.context.record.zoteroItemKey,
    zenodoSubmitted: successTags.zenodoSubmitted,
    uploadedAttachmentKeys: successTags.uploadedAttachmentKeys
  })) {
    await input.providers.zotero.addTagsToItem({
      groupId: input.context.credentials.zoteroGroupId,
      apiKey: input.context.credentials.zoteroApiKey,
      itemKey: application.itemKey,
      tags: application.tags
    });
  }
}

async function downloadZenodoFiles(
  credentials: ProviderExecutionCredentials,
  files: readonly FileManifestEntry[],
  zotero: ZoteroWriter
): Promise<readonly ZenodoLiveUploadFile[]> {
  const downloaded: ZenodoLiveUploadFile[] = [];
  for (const file of files) {
    const downloadedFile = await zotero.downloadAttachmentFile({
      groupId: credentials.zoteroGroupId,
      apiKey: credentials.zoteroApiKey,
      attachmentKey: file.zoteroAttachmentKey
    });
    downloaded.push({
      key: file.zoteroAttachmentKey,
      filename: file.filename,
      contentType: file.contentType,
      bytes: downloadedFile.bytes
    });
  }
  return downloaded;
}

function identifiersFromState(context: ProviderExecutionContext): ZenodoSettlementIdentifiers | null {
  const latestRecordId = context.syncState?.zenodoLatestRecordId;
  const parentId = context.syncState?.zenodoParentId;
  if (!latestRecordId || !parentId) return null;
  return {
    latestRecordId,
    parentId,
    ...(context.syncState?.zenodoConceptDoi ? { conceptDoi: context.syncState.zenodoConceptDoi } : {}),
    ...(context.syncState?.zenodoVersionDoi ? { versionDoi: context.syncState.zenodoVersionDoi } : {})
  };
}

function mergeZenodoIdentifiers(
  current: ZenodoSettlementIdentifiers | null,
  result: SyncOperationResult
): ZenodoSettlementIdentifiers | null {
  if (result.status === 'succeeded' && result.zenodo) return result.zenodo;
  return current;
}

function toSettlementZenodoIdentifiers(identifiers: ZenodoRecordIdentifiers): ZenodoSettlementIdentifiers {
  return {
    latestRecordId: identifiers.latestRecordId,
    parentId: identifiers.parentId,
    ...(identifiers.conceptDoi ? { conceptDoi: identifiers.conceptDoi } : {}),
    ...(identifiers.versionDoi ? { versionDoi: identifiers.versionDoi } : {})
  };
}

function draftSettlementIdentifiers(draft: ZenodoPreparedDraft): { readonly zenodo?: ZenodoSettlementIdentifiers } {
  if (!draft.parentId) return {};
  return {
    zenodo: {
      latestRecordId: draft.draftRecordId,
      parentId: draft.parentId
    }
  };
}

async function cleanupOrphanZenodoCreateDraftAfterAdoption(
  input: ExecuteLiveSyncPlanInput,
  operationType: ZenodoPublishJournalOperationType,
  draft: ZenodoPreparedDraft,
  adoptedIdentifiers: ZenodoRecordIdentifiers
): Promise<ZenodoOrphanDraftCleanup | undefined> {
  if (operationType !== 'zenodo_create') return undefined;
  if (adoptedIdentifiers.latestRecordId === draft.depositionId || adoptedIdentifiers.latestRecordId === draft.draftRecordId) return undefined;
  const deleteUnpublishedDraft = input.providers.zenodo.deleteUnpublishedDraft;
  if (!deleteUnpublishedDraft) return undefined;

  try {
    await deleteUnpublishedDraft({
      token: input.context.credentials.zenodoToken,
      depositionId: draft.depositionId
    });
    return {
      status: 'deleted',
      depositionId: draft.depositionId
    };
  } catch (error) {
    return {
      status: 'failed',
      depositionId: draft.depositionId,
      failureClass: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
      failureSummary: error instanceof Error ? error.message : String(error)
    };
  }
}

function withZenodoOrphanDraftCleanup(
  result: SyncOperationResult,
  cleanup: ZenodoOrphanDraftCleanup | undefined
): SyncOperationResult {
  if (!cleanup || result.status !== 'succeeded') return result;
  return {
    ...result,
    zenodoOrphanDraftCleanup: cleanup
  };
}

interface ZenodoDoiConflictRecovery {
  readonly result: SyncOperationResult;
  readonly identifiers?: ZenodoRecordIdentifiers;
}

async function recoverZenodoDoiConflict(
  input: ExecuteLiveSyncPlanInput,
  operationType: SyncOperation['type'],
  error: unknown
): Promise<ZenodoDoiConflictRecovery | null> {
  if (!isZenodoDoiAlreadyExistsError(error)) return null;

  const doi = input.context.record.crossrefDoi;
  const lookup = await input.providers.zenodo.findRecordByDoi?.({
    token: input.context.credentials.zenodoToken,
    doi
  });

  if (lookup?.status === 'found') {
    return {
      identifiers: lookup.record.identifiers,
      result: {
        type: operationType,
        status: 'succeeded',
        zenodoAdoptionOnly: true,
        zenodo: toSettlementZenodoIdentifiers(lookup.record.identifiers)
      }
    };
  }

  return {
    result: failed(
      operationType,
      'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED',
      unresolvedZenodoDoiConflictSummary(doi, lookup)
    )
  };
}

function isZenodoDoiAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.provider !== 'zenodo' || error.status !== 400) return false;
  return /pids\.doi/i.test(error.body) && /already exists/i.test(error.body);
}

function unresolvedZenodoDoiConflictSummary(doi: string, lookup: ZenodoDoiLookupResult | undefined): string {
  if (!lookup) return `Zenodo says DOI ${doi} already exists, but this provider does not support DOI lookup`;
  if (lookup.status === 'not_found') return `Zenodo says DOI ${doi} already exists, but exact DOI lookup found no published record`;
  if (lookup.status === 'ambiguous') return `Zenodo says DOI ${doi} already exists, but exact DOI lookup found multiple records: ${lookup.recordIds.join(', ')}`;
  return `Zenodo says DOI ${doi} already exists, but exact DOI lookup could not adopt it`;
}

function failed(type: SyncOperation['type'], failureClass: string, failureSummary: string): SyncOperationResult {
  return {
    type,
    status: 'failed',
    failureClass,
    failureSummary
  };
}

function skipped(type: SyncOperation['type'], reason: string): SyncOperationResult {
  return {
    type,
    status: 'skipped',
    reason
  };
}

function failedFromError(type: SyncOperation['type'], error: unknown): SyncOperationResult {
  if (error instanceof Error) {
    return failed(type, error.name, error.message);
  }
  return failed(type, 'UNKNOWN_ERROR', String(error));
}
