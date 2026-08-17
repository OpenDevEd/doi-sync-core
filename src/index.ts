export { CrossrefApiClient } from './crossref/client.js';
export type {
	CrossrefApiClientOptions,
	CrossrefDepositOutcome,
	CrossrefPollOptions,
	CrossrefReadWorkInput,
	CrossrefPublicationDepositInput,
	CrossrefPublicationVerifyInput,
	CrossrefXmlApiVerification
} from './crossref/client.js';
export type { CrossrefEnvironment } from './crossref/deposit.js';
export type {
	CrossrefDiagnosticResult,
	CrossrefDiagnosticStatus,
	CrossrefRestRelation,
	CrossrefRestWork,
	CrossrefUnixrefRecord,
	CrossrefUnixrefRelation
} from './crossref/response.js';
export { mapCrossrefRecord } from './crossref/record-mapper.js';
export type {
	CrossrefMappedRecord,
	CrossrefRecordMappingResult,
	CrossrefRecordValidationIssue
} from './crossref/record-mapper.js';
export { buildCrossrefPublicationXml } from './crossref/xml.js';
export type {
	CrossrefDepositRelation,
	CrossrefIdentifierType,
	CrossrefRelation,
	CrossrefRelationType
} from './crossref/xml.js';

export { analyzeDoiDrift, normalizeDoi, resolveDoiCandidates } from './doi.js';
export type {
	DoiCandidate,
	DoiConflict,
	DoiDriftInput,
	DoiDriftResult,
	ResolvedDoi
} from './doi.js';

export { describeDryRun } from './executor/dry-run-executor.js';
export type {
	DryRunAction,
	DryRunExecutionDescription
} from './executor/dry-run-executor.js';

export { executeLivePublicationSyncPlan } from './executor/live-executor.js';
export type {
	CrossrefDepositor,
	CrossrefSubmissionJournalWriter,
	ExecuteLivePublicationSyncPlanInput,
	LiveExecutorCrossrefConfig,
	ProviderExecutionCredentials,
	RecordCrossrefPendingDepositInput,
	ZenodoLiveUploadFile,
	ZenodoPublishJournalWriter,
	ZenodoWriter
} from './executor/live-executor.js';

export { jsonValueSchema } from './json.js';
export type { JsonObject } from './json.js';
export type { JsonPrimitive, JsonValue } from './hash.js';

export {
	buildPublicationFileManifestHash,
	buildPublicationFileManifestSnapshot,
	parsePublicationFileManifest
} from './publication/files.js';
export type { PublicationFile, PublicationFileManifest } from './publication/files.js';
export {
	zenodoFileCorrectionApprovalSchema,
	zenodoFileCorrectionPublishDeadline,
	zenodoFileCorrectionStartDeadline,
	ZENODO_FILE_CORRECTION_COMPLETE_WINDOW_MS,
	ZENODO_FILE_CORRECTION_START_WINDOW_MS
} from './publication/file-corrections.js';
export type { ZenodoFileCorrectionApproval } from './publication/file-corrections.js';
export {
	parsePublicationIdentifiers,
	parsePublicationRecordSnapshot
} from './publication/record.js';
export type {
	CrossrefDepositMetadata,
	PublicationCreator,
	PublicationIdentifiers,
	PublicationMetadata,
	PublicationProviderMetadata,
	PublicationRecordSnapshot
} from './publication/record.js';
export type {
	CrossrefProviderSyncState,
	ProviderSyncFailureProvider,
	ProviderSyncState,
	ZenodoProviderIdentifiers,
	ZenodoProviderSyncState
} from './publication/state.js';
export { parseProviderSyncState } from './publication/state.js';
export { parsePublicationTargetPolicy } from './publication/targets.js';
export type {
	CrossrefTargetPolicy,
	PublicationTargetPolicy,
	ZenodoIdentifierPolicy,
	ZenodoTargetPolicy
} from './publication/targets.js';

export { planPublicationSync } from './planner.js';
export type {
	PlanPublicationSyncInput,
	PublicationSyncHashes,
	PublicationSyncOperation,
	PublicationSyncPlan,
	ZenodoRecordValidationIssue
} from './planner.js';
export type { PublicationFileReader } from './ports.js';

export {
	buildCrossrefPayloadSnapshot,
	buildPublicationPayloadHash,
	buildPublicationPayloadSnapshots,
	buildZenodoPayloadSnapshot,
	CROSSREF_PAYLOAD_FORMAT
} from './snapshots.js';
export type {
	BuildCrossrefPayloadSnapshotInput,
	BuildZenodoPayloadSnapshotInput,
	PublicationPayloadSnapshots
} from './snapshots.js';

export { settleProviderSyncFailure, settlePublicationSyncState } from './settlement.js';
export type {
	CrossrefPendingSettlement,
	ProviderSyncStatePatch,
	PublicationSyncOperationResult,
	PublicationSyncSettlement,
	SettleProviderSyncFailureInput,
	SettlePublicationSyncInput,
	ZenodoOrphanDraftCleanup,
	ZenodoSettlementIdentifiers
} from './settlement.js';
export { createNoopLogger } from './logging.js';
export type { CoreLogger, LogFields, LogPrimitive, LogValue } from './logging.js';
export { ProviderHttpError, retryAfterMsFromHeaders } from './resilience/errors.js';
export type {
	ProviderHttpErrorInput,
	ProviderName,
	ProviderResponseHeaders
} from './resilience/errors.js';
export {
	DirectProviderOperationRunner,
	ResilientProviderOperationRunner
} from './resilience/provider-runner.js';
export type {
	ProviderOperationRunner,
	ResilientProviderOperationRunnerInput
} from './resilience/provider-runner.js';

export { ZenodoApiClient } from './zenodo/client.js';
export type {
	DeleteZenodoUnpublishedDraftInput,
	DiscardZenodoPreparedDraftInput,
	FindZenodoDraftByDoiInput,
	FindZenodoRecordByDoiInput,
	ReadZenodoRecordSnapshotInput,
	VerifyZenodoPublishedStateInput,
	VerifyZenodoRecordInput,
	ZenodoAdoptLegacyDepositionInput,
	ZenodoApiClientOptions,
	ZenodoCreateNewVersionInput,
	ZenodoCreateRecordInput,
	ZenodoFetchLike,
	ZenodoResponseLike,
	ZenodoRemoteStateVerification,
	ZenodoUpdateRecordMetadataInput,
	ZenodoUploadFile
} from './zenodo/client.js';
export type {
	ClearZenodoOrphanDraftCleanupInput,
	MarkZenodoPublishDraftPublishedInput,
	ClearZenodoPublishDraftInput,
	RecordZenodoPublishDraftInput,
	ZenodoPreparedDraft,
	ZenodoProviderEnvironment,
	ZenodoPublishJournalEntry,
	ZenodoPublishJournalOperationType,
	ZenodoPublishJournalStatus
} from './zenodo/journal.js';
export { mapZenodoResourceType } from './zenodo/resource-mapper.js';
export type {
	ZenodoImageType,
	ZenodoPublicationType,
	ZenodoResourceType
} from './zenodo/resource-mapper.js';
export {
	buildZenodoWritePayload,
	parseZenodoLegacyDepositionPayload,
	ZENODO_INVENIORDM_ACCEPT
} from './zenodo/records.js';
export type {
	DoiPolicy,
	ZenodoDoiLookupResult,
	ZenodoLegacyDepositionIdentifiers,
	ZenodoLegacyDepositionPayload,
	ZenodoPublishedRecordVerification,
	ZenodoRecordFileSnapshot,
	ZenodoRecordIdentifiers,
	ZenodoRecordSnapshot,
	ZenodoUnsubmittedDraftDoiLookupResult,
	ZenodoVerificationResult,
	ZenodoWritePayloadInput
} from './zenodo/records.js';
export {
	parseZenodoLegacyDepositionFiles,
	verifyZenodoLegacyDepositionState
} from './zenodo/verification.js';
export type {
	ZenodoExpectedPublishedFile,
	ZenodoLegacyDepositionFile,
	ZenodoPublishedStateVerification
} from './zenodo/verification.js';
