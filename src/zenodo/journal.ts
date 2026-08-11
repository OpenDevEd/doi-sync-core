import type { JsonValue } from '../hash.js';
import type { ZenodoRecordIdentifiers } from './records.js';

export type ZenodoProviderEnvironment = 'production' | 'sandbox';

export type ZenodoPublishJournalOperationType =
  | 'zenodo_create'
  | 'zenodo_metadata_update'
  | 'zenodo_file_update'
  | 'zenodo_new_version';

export type ZenodoPublishJournalStatus = 'preparing' | 'ready_to_publish' | 'published';

export interface ZenodoPreparedDraft {
  readonly depositionId: string;
  readonly draftRecordId: string;
  readonly parentId?: string;
  readonly api?: 'legacy_deposition' | 'invenio_record';
  readonly payloadSnapshot?: JsonValue;
}

export interface RecordZenodoPublishDraftInput {
  readonly recordId: string;
  readonly environment: ZenodoProviderEnvironment;
  readonly operationType: ZenodoPublishJournalOperationType;
  readonly zenodoPayloadHash: string;
  readonly fileManifestHash?: string;
  readonly depositionId: string;
  readonly draftRecordId: string;
  readonly parentId?: string;
  readonly status?: Extract<ZenodoPublishJournalStatus, 'preparing' | 'ready_to_publish'>;
  readonly observedAt: Date;
}

export interface MarkZenodoPublishDraftPublishedInput {
  readonly recordId: string;
  readonly environment: ZenodoProviderEnvironment;
  readonly depositionId: string;
  readonly publishedRecordId: string;
  readonly identifiers: ZenodoRecordIdentifiers;
  readonly orphanDraftCleanup?: {
    readonly depositionId: string;
  };
  readonly observedAt: Date;
}

export interface ClearZenodoOrphanDraftCleanupInput {
  readonly recordId: string;
  readonly environment: ZenodoProviderEnvironment;
  readonly depositionId: string;
  readonly observedAt: Date;
}

export interface ClearZenodoPublishDraftInput {
  readonly recordId: string;
  readonly environment: ZenodoProviderEnvironment;
  readonly depositionId: string;
  readonly observedAt: Date;
}

export interface ZenodoPublishJournalEntry {
  readonly id: string;
  readonly recordId: string;
  readonly operationType: ZenodoPublishJournalOperationType;
  readonly zenodoPayloadHash: string;
  readonly fileManifestHash?: string | null;
  readonly depositionId: string;
  readonly draftRecordId: string;
  readonly parentId?: string | null;
  readonly status: ZenodoPublishJournalStatus;
  readonly publishedRecordId?: string | null;
  readonly identifiers?: JsonValue | null;
  readonly orphanDraftCleanupDepositionId?: string | null;
}
