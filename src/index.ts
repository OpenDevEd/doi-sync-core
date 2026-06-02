/** Crossref XML deposit client for report-paper DOI metadata updates. */
export { CrossrefApiClient } from './crossref/client.js';
export type {
  CrossrefApiClientOptions,
  CrossrefDepositOutcome,
  CrossrefPollOptions,
  CrossrefReadWorkInput,
  CrossrefReportPaperDepositInput,
  CrossrefReportPaperVerifyInput,
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
export type { CrossrefIdentifierType, CrossrefRelation, CrossrefRelationType } from './crossref/xml.js';

/** Dry-run description builder used to render planned provider actions without writes. */
export { describeDryRunExecution } from './executor/dry-run-executor.js';
export type {
  DescribeDryRunExecutionInput,
  DryRunAction,
  DryRunExecutionDescription
} from './executor/dry-run-executor.js';

/** Live provider executor for already prepared sync plans. */
export { executeLiveSyncPlan } from './executor/live-executor.js';
export type {
  CrossrefSubmissionJournalWriter,
  CrossrefReportPaperDepositor,
  ExecuteLiveSyncPlanInput,
  LiveExecutorCrossrefConfig,
  ProviderExecutionContext,
  ProviderExecutionCredentials,
  RecordCrossrefPendingDepositInput,
  ZenodoLiveUploadFile,
  ZenodoPublishJournalWriter,
  ZenodoWriter,
  ZoteroWriter
} from './executor/live-executor.js';

/** Zotero attachment manifest helpers for Zenodo file planning. */
export { buildFileManifest, DEFAULT_ZOTERO_PDF_TAGS, diffFileManifest } from './files.js';
export type {
  AttachmentSelection,
  FileManifest,
  FileManifestDiff,
  FileManifestDiffInput,
  FileManifestEntry,
  UnsupportedAttachment,
  ZoteroChildItem
} from './files.js';

/** Intended-diff helpers for presenting exactly what a run would change. */
export { buildIntendedDiff } from './intended-diff.js';
export type {
  BuildIntendedDiffInput,
  IntendedDiff,
  IntendedDiffLine,
  IntendedDiffLineKind,
  IntendedDiffProvider,
  IntendedDiffSection
} from './intended-diff.js';

/** JSON value helpers used by persisted payload snapshots. */
export { jsonValueSchema } from './json.js';
export type { JsonObject } from './json.js';
export type { JsonPrimitive, JsonValue } from './hash.js';

/** Settlement helper for converting operation results into persisted worker-state patches. */
export { settleLiveSyncPlan } from './live-settlement.js';
export type { LiveSyncPlanSettlement, SettleLiveSyncPlanInput } from './live-settlement.js';

/** Small logger interface used by provider runners. */
export { createNoopLogger } from './logging.js';
export type { CoreLogger, LogFields, LogPrimitive, LogValue } from './logging.js';

/** Canonical Zotero metadata snapshot builder shared by Crossref and Zenodo payloads. */
export { buildCanonicalMetadataSnapshot } from './metadata.js';
export type {
  AuthorEnrichment,
  BuildCanonicalMetadataInput,
  CanonicalCreator,
  CanonicalMetadataSnapshot,
  ZoteroCreator,
  ZoteroParentItem,
  ZoteroRelations,
  ZoteroTag
} from './metadata.js';

/** Read-only provider metadata audit helpers for checking planned writes against live records. */
export { auditCrossrefDepositMetadata, auditZenodoWritePayloadMetadata } from './metadata-audit.js';
export type {
  AuditCrossrefDepositMetadataInput,
  AuditZenodoWritePayloadMetadataInput,
  MetadataAuditFinding,
  MetadataAuditProvider,
  MetadataAuditSeverity,
  MetadataAuditValue
} from './metadata-audit.js';

/** Stable high-level preparation entrypoint: plan plus intended diff plus optional Zotero select URL. */
export { prepareDoiSync } from './preparation.js';
export type { PreparedDoiSync, PrepareDoiSyncInput } from './preparation.js';

/** Public plan and state models consumed by hosts that persist sync state themselves. */
export type {
  DoiSyncRecord,
  ExternalSyncFileState,
  ExternalSyncState,
  PlanRecordSyncInput,
  SyncHashes,
  SyncOperation,
  SyncPlan,
  SyncPolicy
} from './planner.js';

/** Minimal ports implemented by host applications around Zotero and canonical item redirects. */
export type { CanonicalZoteroItemKeyResolver, ZoteroReader } from './ports.js';

/** Recovery helpers that hide Zotero replacement and Zenodo state-recovery internals. */
export { resolveCanonicalZoteroRecord, resolveZenodoSyncState } from './recovery.js';
export type {
  CanonicalZoteroRecordResolution,
  ResolvedCanonicalZoteroRecord,
  ResolvedZenodoSyncState,
  ResolveCanonicalZoteroRecordInput,
  ResolveZenodoSyncStateInput,
  ZenodoRecordByDoiFinder,
  ZenodoRecordVerifier,
  ZoteroItemSnapshot
} from './recovery.js';

/** Provider HTTP error surfaced by Crossref, Zenodo, and Zotero clients. */
export { ProviderHttpError } from './resilience/errors.js';
export type { ProviderHttpErrorInput, ProviderName } from './resilience/errors.js';

/** Provider operation runners for direct execution or retried/rate-limited execution. */
export { DirectProviderOperationRunner, ResilientProviderOperationRunner } from './resilience/provider-runner.js';
export type {
  ProviderOperationRunner,
  ResilientProviderOperationRunnerInput
} from './resilience/provider-runner.js';

/** Low-level settlement result models returned by live execution. */
export type {
  CrossrefPendingSettlement,
  ExternalSyncStatePatch,
  SettleSyncStateInput,
  SyncOperationResult,
  SyncStateSettlement,
  ZenodoOrphanDraftCleanup,
  ZenodoSettlementIdentifiers
} from './settlement.js';

/** Zenodo API client and payload helpers for current MEE DOI policies. */
export { effectiveZenodoDoiPolicy } from './zenodo/doi-policy.js';
export { recoverZenodoFileStateFromSnapshot } from './zenodo/state-hints.js';
export {
  buildZenodoWritePayload,
  ZENODO_INVENIORDM_ACCEPT
} from './zenodo/records.js';
export {
  ZenodoApiClient
} from './zenodo/client.js';
export type { EffectiveZenodoDoiPolicyInput } from './zenodo/doi-policy.js';
export type {
  DoiPolicy,
  ZenodoDoiLookupResult,
  ZenodoLegacyDepositionIdentifiers,
  ZenodoLegacyDepositionPayload,
  ZenodoRecordFileSnapshot,
  ZenodoPublishedRecordVerification,
  ZenodoRecordIdentifiers,
  ZenodoRecordSnapshot,
  ZenodoVerificationResult,
  ZenodoWritePayloadInput
} from './zenodo/records.js';
export type {
  FindZenodoRecordByDoiInput,
  ReadZenodoRecordSnapshotInput,
  VerifyZenodoRecordInput,
  ZenodoAdoptLegacyDepositionInput,
  ZenodoApiClientOptions,
  ZenodoCreateNewVersionInput,
  ZenodoCreateRecordInput,
  DeleteZenodoUnpublishedDraftInput,
  ZenodoFetchLike,
  ZenodoResponseLike,
  ZenodoUpdateRecordMetadataInput,
  ZenodoUploadFile
} from './zenodo/client.js';
export type {
  MarkZenodoPublishDraftPublishedInput,
  ProviderStateEnvironment,
  RecordZenodoPublishDraftInput,
  ZenodoPreparedDraft,
  ZenodoProviderEnvironment,
  ZenodoPublishJournalEntry,
  ZenodoPublishJournalOperationType,
  ZenodoPublishJournalStatus
} from './zenodo/journal.js';

/** Evidence Library redirect resolver for deleted Zotero item replacement lookups. */
export { EvidenceLibraryRedirectResolver } from './zotero/canonical-key-resolver.js';
export type {
  EvidenceLibraryRedirectResolverOptions,
  RedirectFetchLike,
  RedirectResponseLike
} from './zotero/canonical-key-resolver.js';

/** Zotero API client and writeback operation input models. */
export { ZoteroApiClient } from './zotero/client.js';
export type {
  AddTagsToZoteroItemInput,
  ApplyManagedZoteroWritebackInput,
  CreatedZoteroAttachment,
  CreateLinkedUrlAttachmentInput,
  DeleteZoteroItemInput,
  DownloadAttachmentFileInput,
  DownloadedAttachmentFile,
  ApplyDoiDriftAutofixInput,
  FetchLike as ZoteroFetchLike,
  PatchLinkedUrlAttachmentInput,
  PatchZoteroParentItemInput,
  ResponseHeadersLike as ZoteroResponseHeadersLike,
  ResponseLike as ZoteroResponseLike,
  ZoteroApiClientOptions
} from './zotero/client.js';

/** Zotero managed DOI/Zenodo link planning helpers. */
export { planZoteroIdentifierLinkReconciliation, planZoteroIdentifierLinks } from './zotero/identifier-links.js';
export type {
  ZoteroIdentifierLinkCreateRequest,
  ZoteroIdentifierLinkInput,
  ZoteroIdentifierLinkReconciliation
} from './zotero/identifier-links.js';

/** Zotero success tag planning compatible with legacy zotzen/zotero conventions. */
export {
  planZoteroSuccessTagApplications,
  ZOTERO_DOI_LIVE_TAG,
  ZOTERO_ZENODO_SUBMITTED_TAG,
  ZOTERO_ZENODO_UPLOADED_TAG
} from './zotero/success-tags.js';
export type { ZoteroSuccessTagApplication, ZoteroSuccessTagPlanInput } from './zotero/success-tags.js';

/** Zotero parent Extra/DOI/url writeback helpers for managed fields only. */
export {
  buildZoteroWritebackData,
  buildZoteroWritebackIdentifiers,
  mergeManagedExtraLines,
  parseManagedExtraIdentifiers,
  planZoteroDoiDriftAutofix,
  planZoteroWriteback
} from './zotero/writeback.js';
export type {
  BuildZoteroWritebackIdentifiersInput,
  ZoteroWritebackIdentifiers,
  ZoteroWritebackInput,
  ZoteroWritebackPlan
} from './zotero/writeback.js';
