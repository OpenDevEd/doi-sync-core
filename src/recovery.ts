import type { ZoteroChildItem } from './files.js';
import type { ZoteroParentItem } from './metadata.js';
import type { CanonicalZoteroItemKeyResolver } from './ports.js';
import type { DoiSyncRecord, ExternalSyncState } from './planner.js';
import type { ZenodoPublishJournalEntry } from './zenodo/journal.js';
import type { ZenodoDoiLookupResult, ZenodoVerificationResult } from './zenodo/records.js';
import {
  mergeZenodoVerificationIntoState,
  readZoteroWritebackZenodoHint,
  recoverZenodoStateFromPublishJournalVerification,
  recoverZenodoStateFromZoteroWritebackVerification,
  zenodoPublishJournalVerificationRecordIds
} from './zenodo/state-hints.js';
import {
  isDeletedZoteroItem,
  isValidCanonicalZoteroReplacement,
  withCanonicalPublicUrl
} from './zotero/canonical-replacement.js';

/** Parent item plus children as read from Zotero for one canonical item key. */
export interface ZoteroItemSnapshot {
  readonly parent: ZoteroParentItem;
  readonly children: readonly ZoteroChildItem[];
}

/** Explains when a deleted/stale Zotero item key was resolved to a replacement key. */
export interface CanonicalZoteroRecordResolution {
  readonly originalItemKey: string;
  readonly resolvedItemKey: string;
  readonly originalPublicItemUrl: string;
  readonly resolvedPublicItemUrl: string;
}

/** Input for resolving an MEE record from its original Zotero key to a canonical replacement. */
export interface ResolveCanonicalZoteroRecordInput {
  readonly record: DoiSyncRecord;
  readonly original: ZoteroItemSnapshot;
  readonly originalPublicItemUrl: string;
  readonly resolver?: CanonicalZoteroItemKeyResolver;
  readonly readReplacement: (itemKey: string) => Promise<ZoteroItemSnapshot>;
}

/** Zotero snapshot after optional deleted-item redirect recovery. */
export interface ResolvedCanonicalZoteroRecord extends ZoteroItemSnapshot {
  readonly record: DoiSyncRecord;
  readonly resolution?: CanonicalZoteroRecordResolution;
}

/** Verifies whether a Zenodo record/deposition id exists for the active organization token. */
export type ZenodoRecordVerifier = (recordId: string) => Promise<ZenodoVerificationResult | null>;

/** Finds a published Zenodo record by exact DOI for recovering state after worker DB loss. */
export type ZenodoRecordByDoiFinder = (doi: string) => Promise<ZenodoDoiLookupResult>;

/** Input for recovering Zenodo state from Zotero Extra, publish journal, or MEE's legacy record id. */
export interface ResolveZenodoSyncStateInput {
  readonly record: DoiSyncRecord;
  readonly existingState?: ExternalSyncState;
  readonly zoteroExtra?: string | null;
  readonly latestJournal?: ZenodoPublishJournalEntry;
  readonly verifyZenodoRecord: ZenodoRecordVerifier;
  readonly findZenodoRecordByDoi?: ZenodoRecordByDoiFinder;
}

/** MEE record and sync state after all safe Zenodo recovery hints have been verified. */
export interface ResolvedZenodoSyncState {
  readonly record: DoiSyncRecord;
  readonly syncState?: ExternalSyncState;
}

/** Resolves a deleted Zotero item to its valid replacement without mutating Zotero. */
export async function resolveCanonicalZoteroRecord(
  input: ResolveCanonicalZoteroRecordInput
): Promise<ResolvedCanonicalZoteroRecord> {
  if (!isDeletedZoteroItem(input.original.parent) || !input.resolver) {
    return {
      record: input.record,
      parent: input.original.parent,
      children: input.original.children
    };
  }

  const resolved = await input.resolver.resolveCanonicalItemKey({
    publicItemUrl: input.originalPublicItemUrl,
    originalItemKey: input.record.zoteroItemKey
  });
  if (!resolved) {
    return {
      record: input.record,
      parent: input.original.parent,
      children: input.original.children
    };
  }

  const replacement = await input.readReplacement(resolved.itemKey);
  if (!isValidCanonicalZoteroReplacement({
    originalItemKey: input.record.zoteroItemKey,
    recordDoi: input.record.crossrefDoi,
    replacement: replacement.parent
  })) {
    return {
      record: input.record,
      parent: input.original.parent,
      children: input.original.children
    };
  }

  return {
    record: {
      ...input.record,
      zoteroItemKey: replacement.parent.key,
      knownZenodoRecordId: null
    },
    parent: withCanonicalPublicUrl(replacement.parent, resolved.publicItemUrl),
    children: replacement.children,
    resolution: {
      originalItemKey: input.record.zoteroItemKey,
      resolvedItemKey: replacement.parent.key,
      originalPublicItemUrl: input.originalPublicItemUrl,
      resolvedPublicItemUrl: resolved.publicItemUrl
    }
  };
}

/** Recovers Zenodo state from verified hints before planning provider writes. */
export async function resolveZenodoSyncState(input: ResolveZenodoSyncStateInput): Promise<ResolvedZenodoSyncState> {
  const journalRecoveredState = await recoverFromPublishJournal(input);
  if (journalRecoveredState) {
    return {
      record: input.record,
      syncState: journalRecoveredState
    };
  }

  const zoteroRecoveredState = await recoverFromZoteroExtra(input);
  if (zoteroRecoveredState) {
    return {
      record: input.record,
      syncState: zoteroRecoveredState
    };
  }

  const existingRecoveredState = await recoverFromExistingState(input);
  if (existingRecoveredState) {
    return {
      record: input.record,
      syncState: existingRecoveredState
    };
  }
  const existingState = input.existingState?.zenodoLatestRecordId
    ? withoutZenodoRecordState(input.existingState)
    : input.existingState;
  const recoveryInput = existingState === input.existingState
    ? input
    : {
        ...input,
        ...(existingState ? { existingState } : {})
      };

  const knownZenodoRecordId = knownRecordId(input.record.knownZenodoRecordId);
  if (!knownZenodoRecordId) {
    const doiRecoveredState = await recoverFromDoi(recoveryInput);
    if (doiRecoveredState) {
      return {
        record: input.record,
        syncState: doiRecoveredState
      };
    }
    return {
      record: input.record,
      ...(existingState ? { syncState: existingState } : {})
    };
  }

  const verified = await recoveryInput.verifyZenodoRecord(knownZenodoRecordId);
  const record = verified ? input.record : { ...input.record, knownZenodoRecordId: null };
  if (!verified) {
    const doiRecoveredState = await recoverFromDoi({
      ...recoveryInput,
      record
    });
    if (doiRecoveredState) {
      return {
        record,
        syncState: doiRecoveredState
      };
    }
    return {
      record,
      ...(existingState ? { syncState: existingState } : {})
    };
  }

  return {
    record: input.record,
    syncState: mergeZenodoVerificationIntoState({
      ...(existingState ? { state: existingState } : {}),
      verified
    })
  };
}

async function recoverFromExistingState(input: ResolveZenodoSyncStateInput): Promise<ExternalSyncState | undefined> {
  const existingRecordId = input.existingState?.zenodoLatestRecordId?.trim();
  if (!existingRecordId) return undefined;

  const verified = await input.verifyZenodoRecord(existingRecordId);
  if (!verified) return undefined;

  const state = verified.kind === 'published_record'
    ? input.existingState
    : withoutZenodoRecordState(input.existingState);
  return mergeZenodoVerificationIntoState({
    ...(state ? { state } : {}),
    verified
  });
}

async function recoverFromDoi(input: ResolveZenodoSyncStateInput): Promise<ExternalSyncState | undefined> {
  if (!input.findZenodoRecordByDoi) return undefined;
  const lookup = await input.findZenodoRecordByDoi(input.record.crossrefDoi);
  if (lookup.status === 'ambiguous') {
    return {
      ...input.existingState,
      lastFailureClass: 'ZENODO_DOI_LOOKUP_AMBIGUOUS',
      lastFailureSummary: `Zenodo exact DOI lookup for ${input.record.crossrefDoi} found multiple published records: ${lookup.recordIds.join(', ')}`
    };
  }
  if (lookup.status !== 'found') return undefined;
  return mergeZenodoVerificationIntoState({
    ...(input.existingState ? { state: input.existingState } : {}),
    verified: lookup.record
  });
}

async function recoverFromZoteroExtra(input: ResolveZenodoSyncStateInput): Promise<ExternalSyncState | undefined> {
  const hint = readZoteroWritebackZenodoHint(input.zoteroExtra);
  if (!hint) return undefined;

  const verified = await input.verifyZenodoRecord(hint.latestRecordId);
  return recoverZenodoStateFromZoteroWritebackVerification({
    ...(input.existingState ? { state: input.existingState } : {}),
    hint,
    verified
  });
}

async function recoverFromPublishJournal(input: ResolveZenodoSyncStateInput): Promise<ExternalSyncState | undefined> {
  if (!input.latestJournal) return undefined;

  for (const recordId of zenodoPublishJournalVerificationRecordIds(input.latestJournal)) {
    const verified = await input.verifyZenodoRecord(recordId);
    if (!verified) continue;
    return recoverZenodoStateFromPublishJournalVerification({
      ...(input.existingState ? { state: input.existingState } : {}),
      journal: input.latestJournal,
      verified
    });
  }

  return recoverZenodoStateFromPublishJournalVerification({
    ...(input.existingState ? { state: input.existingState } : {}),
    journal: input.latestJournal,
    verified: null
  });
}

function knownRecordId(value: DoiSyncRecord['knownZenodoRecordId']): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed && trimmed !== '0' ? trimmed : null;
}

function withoutZenodoRecordState(state: ExternalSyncState | undefined): ExternalSyncState | undefined {
  if (!state) return undefined;
  return {
    ...(state.crossrefPayloadHash === undefined ? {} : { crossrefPayloadHash: state.crossrefPayloadHash }),
    ...(state.crossrefPayloadSnapshot === undefined ? {} : { crossrefPayloadSnapshot: state.crossrefPayloadSnapshot }),
    ...(state.crossrefPendingPayloadHash === undefined ? {} : { crossrefPendingPayloadHash: state.crossrefPendingPayloadHash }),
    ...(state.crossrefPendingPayloadSnapshot === undefined ? {} : { crossrefPendingPayloadSnapshot: state.crossrefPendingPayloadSnapshot }),
    ...(state.crossrefPendingBatchId === undefined ? {} : { crossrefPendingBatchId: state.crossrefPendingBatchId }),
    ...(state.crossrefPendingFilename === undefined ? {} : { crossrefPendingFilename: state.crossrefPendingFilename }),
    ...(state.crossrefPendingSubmittedAt === undefined ? {} : { crossrefPendingSubmittedAt: state.crossrefPendingSubmittedAt }),
    ...(state.crossrefPendingReason === undefined ? {} : { crossrefPendingReason: state.crossrefPendingReason }),
    ...(state.lastFailureClass === undefined ? {} : { lastFailureClass: state.lastFailureClass }),
    ...(state.lastFailureSummary === undefined ? {} : { lastFailureSummary: state.lastFailureSummary }),
    ...(state.consecutiveFailureCount === undefined ? {} : { consecutiveFailureCount: state.consecutiveFailureCount })
  };
}
