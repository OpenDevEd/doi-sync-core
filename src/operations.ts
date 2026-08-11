import type { PublicationSyncOperation } from './planner.js';

export type CrossrefSyncOperation = Extract<PublicationSyncOperation, {
  readonly type: 'crossref_redeposit' | 'crossref_verify_pending';
}>;

export type ZenodoSyncOperation = Extract<PublicationSyncOperation, {
  readonly type:
    | 'zenodo_create'
    | 'zenodo_metadata_update'
    | 'zenodo_file_update'
    | 'zenodo_new_version'
    | 'zenodo_discard_preparing_draft'
    | 'zenodo_cleanup_orphan_draft'
    | 'zenodo_publish_journaled_draft';
}>;

export type ZenodoRecordIdRequiredOperation = Extract<ZenodoSyncOperation, {
  readonly type: 'zenodo_metadata_update' | 'zenodo_file_update' | 'zenodo_new_version';
}>;

export type ZenodoFileOperation =
  | Extract<ZenodoSyncOperation, {
      readonly type: 'zenodo_create' | 'zenodo_file_update' | 'zenodo_new_version';
    }>
  | (Extract<ZenodoSyncOperation, { readonly type: 'zenodo_publish_journaled_draft' }> & {
      readonly fileManifestHash: string;
    });

export function isCrossrefOperation(
  operation: PublicationSyncOperation
): operation is CrossrefSyncOperation {
  return operation.type === 'crossref_redeposit' || operation.type === 'crossref_verify_pending';
}

export function isZenodoOperation(
  operation: PublicationSyncOperation
): operation is ZenodoSyncOperation {
  return operation.type === 'zenodo_create'
    || operation.type === 'zenodo_metadata_update'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version'
    || operation.type === 'zenodo_discard_preparing_draft'
    || operation.type === 'zenodo_cleanup_orphan_draft'
    || operation.type === 'zenodo_publish_journaled_draft';
}

export function isZenodoFileOperation(
  operation: PublicationSyncOperation
): operation is ZenodoFileOperation {
  return operation.type === 'zenodo_create'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version'
    || (operation.type === 'zenodo_publish_journaled_draft' && Boolean(operation.fileManifestHash));
}

export function changesZenodoVersionDoi(operation: PublicationSyncOperation): boolean {
  return operation.type === 'zenodo_create'
    || operation.type === 'zenodo_new_version'
    || (
      operation.type === 'zenodo_publish_journaled_draft'
      && operation.originalOperationType !== 'zenodo_metadata_update'
    );
}

export function requiresZenodoRecordId(
  operation: ZenodoSyncOperation
): operation is ZenodoRecordIdRequiredOperation {
  return operation.type === 'zenodo_metadata_update'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version';
}
