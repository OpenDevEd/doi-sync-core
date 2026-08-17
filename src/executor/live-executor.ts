import { createHash } from 'node:crypto';

import type {
	CrossrefDepositOutcome,
	CrossrefPublicationDepositInput,
	CrossrefPublicationVerifyInput,
	CrossrefXmlApiVerification
} from '../crossref/client.js';
import type { CrossrefEnvironment } from '../crossref/deposit.js';
import { crossrefDepositTimestamp } from '../crossref/timestamp.js';
import type { CrossrefDepositRelation } from '../crossref/xml.js';
import {
	isZenodoOperation,
	requiresZenodoRecordId,
	type ZenodoSyncOperation
} from '../operations.js';
import type {
	PublicationSyncOperation,
	PublicationSyncPlan
} from '../planner.js';
import type { PublicationFile } from '../publication/files.js';
import type {
	PublicationProviderMetadata
} from '../publication/record.js';
import type {
	CrossrefTargetPolicy,
	PublicationTargetPolicy,
	ZenodoTargetPolicy
} from '../publication/targets.js';
import type { PublicationFileReader } from '../ports.js';
import { ProviderHttpError } from '../resilience/errors.js';
import type {
	PublicationSyncOperationResult,
	ZenodoOrphanDraftCleanup,
	ZenodoSettlementIdentifiers
} from '../settlement.js';
import type {
	ClearZenodoOrphanDraftCleanupInput,
	ClearZenodoPublishDraftInput,
	MarkZenodoPublishDraftPublishedInput,
	RecordZenodoPublishDraftInput,
	ZenodoPreparedDraft,
	ZenodoPublishJournalOperationType
} from '../zenodo/journal.js';
import type {
	DoiPolicy,
	ZenodoDoiLookupResult,
	ZenodoRecordIdentifiers
} from '../zenodo/records.js';
import { buildZenodoProviderMetadata } from '../zenodo/publication-mapper.js';

type ActionablePublicationSyncPlan = Extract<PublicationSyncPlan, { readonly snapshots: unknown }>;
type WriteRequiredPublicationSyncPlan = ActionablePublicationSyncPlan & { readonly status: 'write_required' };
type ZenodoPreparationOperation = Exclude<ZenodoSyncOperation, {
	readonly type:
		| 'zenodo_publish_journaled_draft'
		| 'zenodo_discard_preparing_draft'
		| 'zenodo_discard_expired_file_correction'
		| 'zenodo_cleanup_orphan_draft';
}>;

export interface CrossrefDepositor {
	readonly submitPublication: (input: CrossrefPublicationDepositInput) => Promise<CrossrefDepositOutcome>;
	readonly verifyPublication: (input: CrossrefPublicationVerifyInput) => Promise<CrossrefXmlApiVerification>;
}

export interface RecordCrossrefPendingDepositInput {
	readonly recordId: string;
	readonly environment: CrossrefEnvironment;
	readonly stage: 'relation_clear' | 'deposit';
	readonly payloadHash: string;
	readonly batchId: string;
	readonly filename: string;
	readonly submittedAt: Date;
	readonly pendingReason: string;
}

export interface CrossrefSubmissionJournalWriter {
	readonly recordCrossrefPendingDeposit: (input: RecordCrossrefPendingDepositInput) => Promise<void>;
}

export interface ZenodoLiveUploadFile {
	readonly key: string;
	readonly filename: string;
	readonly contentType: string;
	readonly bytes: Uint8Array;
}

interface PrepareZenodoBaseInput {
	readonly token: string;
	readonly doiPolicy: DoiPolicy;
	readonly metadata: PublicationProviderMetadata;
	readonly resourceUrl: string;
	readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
}

export interface ZenodoWriter {
	readonly findRecordByDoi?: (input: {
		readonly token: string;
		readonly doi: string;
	}) => Promise<ZenodoDoiLookupResult>;
	readonly deleteUnpublishedDraft?: (input: {
		readonly token: string;
		readonly depositionId: string;
	}) => Promise<void>;
	readonly discardPreparedDraft: (input: {
		readonly token: string;
		readonly operationType: ZenodoPublishJournalOperationType;
		readonly draft: ZenodoPreparedDraft;
	}) => Promise<void>;
	readonly prepareCreateRecord: (input: PrepareZenodoBaseInput & {
		readonly files: readonly ZenodoLiveUploadFile[];
	}) => Promise<ZenodoPreparedDraft>;
	readonly prepareUpdateRecordMetadata: (input: PrepareZenodoBaseInput & {
		readonly latestRecordId: string;
	}) => Promise<ZenodoPreparedDraft>;
	readonly prepareUpdateRecordFiles: (input: PrepareZenodoBaseInput & {
		readonly latestRecordId: string;
		readonly files: readonly ZenodoLiveUploadFile[];
	}) => Promise<ZenodoPreparedDraft>;
	readonly prepareNewVersion: (input: PrepareZenodoBaseInput & {
		readonly latestRecordId: string;
		readonly files: readonly ZenodoLiveUploadFile[];
	}) => Promise<ZenodoPreparedDraft>;
	readonly publishDraft: (input: {
		readonly token: string;
		readonly draft: ZenodoPreparedDraft;
	}) => Promise<ZenodoRecordIdentifiers>;
}

export interface ProviderExecutionCredentials {
	readonly zenodoToken?: string;
}

export interface LiveExecutorCrossrefConfig {
	readonly loginId: string;
	readonly password: string;
	readonly depositorName: string;
	readonly emailAddress: string;
	readonly registrant: string;
	readonly batchIdPrefix?: string;
}

export interface ZenodoPublishJournalWriter {
	readonly recordZenodoPublishDraft: (input: RecordZenodoPublishDraftInput) => Promise<void>;
	readonly markZenodoPublishDraftPublished: (input: MarkZenodoPublishDraftPublishedInput) => Promise<void>;
	readonly clearZenodoPublishDraft: (input: ClearZenodoPublishDraftInput) => Promise<void>;
	readonly clearZenodoOrphanDraftCleanup: (input: ClearZenodoOrphanDraftCleanupInput) => Promise<void>;
}

export interface ExecuteLivePublicationSyncPlanInput {
	readonly plan: PublicationSyncPlan;
	readonly credentials: ProviderExecutionCredentials;
	readonly providers: {
		readonly crossref?: CrossrefDepositor;
		readonly zenodo?: ZenodoWriter;
	};
	readonly fileReader?: PublicationFileReader;
	readonly crossref?: LiveExecutorCrossrefConfig;
	readonly crossrefJournal?: CrossrefSubmissionJournalWriter;
	readonly zenodoJournal?: ZenodoPublishJournalWriter;
	readonly now?: () => Date;
}

/** Executes the provider-neutral plan. Source-system writeback belongs to the host adapter. */
export async function executeLivePublicationSyncPlan(
	input: ExecuteLivePublicationSyncPlanInput
): Promise<readonly PublicationSyncOperationResult[]> {
	if (input.plan.status !== 'write_required') return [];

	const results: PublicationSyncOperationResult[] = [];
	for (const operation of input.plan.operations) {
		if (operation.type === 'crossref_redeposit') {
			results.push(await executeCrossrefDeposit(input, input.plan, operation));
			continue;
		}
		if (operation.type === 'crossref_verify_pending') {
			results.push(await executeCrossrefVerification(input, input.plan, operation));
			continue;
		}
		if (isZenodoOperation(operation)) {
			let result: PublicationSyncOperationResult;
			try {
				result = await executeZenodoOperation(input, input.plan, operation);
			} catch (error) {
				result = failedFromError(operation.type, error);
			}
			results.push(result);
		}
	}
	return results;
}

async function executeCrossrefDeposit(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: Extract<PublicationSyncOperation, { readonly type: 'crossref_redeposit' }>
): Promise<PublicationSyncOperationResult> {
	try {
		if (operation.clearRelations) {
			const deleteBatchId = `${crossrefBatchId(input, plan, operation)}-delete-relations`;
			const deletion = await submitCrossref(input, plan, operation, {
				relation: 'delete-all',
				batchId: deleteBatchId,
				stage: 'relation_clear'
			});
			if (deletion.status === 'failed') {
				return failed(operation.type, 'CROSSREF_FAILED', `Crossref submission ${deletion.filename} failed`);
			}
			if (deletion.status === 'pending') {
				return crossrefPendingResult(
					operation.type, deletion, input.now?.() ?? new Date(), 'relation_clear', deleteBatchId
				);
			}
		}

		return await submitDesiredCrossrefDeposit(input, plan, operation.type, operation);
	} catch (error) {
		return failedFromError(operation.type, error);
	}
}

async function submitCrossref(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: Pick<Extract<PublicationSyncOperation, { readonly type: 'crossref_redeposit' }>, 'payloadHash'>,
	options: {
		readonly relation?: CrossrefDepositRelation;
		readonly batchId?: string;
		readonly stage: 'relation_clear' | 'deposit';
	}
): Promise<CrossrefDepositOutcome> {
	const provider = requireCrossrefProvider(input);
	const config = requireCrossrefConfig(input);
	const target = requireCrossrefTarget(plan);
	const journal = input.crossrefJournal;
	if (!journal) throw new Error('Crossref submission requires durable journal storage');
	const now = input.now?.() ?? new Date();
	const batchId = options.batchId ?? crossrefBatchId(input, plan, operation);
	const filename = `${batchId}.xml`;
	return provider.submitPublication({
		...config,
		environment: target.environment,
		batchId,
		timestamp: crossrefDepositTimestamp(now),
		filename,
		record: requireCrossrefRecord(plan),
		...(options.relation ? { relation: options.relation } : {}),
		onSubmitted: () => journal.recordCrossrefPendingDeposit({
			recordId: plan.record.recordKey,
			environment: target.environment,
			stage: options.stage,
			payloadHash: operation.payloadHash,
			batchId,
			filename,
			submittedAt: now,
			pendingReason: `Crossref submission ${filename} accepted; verification pending`
		})
	});
}

async function executeCrossrefVerification(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: Extract<PublicationSyncOperation, { readonly type: 'crossref_verify_pending' }>
): Promise<PublicationSyncOperationResult> {
	try {
		const provider = requireCrossrefProvider(input);
		const config = requireCrossrefConfig(input);
		const target = requireCrossrefTarget(plan);
		const verification = await provider.verifyPublication({
			environment: target.environment,
			emailAddress: config.emailAddress,
			record: requireCrossrefRecord(plan),
			...(operation.stage === 'relation_clear'
				? { relation: 'delete-all' as const }
				: operation.relation ? { relation: operation.relation } : {})
		});
		if (verification.status !== 'matched') {
			return {
				type: operation.type,
				status: 'pending',
				pendingClass: 'CROSSREF_PENDING',
				pendingSummary: verification.reason ?? 'Crossref XML API metadata has not caught up',
				crossref: { stage: operation.stage }
			};
		}
		if (operation.stage === 'relation_clear') {
			return await submitDesiredCrossrefDeposit(input, plan, operation.type, operation);
		}
		return { type: operation.type, status: 'succeeded' };
	} catch (error) {
		return failedFromError(operation.type, error);
	}
}

async function submitDesiredCrossrefDeposit(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	resultType: 'crossref_redeposit' | 'crossref_verify_pending',
	operation: Pick<Extract<PublicationSyncOperation, { readonly type: 'crossref_redeposit' }>, 'payloadHash'> & {
		readonly relation?: CrossrefDepositRelation;
	}
): Promise<PublicationSyncOperationResult> {
	const batchId = crossrefBatchId(input, plan, operation);
	const outcome = await submitCrossref(input, plan, operation, {
		...(operation.relation ? { relation: operation.relation } : {}),
		batchId,
		stage: 'deposit'
	});
	if (outcome.status === 'succeeded') return { type: resultType, status: 'succeeded' };
	if (outcome.status === 'pending') {
		return crossrefPendingResult(resultType, outcome, input.now?.() ?? new Date(), 'deposit', batchId);
	}
	return failed(resultType, 'CROSSREF_FAILED', `Crossref submission ${outcome.filename} failed`);
}

async function executeZenodoOperation(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: ZenodoSyncOperation
): Promise<PublicationSyncOperationResult> {
	const provider = requireZenodoProvider(input);
	if (operation.type === 'zenodo_cleanup_orphan_draft') {
		if (!input.zenodoJournal) {
			return failed(operation.type, 'ZENODO_JOURNAL_REQUIRED',
				'Cannot delete an orphaned Zenodo draft without journal storage');
		}
		if (!provider.deleteUnpublishedDraft) {
			return failed(
				operation.type,
				'ZENODO_ORPHAN_DRAFT_CLEANUP_UNAVAILABLE',
				'Zenodo provider cannot delete the orphaned unpublished draft'
			);
		}
		try {
			await provider.deleteUnpublishedDraft({
				token: requireZenodoToken(input),
				depositionId: operation.depositionId
			});
			await input.zenodoJournal.clearZenodoOrphanDraftCleanup({
				recordId: plan.record.recordKey,
				environment: requireZenodoTarget(plan).environment,
				depositionId: operation.depositionId,
				observedAt: input.now?.() ?? new Date()
			});
			return { type: operation.type, status: 'succeeded' };
		} catch (error) {
			return failedFromError(operation.type, error);
		}
	}
	if (operation.type === 'zenodo_discard_preparing_draft') {
		return discardZenodoDraft(input, plan, operation);
	}
	if (operation.type === 'zenodo_discard_expired_file_correction') {
		return discardZenodoDraft(input, plan, operation);
	}
	if (operation.type === 'zenodo_publish_journaled_draft') {
		return publishJournaledDraft(input, plan, operation);
	}
	const onPreparedDraft = journalPreparingDraft(input, plan, operation);
	if (operation.type === 'zenodo_create') {
		return executeJournaledZenodoOperation(input, plan, operation, {
			prepare: async () => provider.prepareCreateRecord({
				...zenodoBaseInput(input, plan, onPreparedDraft),
				files: await readZenodoFiles(plan.files.files, requireFileReader(input))
			})
		});
	}
	if (!requiresZenodoRecordId(operation)) return unreachable(operation);
	const latestRecordId = operation.latestRecordId;
	if (operation.type === 'zenodo_metadata_update') {
		return executeJournaledZenodoOperation(input, plan, operation, {
			prepare: () => provider.prepareUpdateRecordMetadata({
				...zenodoBaseInput(input, plan, onPreparedDraft),
				latestRecordId
			})
		});
	}
	if (operation.type === 'zenodo_file_update') {
		return executeJournaledZenodoOperation(input, plan, operation, {
			prepare: async () => provider.prepareUpdateRecordFiles({
				...zenodoBaseInput(input, plan, onPreparedDraft),
				latestRecordId,
				files: await readZenodoFiles(plan.files.files, requireFileReader(input))
			})
		});
	}
	if (operation.type === 'zenodo_new_version') {
		return executeJournaledZenodoOperation(input, plan, operation, {
			prepare: async () => provider.prepareNewVersion({
				...zenodoBaseInput(input, plan, onPreparedDraft),
				latestRecordId,
				files: await readZenodoFiles(plan.files.files, requireFileReader(input))
			})
		});
	}
	return unreachable(operation);
}

async function discardZenodoDraft(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: Extract<ZenodoSyncOperation, {
		readonly type: 'zenodo_discard_preparing_draft' | 'zenodo_discard_expired_file_correction'
	}>
): Promise<PublicationSyncOperationResult> {
	if (!input.zenodoJournal) {
		return failed(operation.type, 'ZENODO_JOURNAL_REQUIRED', 'Cannot recover a Zenodo draft without journal storage');
	}
	const originalOperationType = operation.type === 'zenodo_discard_expired_file_correction'
		? 'zenodo_file_update'
		: operation.originalOperationType;
	const draft: ZenodoPreparedDraft = {
		depositionId: operation.depositionId,
		draftRecordId: operation.draftRecordId,
		...(originalOperationType === 'zenodo_file_update'
			? { api: 'invenio_record' as const }
			: {})
	};
	try {
		await requireZenodoProvider(input).discardPreparedDraft({
			token: requireZenodoToken(input),
			operationType: originalOperationType,
			draft
		});
		await input.zenodoJournal.clearZenodoPublishDraft({
			recordId: plan.record.recordKey,
			environment: requireZenodoTarget(plan).environment,
			depositionId: operation.depositionId,
			observedAt: input.now?.() ?? new Date()
		});
		if (operation.type !== 'zenodo_discard_expired_file_correction') {
			return { type: operation.type, status: 'succeeded' };
		}
		const failureClass = operation.reason === 'deadline_expired'
			? 'ZENODO_FILE_CORRECTION_WINDOW_CLOSED'
			: operation.reason === 'deadline_missing'
				? 'ZENODO_FIRST_PUBLICATION_TIME_REQUIRED'
				: 'ZENODO_FILE_CORRECTION_APPROVAL_REQUIRED';
		return failed(
			operation.type,
			failureClass,
			operation.reason === 'deadline_expired'
				? 'The Zenodo file correction was not published before its 45-day deadline'
				: 'The unsafe Zenodo file correction draft was discarded'
		);
	} catch (error) {
		return failedFromError(operation.type, error);
	}
}

function zenodoBaseInput(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	onPreparedDraft: (draft: ZenodoPreparedDraft) => Promise<void>
): PrepareZenodoBaseInput {
	return {
		token: requireZenodoToken(input),
		doiPolicy: zenodoDoiPolicy(plan.targets),
		metadata: buildZenodoProviderMetadata({
			record: plan.record,
			identifiers: plan.identifiers,
			identifierPolicy: requireZenodoTarget(plan).identifierPolicy
		}),
		resourceUrl: plan.record.landingUrl,
		onPreparedDraft
	};
}

async function executeJournaledZenodoOperation(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: ZenodoPreparationOperation,
	handlers: { readonly prepare: () => Promise<ZenodoPreparedDraft> }
): Promise<PublicationSyncOperationResult> {
	if (!input.zenodoJournal) {
		return failed(operation.type, 'ZENODO_JOURNAL_REQUIRED', 'Cannot publish a Zenodo draft without journal storage');
	}

	let draft: ZenodoPreparedDraft;
	try {
		draft = await handlers.prepare();
	} catch (error) {
		const recovered = operation.type === 'zenodo_create'
			? await recoverZenodoDoiConflict(input, plan, operation.type, error)
			: null;
		return recovered?.result ?? failedFromError(operation.type, error);
	}

	const observedAt = input.now?.() ?? new Date();
	await input.zenodoJournal.recordZenodoPublishDraft({
		recordId: plan.record.recordKey,
		environment: requireZenodoTarget(plan).environment,
		operationType: operation.type,
		zenodoPayloadHash: operation.payloadHash,
		...operationFileManifestHash(operation),
		...operationFileCorrectionApproval(operation),
		depositionId: draft.depositionId,
		draftRecordId: draft.draftRecordId,
		...(draft.parentId ? { parentId: draft.parentId } : {}),
		status: 'ready_to_publish',
		observedAt
	});
	const publishAt = input.now?.() ?? new Date();
	if (fileCorrectionDeadlinePassed(operation, publishAt)) {
		return discardExpiredFileCorrection(input, plan, operation.type, draft, publishAt);
	}

	let identifiers: ZenodoRecordIdentifiers;
	try {
		identifiers = await requireZenodoProvider(input).publishDraft({
			token: requireZenodoToken(input),
			draft
		});
	} catch (error) {
		const recovered = await recoverZenodoDoiConflict(input, plan, operation.type, error);
		if (!recovered) return failedFromError(operation.type, error);
		if (!recovered.identifiers) return recovered.result;
		const orphanDraftCleanup = orphanCreateDraftCleanup(operation.type, draft, recovered.identifiers);
		await markDraftPublished(input, plan, draft, recovered.identifiers, publishAt, orphanDraftCleanup);
		const cleanup = await cleanupOrphanCreateDraft(input, plan, orphanDraftCleanup);
		return withCleanup(recovered.result, cleanup);
	}

	await markDraftPublished(input, plan, draft, identifiers, publishAt);
	return {
		type: operation.type,
		status: 'succeeded',
		...(draft.payloadSnapshot ? { zenodoPayloadSnapshot: draft.payloadSnapshot } : {}),
		zenodoPublishedAt: identifiers.publishedAt,
		zenodo: toSettlementIdentifiers(identifiers)
	};
}

async function publishJournaledDraft(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: Extract<ZenodoSyncOperation, { readonly type: 'zenodo_publish_journaled_draft' }>
): Promise<PublicationSyncOperationResult> {
	if (!input.zenodoJournal) {
		return failed(operation.type, 'ZENODO_JOURNAL_REQUIRED', 'Cannot publish a Zenodo draft without journal storage');
	}
	const draft: ZenodoPreparedDraft = {
		depositionId: operation.depositionId,
		draftRecordId: operation.draftRecordId,
		...(operation.parentId ? { parentId: operation.parentId } : {}),
		...(operation.originalOperationType === 'zenodo_file_update' ? { api: 'invenio_record' as const } : {})
	};
	const observedAt = input.now?.() ?? new Date();
	if (fileCorrectionDeadlinePassed(operation, observedAt)) {
		return discardExpiredFileCorrection(input, plan, operation.type, draft, observedAt);
	}
	try {
		const identifiers = await requireZenodoProvider(input).publishDraft({
			token: requireZenodoToken(input),
			draft
		});
		await markDraftPublished(input, plan, draft, identifiers, observedAt);
		return {
			type: operation.type,
			status: 'succeeded',
			zenodoPublishedAt: identifiers.publishedAt,
			zenodo: toSettlementIdentifiers(identifiers)
		};
	} catch (error) {
		const recovered = await recoverZenodoDoiConflict(input, plan, operation.type, error);
		if (!recovered?.identifiers) return recovered?.result ?? failedFromError(operation.type, error);
		const orphanDraftCleanup = orphanCreateDraftCleanup(
			operation.originalOperationType,
			draft,
			recovered.identifiers
		);
		await markDraftPublished(input, plan, draft, recovered.identifiers, observedAt, orphanDraftCleanup);
		const cleanup = await cleanupOrphanCreateDraft(input, plan, orphanDraftCleanup);
		return withCleanup(recovered.result, cleanup);
	}
}

function journalPreparingDraft(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: ZenodoPreparationOperation
): (draft: ZenodoPreparedDraft) => Promise<void> {
	return async (draft) => {
		await input.zenodoJournal?.recordZenodoPublishDraft({
			recordId: plan.record.recordKey,
			environment: requireZenodoTarget(plan).environment,
			operationType: operation.type,
			zenodoPayloadHash: operation.payloadHash,
			...operationFileManifestHash(operation),
			...operationFileCorrectionApproval(operation),
			depositionId: draft.depositionId,
			draftRecordId: draft.draftRecordId,
			...(draft.parentId ? { parentId: draft.parentId } : {}),
			status: 'preparing',
			observedAt: input.now?.() ?? new Date()
		});
	};
}

async function markDraftPublished(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	draft: ZenodoPreparedDraft,
	identifiers: ZenodoRecordIdentifiers,
	observedAt: Date,
	orphanDraftCleanup?: { readonly depositionId: string }
): Promise<void> {
	await input.zenodoJournal?.markZenodoPublishDraftPublished({
		recordId: plan.record.recordKey,
		environment: requireZenodoTarget(plan).environment,
		depositionId: draft.depositionId,
		publishedRecordId: identifiers.latestRecordId,
		identifiers,
		...(orphanDraftCleanup ? { orphanDraftCleanup } : {}),
		observedAt
	});
}

async function readZenodoFiles(
	files: readonly PublicationFile[],
	reader: PublicationFileReader
): Promise<readonly ZenodoLiveUploadFile[]> {
	const uploads: ZenodoLiveUploadFile[] = [];
	for (const file of files) {
		const bytes = await reader.readFile(file);
		if (bytes.byteLength !== file.size) {
			throw new Error(`Published file ${file.fileKey} size does not match its manifest`);
		}
		const actualHash = createHash('sha256').update(bytes).digest('hex');
		if (actualHash !== file.sha256.toLowerCase()) {
			throw new Error(`Published file ${file.fileKey} SHA-256 does not match its manifest`);
		}
		uploads.push({
			key: file.fileKey,
			filename: file.filename,
			contentType: file.contentType,
			bytes
		});
	}
	return uploads;
}

function zenodoDoiPolicy(targets: PublicationTargetPolicy): DoiPolicy {
	if (!targets.zenodo.enabled) throw new Error('Zenodo execution requires an enabled target');
	return targets.zenodo.identifierPolicy === 'mint-zenodo' ? 'dual' : 'external-crossref';
}

function crossrefBatchId(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operation: Pick<Extract<PublicationSyncOperation, { readonly type: 'crossref_redeposit' }>, 'payloadHash'>
): string {
	const prefix = (input.crossref?.batchIdPrefix?.trim() || 'doi-sync').replace(/[^A-Za-z0-9._-]+/g, '-');
	return [prefix, plan.record.recordKey, operation.payloadHash.slice(0, 24)]
		.map((part) => part.replace(/[^A-Za-z0-9._-]+/g, '-'))
		.join('-');
}

function crossrefPendingResult(
	type: 'crossref_redeposit' | 'crossref_verify_pending',
	outcome: Extract<CrossrefDepositOutcome, { readonly status: 'pending' }>,
	submittedAt: Date,
	stage: 'relation_clear' | 'deposit',
	batchId: string
): PublicationSyncOperationResult {
	return {
		type,
		status: 'pending',
		pendingClass: 'CROSSREF_PENDING',
		pendingSummary: outcome.xmlVerification?.reason ?? `Crossref submission ${outcome.filename} is still pending`,
		crossref: { stage, batchId, filename: outcome.filename, submittedAt }
	};
}

function toSettlementIdentifiers(identifiers: ZenodoRecordIdentifiers): ZenodoSettlementIdentifiers {
	return {
		latestRecordId: identifiers.latestRecordId,
		parentId: identifiers.parentId,
		...(identifiers.versionDoi ? { versionDoi: identifiers.versionDoi } : {}),
		...(identifiers.conceptDoi ? { conceptDoi: identifiers.conceptDoi } : {})
	};
}

function operationFileManifestHash(
	operation: ZenodoPreparationOperation
): { readonly fileManifestHash?: string } {
	return 'fileManifestHash' in operation
		? { fileManifestHash: operation.fileManifestHash }
		: {};
}

function operationFileCorrectionApproval(
	operation: ZenodoPreparationOperation
) {
	return operation.type === 'zenodo_file_update'
		? { fileCorrectionApproval: operation.approval }
		: {};
}

function fileCorrectionDeadlinePassed(
	operation:
		| ZenodoPreparationOperation
		| Extract<ZenodoSyncOperation, { readonly type: 'zenodo_publish_journaled_draft' }>,
	observedAt: Date
): boolean {
	if (operation.type === 'zenodo_file_update') return observedAt > operation.publishBy;
	if (operation.type !== 'zenodo_publish_journaled_draft') return false;
	return operation.originalOperationType === 'zenodo_file_update'
		&& (operation.publishBy === undefined || observedAt > operation.publishBy);
}

async function discardExpiredFileCorrection(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	resultType: PublicationSyncOperation['type'],
	draft: ZenodoPreparedDraft,
	observedAt: Date
): Promise<PublicationSyncOperationResult> {
	try {
		await requireZenodoProvider(input).discardPreparedDraft({
			token: requireZenodoToken(input),
			operationType: 'zenodo_file_update',
			draft
		});
		await input.zenodoJournal?.clearZenodoPublishDraft({
			recordId: plan.record.recordKey,
			environment: requireZenodoTarget(plan).environment,
			depositionId: draft.depositionId,
			observedAt
		});
		return failed(
			resultType,
			'ZENODO_FILE_CORRECTION_WINDOW_CLOSED',
			'The Zenodo file correction was not published before its 45-day deadline'
		);
	} catch (error) {
		return failedFromError(resultType, error);
	}
}

interface ZenodoDoiConflictRecovery {
	readonly result: PublicationSyncOperationResult;
	readonly identifiers?: ZenodoRecordIdentifiers;
}

async function recoverZenodoDoiConflict(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	operationType: PublicationSyncOperation['type'],
	error: unknown
): Promise<ZenodoDoiConflictRecovery | null> {
	if (!isZenodoDoiAlreadyExistsError(error)) return null;
	const doi = plan.identifiers.managedCrossrefDoi;
	if (!doi || !plan.targets.zenodo.enabled || plan.targets.zenodo.identifierPolicy !== 'reuse-crossref') {
		return {
			result: failed(operationType, 'ZENODO_DOI_ALREADY_EXISTS_UNEXPECTED',
				'Zenodo reported a DOI collision for a record that does not reuse a Crossref DOI')
		};
	}
	const lookup = await requireZenodoProvider(input).findRecordByDoi?.({
		token: requireZenodoToken(input),
		doi
	});
	if (lookup?.status === 'found') {
		return {
			identifiers: lookup.record.identifiers,
			result: {
				type: operationType,
				status: 'succeeded',
				zenodoAdoptionOnly: true,
				zenodoPublishedAt: lookup.record.identifiers.publishedAt,
				zenodo: toSettlementIdentifiers(lookup.record.identifiers)
			}
		};
	}
	return {
		result: failed(operationType, 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED',
			unresolvedZenodoDoiConflictSummary(doi, lookup))
	};
}

function isZenodoDoiAlreadyExistsError(error: unknown): boolean {
	return error instanceof ProviderHttpError
		&& error.provider === 'zenodo'
		&& error.status === 400
		&& /pids\.doi/i.test(error.body)
		&& /already exists/i.test(error.body);
}

function unresolvedZenodoDoiConflictSummary(
	doi: string,
	lookup: ZenodoDoiLookupResult | undefined
): string {
	if (!lookup) return `Zenodo says DOI ${doi} already exists, but DOI lookup is unavailable`;
	if (lookup.status === 'not_found') return `Zenodo says DOI ${doi} already exists, but exact DOI lookup found no record`;
	if (lookup.status === 'ambiguous') return `Zenodo says DOI ${doi} already exists, but exact DOI lookup found multiple records: ${lookup.recordIds.join(', ')}`;
	return `Zenodo says DOI ${doi} already exists, but the existing record could not be adopted`;
}

function orphanCreateDraftCleanup(
	operationType: ZenodoPublishJournalOperationType,
	draft: ZenodoPreparedDraft,
	adopted: ZenodoRecordIdentifiers
): { readonly depositionId: string } | undefined {
	if (operationType !== 'zenodo_create') return undefined;
	if (adopted.latestRecordId === draft.depositionId || adopted.latestRecordId === draft.draftRecordId) return undefined;
	return { depositionId: draft.depositionId };
}

async function cleanupOrphanCreateDraft(
	input: ExecuteLivePublicationSyncPlanInput,
	plan: WriteRequiredPublicationSyncPlan,
	orphanDraftCleanup: { readonly depositionId: string } | undefined
): Promise<ZenodoOrphanDraftCleanup | undefined> {
	if (!orphanDraftCleanup) return undefined;
	const provider = requireZenodoProvider(input);
	if (!provider.deleteUnpublishedDraft) {
		return {
			status: 'failed',
			depositionId: orphanDraftCleanup.depositionId,
			failureClass: 'ZENODO_ORPHAN_DRAFT_CLEANUP_UNAVAILABLE',
			failureSummary: 'Zenodo provider cannot delete the orphaned unpublished draft'
		};
	}
	try {
		await provider.deleteUnpublishedDraft({
			token: requireZenodoToken(input),
			depositionId: orphanDraftCleanup.depositionId
		});
		await input.zenodoJournal?.clearZenodoOrphanDraftCleanup({
			recordId: plan.record.recordKey,
			environment: requireZenodoTarget(plan).environment,
			depositionId: orphanDraftCleanup.depositionId,
			observedAt: input.now?.() ?? new Date()
		});
		return { status: 'deleted', depositionId: orphanDraftCleanup.depositionId };
	} catch (error) {
		return {
			status: 'failed',
			depositionId: orphanDraftCleanup.depositionId,
			failureClass: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
			failureSummary: error instanceof Error ? error.message : String(error)
		};
	}
}

function withCleanup(
	result: PublicationSyncOperationResult,
	cleanup: ZenodoOrphanDraftCleanup | undefined
): PublicationSyncOperationResult {
	return cleanup && result.status === 'succeeded'
		? { ...result, zenodoOrphanDraftCleanup: cleanup }
		: result;
}

function failed(
	type: PublicationSyncOperation['type'],
	failureClass: string,
	failureSummary: string
): PublicationSyncOperationResult {
	return { type, status: 'failed', failureClass, failureSummary };
}

function failedFromError(
	type: PublicationSyncOperation['type'],
	error: unknown
): PublicationSyncOperationResult {
	return error instanceof Error
		? failed(type, error.name, error.message)
		: failed(type, 'UNKNOWN_ERROR', String(error));
}

function unreachable(value: never): never {
	throw new Error(`Unsupported publication operation: ${JSON.stringify(value)}`);
}

function requireCrossrefProvider(input: ExecuteLivePublicationSyncPlanInput): CrossrefDepositor {
	if (!input.providers.crossref) throw new Error('Crossref execution requires a Crossref provider');
	return input.providers.crossref;
}

function requireCrossrefRecord(
	plan: WriteRequiredPublicationSyncPlan
): NonNullable<WriteRequiredPublicationSyncPlan['crossrefRecord']> {
	if (!plan.crossrefRecord) throw new Error('Crossref execution requires a mapped Crossref record');
	return plan.crossrefRecord;
}

function requireCrossrefConfig(input: ExecuteLivePublicationSyncPlanInput): LiveExecutorCrossrefConfig {
	if (!input.crossref) throw new Error('Crossref execution requires Crossref configuration');
	return input.crossref;
}

function requireZenodoProvider(input: ExecuteLivePublicationSyncPlanInput): ZenodoWriter {
	if (!input.providers.zenodo) throw new Error('Zenodo execution requires a Zenodo provider');
	return input.providers.zenodo;
}

function requireZenodoToken(input: ExecuteLivePublicationSyncPlanInput): string {
	if (!input.credentials.zenodoToken) throw new Error('Zenodo execution requires a token');
	return input.credentials.zenodoToken;
}

function requireFileReader(input: ExecuteLivePublicationSyncPlanInput): PublicationFileReader {
	if (!input.fileReader) throw new Error('Zenodo file execution requires a file reader');
	return input.fileReader;
}

function requireCrossrefTarget(
	plan: WriteRequiredPublicationSyncPlan
): Extract<CrossrefTargetPolicy, { readonly enabled: true }> {
	if (!plan.targets.crossref.enabled) throw new Error('Crossref operation requires an enabled target');
	return plan.targets.crossref;
}

function requireZenodoTarget(
	plan: WriteRequiredPublicationSyncPlan
): Extract<ZenodoTargetPolicy, { readonly enabled: true }> {
	if (!plan.targets.zenodo.enabled) throw new Error('Zenodo operation requires an enabled target');
	return plan.targets.zenodo;
}
