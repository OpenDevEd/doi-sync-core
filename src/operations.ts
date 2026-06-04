import type { SyncOperation } from './planner.js';

export type CrossrefSyncOperation = Extract<SyncOperation, {
  readonly type: 'crossref_redeposit' | 'crossref_verify_pending';
}>;

export type ZenodoSyncOperation = Extract<SyncOperation, {
  readonly type:
    | 'zenodo_create'
    | 'zenodo_draft_create'
    | 'zenodo_draft_update'
    | 'zenodo_legacy_deposition_adopt'
    | 'zenodo_metadata_update'
    | 'zenodo_file_update'
    | 'zenodo_new_version'
    | 'zenodo_publish_journaled_draft';
}>;

export type ZenodoRecordIdRequiredOperation = Extract<ZenodoSyncOperation, {
  readonly type: 'zenodo_metadata_update' | 'zenodo_file_update' | 'zenodo_new_version';
}>;

export type ZenodoFileOperation =
  | Extract<ZenodoSyncOperation, {
      readonly type: 'zenodo_create' | 'zenodo_legacy_deposition_adopt' | 'zenodo_file_update' | 'zenodo_new_version';
    }>
  | (Extract<ZenodoSyncOperation, { readonly type: 'zenodo_publish_journaled_draft' }> & {
      readonly fileManifestHash: string;
    });

export function isCrossrefOperation(operation: SyncOperation): operation is CrossrefSyncOperation {
  return operation.type === 'crossref_redeposit' || operation.type === 'crossref_verify_pending';
}

export function isZenodoOperation(operation: SyncOperation): operation is ZenodoSyncOperation {
  return operation.type === 'zenodo_create'
    || operation.type === 'zenodo_draft_create'
    || operation.type === 'zenodo_draft_update'
    || operation.type === 'zenodo_legacy_deposition_adopt'
    || operation.type === 'zenodo_metadata_update'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version'
    || operation.type === 'zenodo_publish_journaled_draft';
}

export function isZenodoFileOperation(operation: SyncOperation): operation is ZenodoFileOperation {
  return operation.type === 'zenodo_create'
    || operation.type === 'zenodo_legacy_deposition_adopt'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version'
    || (operation.type === 'zenodo_publish_journaled_draft' && Boolean(operation.fileManifestHash));
}

export function changesZenodoVersionDoi(operation: SyncOperation): boolean {
  return operation.type === 'zenodo_create'
    || operation.type === 'zenodo_legacy_deposition_adopt'
    || operation.type === 'zenodo_new_version'
    || (operation.type === 'zenodo_publish_journaled_draft' && operation.originalOperationType !== 'zenodo_metadata_update');
}

export function requiresZenodoRecordId(operation: ZenodoSyncOperation): operation is ZenodoRecordIdRequiredOperation {
  return operation.type === 'zenodo_metadata_update'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version';
}
