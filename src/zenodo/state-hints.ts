import type { ExternalSyncState } from '../planner.js';
import type { SyncHashes } from '../planner.js';
import type { ZenodoPublishJournalEntry } from './journal.js';
import type { ZenodoRecordSnapshot, ZenodoVerificationResult } from './records.js';
import type { FileManifest } from '../files.js';
import { sha256Hex } from '../hash.js';
import { compareCodeUnits } from '../sort.js';
import { buildFileManifestSnapshot } from '../snapshots.js';
import { parseManagedExtraIdentifiers } from '../zotero/writeback.js';

export interface ZoteroWritebackZenodoHint {
  readonly latestRecordId: string;
  readonly parentId?: string;
}

export function readZoteroWritebackZenodoHint(extra: string | null | undefined): ZoteroWritebackZenodoHint | undefined {
  const identifiers = parseManagedExtraIdentifiers(extra);
  if (!identifiers.zenodoLatestRecordId) return undefined;
  return {
    latestRecordId: identifiers.zenodoLatestRecordId,
    ...(identifiers.zenodoParentId ? { parentId: identifiers.zenodoParentId } : {})
  };
}

export function mergeZenodoVerificationIntoState(input: {
  readonly state?: ExternalSyncState;
  readonly verified: ZenodoVerificationResult;
}): ExternalSyncState {
  const state = withoutResolvedZenodoDoiRecoveryFailure(input.state);
  if (input.verified.kind === 'legacy_unsubmitted_deposition') {
    return {
      ...withoutPublishedZenodoRecordState(state),
      zenodoLegacyDepositionId: input.verified.deposition.depositionId,
      zenodoLegacyDepositionState: input.verified.deposition.state
    };
  }

  return mergePublishedZenodoIdentifiers(state, input.verified);
}

export function recoverZenodoStateFromZoteroWritebackVerification(input: {
  readonly state?: ExternalSyncState;
  readonly hint: ZoteroWritebackZenodoHint;
  readonly verified: ZenodoVerificationResult | null;
}): ExternalSyncState | undefined {
  if (input.state?.zenodoLatestRecordId === input.hint.latestRecordId) return undefined;
  if (!input.verified) return undefined;
  if (!zoteroWritebackHintMatchesVerifiedRecord(input.hint, input.verified)) return undefined;

  return {
    ...mergeZenodoVerificationIntoState({
      ...(input.state ? { state: input.state } : {}),
      verified: input.verified
    }),
    zenodoRecoveredFromZoteroWriteback: true
  };
}

function zoteroWritebackHintMatchesVerifiedRecord(
  hint: ZoteroWritebackZenodoHint,
  verified: ZenodoVerificationResult
): boolean {
  if (!hint.parentId) return true;
  if (verified.kind === 'published_record') return verified.identifiers.parentId === hint.parentId;
  return verified.deposition.conceptRecordId === hint.parentId;
}

export function recoverZenodoStateFromPublishJournalVerification(input: {
  readonly state?: ExternalSyncState;
  readonly journal: ZenodoPublishJournalEntry;
  readonly verified: ZenodoVerificationResult | null;
}): ExternalSyncState | undefined {
  if (input.verified?.kind === 'published_record') {
    if (input.journal.status !== 'ready_to_publish' && input.journal.status !== 'published') return undefined;
    const hashesAreKnownToBelongToPublishedRecord = journalDraftMatchesPublishedRecord(input.journal, input.verified);
    return {
      ...mergePublishedZenodoIdentifiers(input.state, input.verified),
      zenodoRecoveredFromPrePublishJournal: true,
      ...(hashesAreKnownToBelongToPublishedRecord ? { zenodoRecoveredZenodoPayloadHash: input.journal.zenodoPayloadHash } : {}),
      ...(hashesAreKnownToBelongToPublishedRecord && input.journal.fileManifestHash ? { zenodoRecoveredFileManifestHash: input.journal.fileManifestHash } : {})
    };
  }

  if (input.verified?.kind === 'legacy_unsubmitted_deposition') {
    const legacyState = {
      ...withoutPublishedZenodoRecordState(input.state),
      zenodoLegacyDepositionId: input.verified.deposition.depositionId,
      zenodoLegacyDepositionState: input.verified.deposition.state
    };
    if (input.journal.status === 'preparing') return legacyState;

    return {
      ...legacyState,
      zenodoJournaledDraftOperationType: input.journal.operationType,
      zenodoJournaledDraftDepositionId: input.journal.depositionId,
      zenodoJournaledDraftRecordId: input.journal.draftRecordId,
      ...(input.journal.parentId ? { zenodoJournaledDraftParentId: input.journal.parentId } : {}),
      zenodoRecoveredZenodoPayloadHash: input.journal.zenodoPayloadHash,
      ...(input.journal.fileManifestHash ? { zenodoRecoveredFileManifestHash: input.journal.fileManifestHash } : {})
    };
  }

  return undefined;
}

function withoutPublishedZenodoRecordState(state: ExternalSyncState | undefined): ExternalSyncState | undefined {
  if (!state) return undefined;
  const retained: MutablePartialExternalSyncState = { ...state };
  delete retained.zenodoPayloadHash;
  delete retained.zenodoPayloadSnapshot;
  delete retained.fileManifestHash;
  delete retained.fileManifestSnapshot;
  delete retained.previousAttachmentKeys;
  delete retained.previousFiles;
  delete retained.zenodoLatestRecordId;
  delete retained.zenodoParentId;
  delete retained.zenodoConceptDoi;
  delete retained.zenodoVersionDoi;
  return retained;
}

function withoutResolvedZenodoDoiRecoveryFailure(state: ExternalSyncState | undefined): ExternalSyncState | undefined {
  if (!state || !isZenodoDoiRecoveryFailure(state.lastFailureClass)) return state;
  const retained: MutablePartialExternalSyncState = { ...state };
  delete retained.lastFailureClass;
  delete retained.lastFailureSummary;
  delete retained.consecutiveFailureCount;
  return retained;
}

function isZenodoDoiRecoveryFailure(value: string | null | undefined): boolean {
  return value === 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED'
    || value === 'ZENODO_DOI_LOOKUP_AMBIGUOUS';
}

type MutablePartialExternalSyncState = {
  -readonly [Key in keyof ExternalSyncState]?: ExternalSyncState[Key];
};

/** Recovers missing worker file state when the current Zenodo record already has the same file md5 set as Zotero. */
export function recoverZenodoFileStateFromSnapshot(input: {
  readonly state?: ExternalSyncState;
  readonly fileManifest: FileManifest;
  readonly snapshot?: ZenodoRecordSnapshot | null;
}): ExternalSyncState | undefined {
  const state = input.state;
  if (!state?.zenodoLatestRecordId) return state;
  if (!input.snapshot) return state;
  if (input.snapshot.identifiers.latestRecordId !== state.zenodoLatestRecordId) return state;
  if (hasBlockingFileConflict(input.fileManifest)) return state;
  if (!fileChecksumsMatch(input.fileManifest, input.snapshot)) return state;

  const fileManifestSnapshot = buildFileManifestSnapshot(input.fileManifest);
  return {
    ...state,
    previousAttachmentKeys: input.fileManifest.files.map((file) => file.zoteroAttachmentKey),
    fileManifestHash: sha256Hex(fileManifestSnapshot),
    fileManifestSnapshot,
    zenodoRecoveredFromFileSnapshot: true
  };
}

function journalDraftMatchesPublishedRecord(
  journal: ZenodoPublishJournalEntry,
  verified: Extract<ZenodoVerificationResult, { readonly kind: 'published_record' }>
): boolean {
  const publishedRecordId = journal.publishedRecordId ?? verified.identifiers.latestRecordId;
  return publishedRecordId === journal.draftRecordId
    || publishedRecordId === journal.depositionId;
}

export function zenodoPublishJournalVerificationRecordIds(journal: ZenodoPublishJournalEntry): readonly string[] {
  return uniqueStrings([
    journal.publishedRecordId ?? undefined,
    journal.draftRecordId,
    journal.depositionId
  ]);
}

export function isRecoveredZenodoCurrent(state: ExternalSyncState | undefined, hashes: SyncHashes): boolean {
  if (state?.zenodoRecoveredFromFileSnapshot === true) {
    return state.zenodoPayloadHash === hashes.zenodoPayloadHash
      && state.fileManifestHash === hashes.fileManifestHash;
  }
  if (state?.zenodoRecoveredFromZoteroWriteback === true) {
    return state.zenodoPayloadHash === hashes.zenodoPayloadHash
      && state.fileManifestHash === hashes.fileManifestHash;
  }
  if (state?.zenodoRecoveredFromPrePublishJournal !== true) return false;
  return state.zenodoRecoveredZenodoPayloadHash === hashes.zenodoPayloadHash
    && state.zenodoRecoveredFileManifestHash === hashes.fileManifestHash;
}

function mergePublishedZenodoIdentifiers(
  state: ExternalSyncState | undefined,
  verified: Extract<ZenodoVerificationResult, { readonly kind: 'published_record' }>
): ExternalSyncState {
  return {
    ...state,
    zenodoLatestRecordId: verified.identifiers.latestRecordId,
    zenodoParentId: verified.identifiers.parentId,
    ...(verified.identifiers.conceptDoi ? { zenodoConceptDoi: verified.identifiers.conceptDoi } : {}),
    ...(verified.identifiers.versionDoi ? { zenodoVersionDoi: verified.identifiers.versionDoi } : {})
  };
}

function uniqueStrings(values: readonly (string | undefined)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function hasBlockingFileConflict(fileManifest: FileManifest): boolean {
  return fileManifest.unsupported.some((attachment) => attachment.blocksZenodoFiles === true);
}

function fileChecksumsMatch(fileManifest: FileManifest, snapshot: ZenodoRecordSnapshot): boolean {
  const zoteroMd5s = sortedZoteroMd5s(fileManifest);
  if (!zoteroMd5s) return false;
  const zenodoMd5s = sortedZenodoMd5s(snapshot);
  if (!zenodoMd5s) return false;
  return arraysEqual(zoteroMd5s, zenodoMd5s);
}

function sortedZoteroMd5s(fileManifest: FileManifest): readonly string[] | null {
  const md5s: string[] = [];
  for (const file of fileManifest.files) {
    const md5 = normalizeMd5(file.zoteroMd5);
    if (!md5) return null;
    md5s.push(md5);
  }
  return md5s.sort(compareCodeUnits);
}

function sortedZenodoMd5s(snapshot: ZenodoRecordSnapshot): readonly string[] | null {
  const md5s: string[] = [];
  for (const file of snapshot.files) {
    const md5 = normalizeZenodoMd5Checksum(file.checksum);
    if (!md5) return null;
    md5s.push(md5);
  }
  return md5s.sort(compareCodeUnits);
}

function normalizeZenodoMd5Checksum(checksum: string | undefined): string | null {
  const trimmed = checksum?.trim().toLowerCase();
  if (!trimmed) return null;
  return normalizeMd5(trimmed.startsWith('md5:') ? trimmed.slice(4) : trimmed);
}

function normalizeMd5(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;
  return /^[a-f0-9]{32}$/.test(trimmed) ? trimmed : null;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
