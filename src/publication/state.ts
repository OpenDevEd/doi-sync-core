import type { JsonValue } from '../hash.js';
import type { CrossrefEnvironment } from '../crossref/deposit.js';
import type { ZenodoProviderEnvironment, ZenodoPublishJournalOperationType } from '../zenodo/journal.js';
import type { ZenodoIdentifierPolicy } from './targets.js';

export interface CrossrefProviderSyncState {
  readonly environment: CrossrefEnvironment;
  readonly lastSuccess?: {
    readonly payloadHash: string;
    readonly payloadSnapshot?: JsonValue;
  };
  readonly pending?: {
    readonly stage: 'relation_clear' | 'deposit';
    readonly payloadHash: string;
    readonly payloadSnapshot?: JsonValue;
    readonly batchId?: string;
    readonly filename?: string;
    readonly submittedAt?: Date;
    readonly reason?: string;
  };
}

export interface ZenodoProviderIdentifiers {
  readonly latestRecordId: string;
  readonly parentId: string;
  readonly versionDoi?: string;
  readonly conceptDoi?: string;
}

export interface ZenodoProviderSyncState {
  readonly environment: ZenodoProviderEnvironment;
  readonly identifierPolicy: ZenodoIdentifierPolicy;
  readonly lastSuccess?: {
    readonly payloadHash: string;
    readonly payloadSnapshot?: JsonValue;
    readonly fileManifestHash?: string;
    readonly fileManifestSnapshot?: JsonValue;
  };
  readonly identifiers?: ZenodoProviderIdentifiers;
  readonly orphanDraftCleanup?: {
    readonly depositionId: string;
  };
  readonly journal?: {
    readonly operationType: ZenodoPublishJournalOperationType;
    readonly depositionId: string;
    readonly draftRecordId: string;
    readonly parentId?: string;
    readonly payloadHash: string;
    readonly fileManifestHash?: string;
    readonly status: 'preparing' | 'ready_to_publish';
  };
}

export interface ProviderSyncState {
  readonly crossref?: CrossrefProviderSyncState;
  readonly zenodo?: ZenodoProviderSyncState;
  readonly failure?: {
    readonly provider: 'crossref' | 'zenodo';
    readonly failureClass: string;
    readonly summary: string;
    readonly consecutiveCount: number;
  };
}
