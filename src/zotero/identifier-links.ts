import type { ZoteroChildItem } from '../files.js';
import type { ZoteroWritebackIdentifiers } from './writeback.js';

const ZOTZEN_TAG = '_r:zotzen';
const ZENODO_DEPOSIT_TAG = '_r:zenodoDeposit';
const ZENODO_RECORD_TAG = '_r:zenodoRecord';
const DOI_TAG = '_r:doi';
const CROSSREF_TAG = '_r:crossref';
const MANAGED_IDENTIFIER_LINK_TAGS = new Set([
  ZOTZEN_TAG,
  ZENODO_DEPOSIT_TAG,
  ZENODO_RECORD_TAG,
  DOI_TAG,
  CROSSREF_TAG
]);

export interface ZoteroIdentifierLinkInput {
  readonly parentItemKey: string;
  readonly children: readonly ZoteroChildItem[];
  readonly identifiers: ZoteroWritebackIdentifiers;
  readonly zenodoBaseUrl: string;
}

export interface ZoteroIdentifierLinkCreateRequest {
  readonly title: string;
  readonly url: string;
  readonly tags: readonly string[];
}

interface InternalLinkRequest extends ZoteroIdentifierLinkCreateRequest {
  /** Minimum tag set used to identify a child attachment as the slot for this managed link.
   * Subset of `tags`; extra desired tags (e.g. `_r:crossref`) are migrated in via an update. */
  readonly identityTags: readonly string[];
  readonly conflictingIdentityTags: readonly string[];
}

export type ZoteroIdentifierLinkReconciliation =
  | ({ readonly type: 'create' } & ZoteroIdentifierLinkCreateRequest)
  | ({
      readonly type: 'update';
      readonly attachmentKey: string;
      readonly itemVersion: number;
      readonly previousTitle?: string;
      readonly previousUrl?: string;
      readonly previousTags?: readonly string[];
    } & ZoteroIdentifierLinkCreateRequest)
  | {
      readonly type: 'delete';
      readonly attachmentKey: string;
      readonly itemVersion: number;
      readonly previousTitle?: string;
      readonly previousUrl?: string;
    };

/** Plans missing managed Zotero identifier-link attachments for Crossref and Zenodo. */
export function planZoteroIdentifierLinks(input: ZoteroIdentifierLinkInput): readonly ZoteroIdentifierLinkCreateRequest[] {
  return planZoteroIdentifierLinkReconciliation(input)
    .filter((action): action is Extract<ZoteroIdentifierLinkReconciliation, { readonly type: 'create' }> => action.type === 'create')
    .map((action) => ({
      title: action.title,
      url: action.url,
      tags: action.tags
    }));
}

/** Plans create, update, and duplicate-delete actions for managed Zotero identifier links. */
export function planZoteroIdentifierLinkReconciliation(input: ZoteroIdentifierLinkInput): readonly ZoteroIdentifierLinkReconciliation[] {
  const requests: InternalLinkRequest[] = [];
  const latestRecordId = input.identifiers.zenodoLatestRecordId?.trim();
  if (latestRecordId) {
    requests.push(...zenodoRequests(input, latestRecordId));
  }

  const crossrefDoi = input.identifiers.crossrefDoi.trim();
  if (crossrefDoi) {
    requests.push(doiRequest(input, crossrefDoi));
  }

  return [
    ...requests.flatMap((request) => reconcileManagedLink(input.children, input.parentItemKey, request)),
    ...deleteMalformedManagedIdentifierLinks(input.children),
    ...(latestRecordId ? [] : deleteStaleManagedZenodoLinks(input.children))
  ];
}

function zenodoRequests(input: ZoteroIdentifierLinkInput, latestRecordId: string): readonly InternalLinkRequest[] {
  const baseUrl = input.zenodoBaseUrl.replace(/\/+$/, '');
  return [
    {
      title: `🔄View entry on Zenodo (deposit) [${input.parentItemKey}]`,
      url: `${baseUrl}/deposit/${latestRecordId}`,
      tags: [ZENODO_DEPOSIT_TAG, ZOTZEN_TAG],
      identityTags: [ZENODO_DEPOSIT_TAG, ZOTZEN_TAG],
      conflictingIdentityTags: [DOI_TAG, ZENODO_RECORD_TAG]
    },
    {
      title: `🔄View entry on Zenodo (record) [${input.parentItemKey}]`,
      url: `${baseUrl}/record/${latestRecordId}`,
      tags: [ZENODO_RECORD_TAG, ZOTZEN_TAG],
      identityTags: [ZENODO_RECORD_TAG, ZOTZEN_TAG],
      conflictingIdentityTags: [DOI_TAG, ZENODO_DEPOSIT_TAG]
    }
  ];
}

function doiRequest(input: ZoteroIdentifierLinkInput, doi: string): InternalLinkRequest {
  return {
    title: `🔄Look up this DOI (once activated) [${input.parentItemKey}]`,
    url: `https://doi.org/${doi}`,
    tags: [DOI_TAG, CROSSREF_TAG, ZOTZEN_TAG],
    identityTags: [DOI_TAG, ZOTZEN_TAG],
    conflictingIdentityTags: [ZENODO_DEPOSIT_TAG, ZENODO_RECORD_TAG]
  };
}

function reconcileManagedLink(
  children: readonly ZoteroChildItem[],
  parentItemKey: string,
  request: InternalLinkRequest
): readonly ZoteroIdentifierLinkReconciliation[] {
  const candidates = children
    .map((child, index) => ({ child, index }))
    .filter((entry) => isManagedLinkForRequest(entry.child, request))
    .sort((left, right) => managedLinkScore(right.child, request, parentItemKey) - managedLinkScore(left.child, request, parentItemKey)
      || left.index - right.index);
  const keeper = candidates[0]?.child;
  if (!keeper) return [{ type: 'create', ...desiredOnly(request) }];

  const actions: ZoteroIdentifierLinkReconciliation[] = [];
  if (!isCurrentManagedLink(keeper, request)) {
    actions.push({
      type: 'update',
      attachmentKey: keeper.key,
      itemVersion: keeper.version,
      ...optionalPreviousLinkData(keeper),
      ...optionalPreviousTags(keeper),
      ...desiredOnly(request, keeper)
    });
  }

  for (const { child: duplicate } of candidates.slice(1)) {
    actions.push({
      type: 'delete',
      attachmentKey: duplicate.key,
      itemVersion: duplicate.version,
      ...optionalPreviousLinkData(duplicate)
    });
  }

  return actions;
}

function desiredOnly(request: InternalLinkRequest, child?: ZoteroChildItem): ZoteroIdentifierLinkCreateRequest {
  return {
    title: request.title,
    url: request.url,
    tags: child ? mergeDesiredTagsWithUserTags(child, request) : request.tags
  };
}

function isManagedLinkForRequest(child: ZoteroChildItem, request: InternalLinkRequest): boolean {
  if (child.data.itemType !== 'attachment' || child.data.linkMode !== 'linked_url') return false;
  const tags = new Set(child.data.tags?.map((tag) => tag.tag) ?? []);
  return request.identityTags.every((tag) => tags.has(tag))
    && request.conflictingIdentityTags.every((tag) => !tags.has(tag));
}

function deleteMalformedManagedIdentifierLinks(children: readonly ZoteroChildItem[]): readonly ZoteroIdentifierLinkReconciliation[] {
  return children
    .filter(hasConflictingManagedIdentityTags)
    .map((child) => ({
      type: 'delete',
      attachmentKey: child.key,
      itemVersion: child.version,
      ...optionalPreviousLinkData(child)
    }));
}

function hasConflictingManagedIdentityTags(child: ZoteroChildItem): boolean {
  if (child.data.itemType !== 'attachment' || child.data.linkMode !== 'linked_url') return false;
  const tags = new Set(child.data.tags?.map((tag) => tag.tag) ?? []);
  if (!tags.has(ZOTZEN_TAG)) return false;
  return [DOI_TAG, ZENODO_DEPOSIT_TAG, ZENODO_RECORD_TAG]
    .filter((tag) => tags.has(tag))
    .length > 1;
}

function deleteStaleManagedZenodoLinks(children: readonly ZoteroChildItem[]): readonly ZoteroIdentifierLinkReconciliation[] {
  return children
    .filter(isManagedZenodoLink)
    .map((child) => ({
      type: 'delete',
      attachmentKey: child.key,
      itemVersion: child.version,
      ...optionalPreviousLinkData(child)
    }));
}

function isManagedZenodoLink(child: ZoteroChildItem): boolean {
  if (child.data.itemType !== 'attachment' || child.data.linkMode !== 'linked_url') return false;
  const tags = new Set(child.data.tags?.map((tag) => tag.tag) ?? []);
  return tags.has(ZOTZEN_TAG) && (tags.has(ZENODO_DEPOSIT_TAG) || tags.has(ZENODO_RECORD_TAG));
}

function isCurrentManagedLink(child: ZoteroChildItem, request: InternalLinkRequest): boolean {
  if (!isManagedLinkForRequest(child, request)) return false;
  return child.data.url === request.url
    && child.data.title === request.title
    && hasDesiredManagedTags(child, request);
}

function hasDesiredManagedTags(child: ZoteroChildItem, request: InternalLinkRequest): boolean {
  const childTags = new Set(child.data.tags?.map((tag) => tag.tag) ?? []);
  return request.tags.every((tag) => childTags.has(tag));
}

function managedLinkScore(child: ZoteroChildItem, request: InternalLinkRequest, parentItemKey: string): number {
  let score = 0;
  if (child.data.url === request.url) score += 8;
  if (child.data.title === request.title) score += 4;
  if ((child.data.title ?? '').includes(`[${parentItemKey}]`)) score += 2;
  if (hasDesiredManagedTags(child, request)) score += 1;
  return score;
}

function optionalPreviousLinkData(child: ZoteroChildItem): {
  readonly previousTitle?: string;
  readonly previousUrl?: string;
} {
  return {
    ...(child.data.title ? { previousTitle: child.data.title } : {}),
    ...(child.data.url ? { previousUrl: child.data.url } : {})
  };
}

function optionalPreviousTags(child: ZoteroChildItem): { readonly previousTags?: readonly string[] } {
  const tags = child.data.tags?.map((tag) => tag.tag) ?? [];
  if (tags.length === 0) return {};
  return { previousTags: [...new Set(tags)] };
}

function mergeDesiredTagsWithUserTags(child: ZoteroChildItem, request: InternalLinkRequest): readonly string[] {
  const childTags = child.data.tags?.map((tag) => tag.tag) ?? [];
  const userTags = childTags.filter((tag) => !MANAGED_IDENTIFIER_LINK_TAGS.has(tag));
  return [...new Set([...userTags, ...request.tags])];
}
