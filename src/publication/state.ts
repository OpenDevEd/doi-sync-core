import { z } from 'zod';
import type { JsonValue } from '../hash.js';
import type { CrossrefEnvironment } from '../crossref/deposit.js';
import { jsonValueSchema } from '../json.js';
import type { ZenodoProviderEnvironment, ZenodoPublishJournalOperationType } from '../zenodo/journal.js';
import type { ZenodoIdentifierPolicy } from './targets.js';
import {
  zenodoFileCorrectionApprovalSchema,
  type ZenodoFileCorrectionApproval
} from './file-corrections.js';

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
  readonly firstPublishedAt?: Date;
  readonly consumedFileCorrectionApprovalIds?: readonly string[];
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
    readonly fileCorrectionApproval?: ZenodoFileCorrectionApproval;
  };
}

export interface ProviderSyncState {
  readonly crossref?: CrossrefProviderSyncState;
  readonly zenodo?: ZenodoProviderSyncState;
  readonly failure?: {
    readonly provider: ProviderSyncFailureProvider;
    readonly failureClass: string;
    readonly summary: string;
    readonly consecutiveCount: number;
  };
}

export type ProviderSyncFailureProvider = 'crossref' | 'zenodo' | 'source' | 'worker';

const crossrefProviderSyncStateSchema = z.object({
  environment: z.enum(['test', 'production']),
  lastSuccess: z.object({
    payloadHash: z.string().min(1),
    payloadSnapshot: jsonValueSchema.optional()
  }).strict().optional(),
  pending: z.object({
    stage: z.enum(['relation_clear', 'deposit']),
    payloadHash: z.string().min(1),
    payloadSnapshot: jsonValueSchema.optional(),
    batchId: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    submittedAt: z.coerce.date().optional(),
    reason: z.string().min(1).optional()
  }).strict().optional()
}).strict();

const zenodoProviderSyncStateSchema = z.object({
  environment: z.enum(['production', 'sandbox']),
  identifierPolicy: z.enum(['reuse-crossref', 'mint-zenodo']),
  firstPublishedAt: z.coerce.date().optional(),
  consumedFileCorrectionApprovalIds: z.array(z.string().min(1)).refine(
    (ids) => new Set(ids).size === ids.length,
    'Consumed Zenodo file correction approval IDs must be unique'
  ).optional(),
  lastSuccess: z.object({
    payloadHash: z.string().min(1),
    payloadSnapshot: jsonValueSchema.optional(),
    fileManifestHash: z.string().min(1).optional(),
    fileManifestSnapshot: jsonValueSchema.optional()
  }).strict().optional(),
  identifiers: z.object({
    latestRecordId: z.string().min(1),
    parentId: z.string().min(1),
    versionDoi: z.string().min(1).optional(),
    conceptDoi: z.string().min(1).optional()
  }).strict().optional(),
  orphanDraftCleanup: z.object({
    depositionId: z.string().min(1)
  }).strict().optional(),
  journal: z.object({
    operationType: z.enum([
      'zenodo_create',
      'zenodo_metadata_update',
      'zenodo_file_update',
      'zenodo_new_version'
    ]),
    depositionId: z.string().min(1),
    draftRecordId: z.string().min(1),
    parentId: z.string().min(1).optional(),
    payloadHash: z.string().min(1),
    fileManifestHash: z.string().min(1).optional(),
    status: z.enum(['preparing', 'ready_to_publish']),
    fileCorrectionApproval: zenodoFileCorrectionApprovalSchema.optional()
  }).strict().superRefine((journal, context) => {
    const hasApproval = Boolean(journal.fileCorrectionApproval);
    if (journal.operationType === 'zenodo_file_update' && !hasApproval) {
      context.addIssue({ code: 'custom', path: ['fileCorrectionApproval'], message: 'Zenodo file correction journal requires approval' });
    }
    if (journal.operationType !== 'zenodo_file_update' && hasApproval) {
      context.addIssue({ code: 'custom', path: ['fileCorrectionApproval'], message: 'Only Zenodo file corrections may store approval' });
    }
  }).optional()
}).strict();

const providerSyncStateSchema = z.object({
  crossref: crossrefProviderSyncStateSchema.optional(),
  zenodo: zenodoProviderSyncStateSchema.optional(),
  failure: z.object({
    provider: z.enum(['crossref', 'zenodo', 'source', 'worker']),
    failureClass: z.string().min(1),
    summary: z.string().min(1),
    consecutiveCount: z.number().int().nonnegative()
  }).strict().optional()
}).strict();

/** Validates provider state loaded from durable host storage and restores saved dates. */
export function parseProviderSyncState(input: unknown): ProviderSyncState {
  return providerSyncStateSchema.parse(input) as ProviderSyncState;
}
