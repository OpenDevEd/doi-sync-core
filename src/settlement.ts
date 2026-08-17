import type { JsonValue } from './hash.js';
import { isCrossrefOperation, isZenodoOperation } from './operations.js';
import type { PublicationSyncOperation, PublicationSyncPlan } from './planner.js';
import type {
	ProviderSyncFailureProvider,
	ProviderSyncState,
	ZenodoProviderIdentifiers
} from './publication/state.js';

export interface CrossrefPendingSettlement {
	readonly stage: 'relation_clear' | 'deposit';
	readonly batchId?: string;
	readonly filename?: string;
	readonly submittedAt?: Date;
}

export type ZenodoSettlementIdentifiers = ZenodoProviderIdentifiers;

export interface ZenodoOrphanDraftCleanup {
	readonly status: 'deleted' | 'failed';
	readonly depositionId: string;
	readonly failureClass?: string;
	readonly failureSummary?: string;
}

export type PublicationSyncOperationResult =
	| {
		readonly type: PublicationSyncOperation['type'];
		readonly status: 'succeeded';
		readonly zenodo?: ZenodoSettlementIdentifiers;
		readonly zenodoPublishedAt?: Date;
		readonly zenodoAdoptionOnly?: boolean;
		readonly zenodoOrphanDraftCleanup?: ZenodoOrphanDraftCleanup;
		readonly zenodoPayloadSnapshot?: JsonValue;
	}
	| {
		readonly type: PublicationSyncOperation['type'];
		readonly status: 'skipped';
		readonly reason: string;
	}
	| {
		readonly type: 'crossref_redeposit' | 'crossref_verify_pending';
		readonly status: 'pending';
		readonly pendingClass: string;
		readonly pendingSummary: string;
		readonly crossref: CrossrefPendingSettlement;
	}
	| {
		readonly type: PublicationSyncOperation['type'];
		readonly status: 'failed';
		readonly failureClass: string;
		readonly failureSummary: string;
	};

export interface ProviderSyncStatePatch {
	readonly crossref?: {
		readonly environment: NonNullable<ProviderSyncState['crossref']>['environment'];
		readonly lastSuccess?: NonNullable<ProviderSyncState['crossref']>['lastSuccess'];
		readonly pending?: NonNullable<ProviderSyncState['crossref']>['pending'] | null;
	};
	readonly zenodo?: {
		readonly environment: NonNullable<ProviderSyncState['zenodo']>['environment'];
		readonly identifierPolicy: NonNullable<ProviderSyncState['zenodo']>['identifierPolicy'];
		readonly firstPublishedAt?: Date;
		readonly consumedFileCorrectionApprovalIds?: readonly string[];
		readonly lastSuccess?: NonNullable<ProviderSyncState['zenodo']>['lastSuccess'];
		readonly identifiers?: ZenodoProviderIdentifiers;
		readonly orphanDraftCleanup?: NonNullable<ProviderSyncState['zenodo']>['orphanDraftCleanup'] | null;
	};
	readonly failure?: ProviderSyncState['failure'] | null;
}

export interface SettlePublicationSyncInput {
	readonly plan: PublicationSyncPlan;
	readonly previousState?: ProviderSyncState;
	readonly operationResults?: readonly PublicationSyncOperationResult[];
	readonly observedAt: Date;
	readonly crossrefPendingMaxAgeMs?: number;
}

export interface PublicationSyncSettlement {
	readonly statePatch: ProviderSyncStatePatch;
}

export interface SettleProviderSyncFailureInput {
	readonly previousState?: ProviderSyncState;
	readonly provider: ProviderSyncFailureProvider;
	readonly failureClass: string;
	readonly failureSummary: string;
}

/** Creates a durable failure patch for errors outside a provider plan. */
export function settleProviderSyncFailure(
	input: SettleProviderSyncFailureInput
): ProviderSyncStatePatch {
	return {
		failure: nextFailure(
			input.previousState,
			input.provider,
			input.failureClass,
			input.failureSummary
		)
	};
}

/** Advances only last-success provider state represented by successful operations. */
export function settlePublicationSyncState(
	input: SettlePublicationSyncInput
): PublicationSyncSettlement {
	if (input.plan.status === 'needs_attention') {
		return {
			statePatch: {
				failure: nextFailure(input.previousState, input.plan.provider, input.plan.reason,
					`Record is unsafe to sync: ${input.plan.reason}`)
			}
		};
	}

	if (input.plan.status === 'skipped' || input.plan.status === 'waiting_for_file') {
		return { statePatch: {} };
	}

	const actionableInput = input as SettlePublicationSyncInput & {
		readonly plan: Extract<PublicationSyncPlan, { readonly snapshots: unknown }>;
	};
	const results = input.operationResults ?? [];
	const crossrefPatch = settleCrossref(actionableInput, results);
	const zenodoPatch = settleZenodo(actionableInput, results);
	const failedResult = results.find((result) => result.status === 'failed');
	const nestedCleanupFailure = results.find((result) => (
		result.status === 'succeeded' && result.zenodoOrphanDraftCleanup?.status === 'failed'
	));
	const pendingResult = results.find((result) => result.status === 'pending');
	const everyOperationAccountedFor = input.plan.operations.every((operation) => (
		results.some((result) => result.type === operation.type)
	));

	let failure: ProviderSyncStatePatch['failure'];
	if (failedResult?.status === 'failed') {
		failure = nextFailure(
			input.previousState,
			providerForOperation(failedResult.type),
			failedResult.failureClass,
			failedResult.failureSummary
		);
	} else if (nestedCleanupFailure?.status === 'succeeded') {
		const cleanup = nestedCleanupFailure.zenodoOrphanDraftCleanup;
		failure = nextFailure(
			input.previousState,
			'zenodo',
			cleanup?.failureClass ?? 'ZENODO_ORPHAN_DRAFT_CLEANUP_FAILED',
			cleanup?.failureSummary ?? 'Zenodo orphaned draft cleanup failed'
		);
	} else if (pendingResult?.status === 'pending') {
		failure = stalePendingFailure(input, pendingResult) ?? (
			everyOperationAccountedFor ? null : undefined
		);
	} else if (input.plan.status === 'noop' || everyOperationAccountedFor) {
		failure = null;
	}

	return {
		statePatch: {
			...(crossrefPatch ? { crossref: crossrefPatch } : {}),
			...(zenodoPatch ? { zenodo: zenodoPatch } : {}),
			...(failure === undefined ? {} : { failure })
		}
	};
}

function settleCrossref(
	input: SettlePublicationSyncInput & { readonly plan: Extract<PublicationSyncPlan, { readonly snapshots: unknown }> },
	results: readonly PublicationSyncOperationResult[]
): ProviderSyncStatePatch['crossref'] | undefined {
	let lastSuccess: NonNullable<ProviderSyncState['crossref']>['lastSuccess'] | undefined;
	let pending: NonNullable<ProviderSyncState['crossref']>['pending'] | null | undefined;
	for (const operation of input.plan.operations) {
		if (!isCrossrefOperation(operation)) continue;
		const result = resultFor(results, operation.type);
		if (result?.status === 'succeeded') {
			lastSuccess = {
				payloadHash: operation.payloadHash,
				...(input.plan.snapshots.crossrefPayload
					? { payloadSnapshot: input.plan.snapshots.crossrefPayload }
					: {})
			};
			pending = null;
		}
		if (result?.status === 'pending') {
			const previousPending = input.previousState?.crossref?.pending;
			const batchId = result.crossref?.batchId ?? previousPending?.batchId;
			const filename = result.crossref?.filename ?? previousPending?.filename;
			pending = {
				stage: result.crossref.stage,
				payloadHash: operation.payloadHash,
				...(input.plan.snapshots.crossrefPayload
					? { payloadSnapshot: input.plan.snapshots.crossrefPayload }
					: {}),
				...(batchId ? { batchId } : {}),
				...(filename ? { filename } : {}),
				submittedAt: result.crossref?.submittedAt ?? previousPending?.submittedAt ?? input.observedAt,
				reason: result.pendingSummary
			};
		}
		if (result?.status === 'failed' && operation.type === 'crossref_redeposit') pending = null;
	}
	if (!lastSuccess && pending === undefined) return undefined;
	if (!input.plan.targets.crossref.enabled) return undefined;
	return {
		environment: input.plan.targets.crossref.environment,
		...(lastSuccess ? { lastSuccess } : {}),
		...(pending === undefined ? {} : { pending })
	};
}

function settleZenodo(
	input: SettlePublicationSyncInput & { readonly plan: Extract<PublicationSyncPlan, { readonly snapshots: unknown }> },
	results: readonly PublicationSyncOperationResult[]
): ProviderSyncStatePatch['zenodo'] | undefined {
	let lastSuccess: NonNullable<ProviderSyncState['zenodo']>['lastSuccess'] | undefined;
	let identifiers: ZenodoProviderIdentifiers | undefined;
	let firstPublishedAt: Date | undefined;
	let consumedFileCorrectionApprovalIds: readonly string[] | undefined;
	let orphanDraftCleanup: NonNullable<ProviderSyncState['zenodo']>['orphanDraftCleanup'] | null | undefined;
	for (const operation of input.plan.operations) {
		if (!isZenodoOperation(operation)) continue;
		if (operation.type === 'zenodo_cleanup_orphan_draft') {
			const result = resultFor(results, operation.type);
			if (result?.status === 'succeeded') orphanDraftCleanup = null;
			continue;
		}
		if (
			operation.type === 'zenodo_discard_preparing_draft'
			|| operation.type === 'zenodo_discard_expired_file_correction'
		) continue;
		const result = resultFor(results, operation.type);
		if (result?.status !== 'succeeded') continue;
		if (result.zenodo) identifiers = result.zenodo;
		if (!input.previousState?.zenodo?.firstPublishedAt && result.zenodoPublishedAt) {
			firstPublishedAt = result.zenodoPublishedAt;
		}
		if (result.zenodoOrphanDraftCleanup?.status === 'failed') {
			orphanDraftCleanup = { depositionId: result.zenodoOrphanDraftCleanup.depositionId };
		}
		if (result.zenodoOrphanDraftCleanup?.status === 'deleted') orphanDraftCleanup = null;
		if (result.zenodoAdoptionOnly) continue;
		const previous = lastSuccess ?? input.previousState?.zenodo?.lastSuccess;
		const writesMetadata = zenodoOperationWritesMetadata(operation);
		const writesFiles = zenodoOperationWritesFiles(operation);
		const payloadHash = writesMetadata ? operation.payloadHash : previous?.payloadHash;
		if (!payloadHash) continue;
		const fileManifestHash = writesFiles && 'fileManifestHash' in operation
			? operation.fileManifestHash
			: previous?.fileManifestHash;
		const fileCorrectionApprovalId = operation.type === 'zenodo_file_update'
			? operation.approval.id
			: operation.type === 'zenodo_publish_journaled_draft'
				&& operation.originalOperationType === 'zenodo_file_update'
				? operation.fileCorrectionApproval?.id
				: undefined;
		if (fileCorrectionApprovalId) {
			consumedFileCorrectionApprovalIds = [
				...new Set([
					...(input.previousState?.zenodo?.consumedFileCorrectionApprovalIds ?? []),
					fileCorrectionApprovalId
				])
			];
		}
		const payloadSnapshot = writesMetadata
			? result.zenodoPayloadSnapshot ?? (
				operation.payloadHash === input.plan.hashes.zenodoPayloadHash
					? input.plan.snapshots.zenodoPayload
					: undefined
			)
			: previous?.payloadSnapshot;
		lastSuccess = {
			payloadHash,
			...(payloadSnapshot ? { payloadSnapshot } : {}),
			...(fileManifestHash ? { fileManifestHash } : {}),
			...(writesFiles && fileManifestHash === input.plan.hashes.fileManifestHash
				? { fileManifestSnapshot: input.plan.snapshots.fileManifest }
				: previous?.fileManifestSnapshot
					? { fileManifestSnapshot: previous.fileManifestSnapshot }
					: {})
		};
	}
	if (
		!lastSuccess
		&& !identifiers
		&& !firstPublishedAt
		&& !consumedFileCorrectionApprovalIds
		&& orphanDraftCleanup === undefined
	) {
		return undefined;
	}
	if (!input.plan.targets.zenodo.enabled) return undefined;
	const effectiveFirstPublishedAt = firstPublishedAt ?? input.previousState?.zenodo?.firstPublishedAt;
	const effectiveConsumedApprovalIds = consumedFileCorrectionApprovalIds
		?? input.previousState?.zenodo?.consumedFileCorrectionApprovalIds;
	return {
		environment: input.plan.targets.zenodo.environment,
		identifierPolicy: input.plan.targets.zenodo.identifierPolicy,
		...(effectiveFirstPublishedAt ? { firstPublishedAt: effectiveFirstPublishedAt } : {}),
		...(effectiveConsumedApprovalIds
			? { consumedFileCorrectionApprovalIds: effectiveConsumedApprovalIds }
			: {}),
		...(lastSuccess ? { lastSuccess } : {}),
		...(identifiers ? { identifiers } : {}),
		...(orphanDraftCleanup === undefined ? {} : { orphanDraftCleanup })
	};
}

function zenodoOperationWritesMetadata(operation: Extract<PublicationSyncOperation, { readonly type: `zenodo_${string}` }>): boolean {
	return operation.type !== 'zenodo_file_update'
		&& (
			operation.type !== 'zenodo_publish_journaled_draft'
			|| operation.originalOperationType !== 'zenodo_file_update'
		);
}

function zenodoOperationWritesFiles(operation: Extract<PublicationSyncOperation, { readonly type: `zenodo_${string}` }>): boolean {
	return operation.type === 'zenodo_create'
		|| operation.type === 'zenodo_file_update'
		|| operation.type === 'zenodo_new_version'
		|| (
			operation.type === 'zenodo_publish_journaled_draft'
			&& operation.originalOperationType !== 'zenodo_metadata_update'
		);
}

function resultFor(
	results: readonly PublicationSyncOperationResult[],
	type: PublicationSyncOperation['type']
): PublicationSyncOperationResult | undefined {
	return results.find((result) => result.type === type);
}

function providerForOperation(type: PublicationSyncOperation['type']): 'crossref' | 'zenodo' {
	return type.startsWith('crossref_') ? 'crossref' : 'zenodo';
}

function nextFailure(
	state: ProviderSyncState | undefined,
	provider: ProviderSyncFailureProvider,
	failureClass: string,
	summary: string
): NonNullable<ProviderSyncState['failure']> {
	return {
		provider,
		failureClass,
		summary,
		consecutiveCount: (state?.failure?.consecutiveCount ?? 0) + 1
	};
}

function stalePendingFailure(
	input: SettlePublicationSyncInput,
	result: Extract<PublicationSyncOperationResult, { readonly status: 'pending' }>
): NonNullable<ProviderSyncState['failure']> | undefined {
	if (result.pendingClass !== 'CROSSREF_PENDING' || input.crossrefPendingMaxAgeMs === undefined) {
		return undefined;
	}
	const submittedAt = result.crossref?.submittedAt
		?? input.previousState?.crossref?.pending?.submittedAt;
	if (!submittedAt) {
		return nextFailure(
			input.previousState,
			'crossref',
			'CROSSREF_PENDING_MISSING_SUBMITTED_AT',
			'Crossref pending verification cannot age out because submittedAt is missing'
		);
	}
	if (input.observedAt.getTime() - submittedAt.getTime() <= input.crossrefPendingMaxAgeMs) {
		return undefined;
	}
	return nextFailure(
		input.previousState,
		'crossref',
		'CROSSREF_PENDING_STALE',
		`Crossref pending verification exceeded the configured max age: ${result.pendingSummary}`
	);
}
