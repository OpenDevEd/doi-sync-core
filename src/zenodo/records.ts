import type { CanonicalMetadataSnapshot } from '../metadata.js';
import type { JsonValue } from '../hash.js';
import { asJsonObject, toJsonValue, type JsonObject } from '../json.js';
import { asBoolean, asRecord, asString, idString } from '../guards.js';

/** Accept header required to receive the current InvenioRDM Zenodo API shape. */
export const ZENODO_INVENIORDM_ACCEPT = 'application/vnd.inveniordm.v1+json';

export type DoiPolicy = 'dual' | 'external-crossref';

export interface ZenodoWritePayloadInput {
  readonly doiPolicy: DoiPolicy;
  readonly metadata: CanonicalMetadataSnapshot;
  readonly existingMetadata?: Readonly<Record<string, JsonValue>>;
  /** Zotero `zotero://select/...` URL for the parent item; emitted into the legacy deposition `related_identifiers` write payload. */
  readonly zoteroSelectUrl?: string;
  /** Public resource URL (e.g. Kerko); appended to `description` as an idempotent `<p>Available from ...</p>` block. */
  readonly resourceUrl?: string;
}

/** Legacy Zenodo deposition `related_identifiers` shape for back-linking a Zenodo record to its Zotero source. */
export const ZOTERO_BACK_LINK_RELATION = 'isAlternateIdentifier';
export const ZOTERO_BACK_LINK_RESOURCE_TYPE = 'other';
export const ZOTERO_BACK_LINK_SCHEME = 'url';
export const ZENODO_LEGACY_UPLOAD_TYPE = 'publication';
export const ZENODO_LEGACY_PUBLICATION_TYPE = 'report';

export interface ZenodoLegacyDepositionPayload {
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface ZenodoRecordIdentifiers {
  readonly latestRecordId: string;
  readonly parentId: string;
  readonly versionDoi?: string;
  readonly conceptDoi?: string;
  readonly links: {
    readonly self?: string;
    readonly selfHtml?: string;
    readonly latest?: string;
    readonly latestHtml?: string;
    readonly versions?: string;
  };
}

export interface ZenodoRecordFileSnapshot {
  readonly key: string;
  readonly checksum?: string;
  readonly size?: number;
  readonly contentType?: string;
}

export interface ZenodoRecordSnapshot {
  readonly identifiers: ZenodoRecordIdentifiers;
  readonly metadata: JsonObject;
  readonly files: readonly ZenodoRecordFileSnapshot[];
}

export interface ZenodoLegacyDepositionIdentifiers {
  readonly depositionId: string;
  readonly recordId: string;
  readonly conceptRecordId?: string;
  readonly submitted: boolean;
  readonly state: 'unsubmitted';
  readonly doi?: string;
  readonly reservedDoi?: string;
  readonly fileCount: number;
  readonly links: {
    readonly self?: string;
    readonly html?: string;
    readonly bucket?: string;
  };
}

export type ZenodoVerificationResult =
  | { readonly kind: 'published_record'; readonly identifiers: ZenodoRecordIdentifiers }
  | { readonly kind: 'legacy_unsubmitted_deposition'; readonly deposition: ZenodoLegacyDepositionIdentifiers };

export type ZenodoPublishedRecordVerification = Extract<ZenodoVerificationResult, { readonly kind: 'published_record' }>;

export type ZenodoDoiLookupResult =
  | { readonly status: 'found'; readonly record: ZenodoPublishedRecordVerification }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly recordIds: readonly string[] };

export type ZenodoUnsubmittedDraftDoiLookupResult =
  | { readonly status: 'found'; readonly deposition: Extract<ZenodoVerificationResult, { readonly kind: 'legacy_unsubmitted_deposition' }> }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous'; readonly depositionIds: readonly string[] };

/** Builds the legacy-deposition metadata payload used for Zenodo create, edit, and publish flows. */
export function buildZenodoWritePayload(input: ZenodoWritePayloadInput): ZenodoLegacyDepositionPayload {
  const metadata = input.metadata;
  const output: Record<string, JsonValue> = {
    ...(input.existingMetadata ?? {})
  };

  output['title'] = metadata.title;
  output['upload_type'] = ZENODO_LEGACY_UPLOAD_TYPE;
  output['publication_type'] = ZENODO_LEGACY_PUBLICATION_TYPE;
  output['publication_date'] = metadata.publicationDate;
  output['description'] = withResourceUrlAppendix(metadata.abstract ?? '[No description available.]', input.resourceUrl);
  output['creators'] = metadata.creators.length > 0
    ? metadata.creators.map(zenodoCreator)
    : [{ name: 'No name available.', affiliation: 'No affiliation available.' }];
  output['access_right'] = 'open';
  const communities = normalizeLegacyCommunities(output['communities']);
  if (communities.length > 0) output['communities'] = communities;
  else delete output['communities'];

  if (input.doiPolicy === 'external-crossref') {
    output['doi'] = metadata.doi;
  } else {
    removeClientSuppliedDoiFields(output);
  }

  if (input.zoteroSelectUrl) {
    output['related_identifiers'] = mergeZoteroBackLink(output['related_identifiers'], input.zoteroSelectUrl);
  }

  return { metadata: output };
}

function withResourceUrlAppendix(description: string, resourceUrl: string | undefined): string {
  if (!resourceUrl) return description;
  const appendix = buildResourceUrlAppendix(resourceUrl);
  if (description.includes(appendix)) return description;
  return `${description}\n\n${appendix}`;
}

function buildResourceUrlAppendix(resourceUrl: string): string {
  const escaped = escapeHtml(resourceUrl);
  return `<p>Available from <a href="${escaped}">${escaped}</a></p>`;
}

function mergeZoteroBackLink(existing: JsonValue | undefined, zoteroSelectUrl: string): readonly JsonValue[] {
  const current: readonly JsonValue[] = Array.isArray(existing) ? existing : [];
  const normalized = current.map((entry) => isZoteroBackLink(entry, zoteroSelectUrl) ? legacyZoteroBackLink(zoteroSelectUrl) : entry);
  if (normalized.some((entry) => isLegacyZoteroBackLink(entry, zoteroSelectUrl))) return normalized;
  return [...normalized, legacyZoteroBackLink(zoteroSelectUrl)];
}

function legacyZoteroBackLink(zoteroSelectUrl: string): JsonValue {
  return {
    identifier: zoteroSelectUrl,
    relation: ZOTERO_BACK_LINK_RELATION,
    resource_type: ZOTERO_BACK_LINK_RESOURCE_TYPE,
    scheme: ZOTERO_BACK_LINK_SCHEME
  };
}

function isZoteroBackLink(entry: JsonValue, zoteroSelectUrl: string): boolean {
  return isLegacyZoteroBackLink(entry, zoteroSelectUrl) || isCurrentZoteroBackLink(entry, zoteroSelectUrl);
}

function isLegacyZoteroBackLink(entry: JsonValue, zoteroSelectUrl: string): boolean {
  const record = asRecord(entry);
  return asString(record?.['identifier']) === zoteroSelectUrl
    && asString(record?.['relation']) === ZOTERO_BACK_LINK_RELATION
    && asString(record?.['scheme']) === ZOTERO_BACK_LINK_SCHEME;
}

function isCurrentZoteroBackLink(entry: JsonValue, zoteroSelectUrl: string): boolean {
  const record = asRecord(entry);
  const relationType = asRecord(record?.['relation_type']);
  return asString(record?.['identifier']) === zoteroSelectUrl
    && asString(relationType?.['id']) === 'isalternateidentifier'
    && asString(record?.['scheme']) === ZOTERO_BACK_LINK_SCHEME;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function removeClientSuppliedDoiFields(metadata: Record<string, JsonValue>): void {
  delete metadata['doi'];
  delete metadata['prereserve_doi'];
}

function zenodoCreator(creator: CanonicalMetadataSnapshot['creators'][number]): Readonly<Record<string, string>> {
  return {
    name: creator.name,
    ...(creator.affiliation ? { affiliation: creator.affiliation } : {}),
    ...(creator.orcid ? { orcid: creator.orcid } : {})
  };
}

function normalizeLegacyCommunities(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(legacyCommunityIdentifier).filter(isString))]
    .map((identifier) => ({ identifier }));
}

function legacyCommunityIdentifier(value: JsonValue): string | null {
  const object = asRecord(value);
  return asString(object?.['identifier']);
}

function isString(value: string | null): value is string {
  return value !== null;
}

export function parseZenodoRecordIdentifiers(response: unknown): ZenodoRecordIdentifiers {
  const record = asRecord(response);
  if (!record) throw new Error('Expected current InvenioRDM record shape with object response');

  const id = asString(record['id']);
  const parent = asRecord(record['parent']);
  const parentId = asString(parent?.['id']);
  if (!id || !parentId) {
    throw new Error('Expected current InvenioRDM record shape with string id and parent.id');
  }

  const pids = asRecord(record['pids']);
  const parentPids = asRecord(parent?.['pids']);
  const links = asRecord(record['links']) ?? {};
  const versionDoi = pidIdentifier(pids, 'doi');
  const conceptDoi = pidIdentifier(parentPids, 'doi') ?? pidIdentifier(pids, 'concept-doi');

  return {
    latestRecordId: id,
    parentId,
    ...(versionDoi ? { versionDoi } : {}),
    ...(conceptDoi ? { conceptDoi } : {}),
    links: {
      ...optionalLink('self', links['self']),
      ...optionalLink('selfHtml', links['self_html']),
      ...optionalLink('latest', links['latest']),
      ...optionalLink('latestHtml', links['latest_html']),
      ...optionalLink('versions', links['versions'])
    }
  };
}

export function parseZenodoRecordSnapshot(response: unknown): ZenodoRecordSnapshot {
  const record = asRecord(response);
  if (!record) throw new Error('Expected current InvenioRDM record shape with object response');
  const metadata = asJsonObject(toJsonValue(asRecord(record['metadata']) ?? {}));
  if (!metadata) throw new Error('Expected current InvenioRDM record metadata object');

  return {
    identifiers: parseZenodoRecordIdentifiers(response),
    metadata,
    files: parseZenodoRecordFiles(record)
  };
}

export function parseZenodoLegacyDepositionIdentifiers(response: unknown): ZenodoLegacyDepositionIdentifiers | null {
  const deposition = asRecord(response);
  if (!deposition) throw new Error('Expected legacy Zenodo deposition shape with object response');

  const submitted = asBoolean(deposition['submitted']) ?? false;
  const state = asString(deposition['state']);
  if (submitted || state !== 'unsubmitted') return null;

  const depositionId = idString(deposition['id']);
  const recordId = idString(deposition['record_id']) ?? depositionId;
  if (!depositionId || !recordId) {
    throw new Error('Expected legacy Zenodo deposition shape with id and record_id');
  }

  const metadata = asRecord(deposition['metadata']) ?? {};
  const prereserveDoi = asRecord(metadata['prereserve_doi']) ?? {};
  const links = asRecord(deposition['links']) ?? {};
  const files = Array.isArray(deposition['files']) ? deposition['files'] : [];
  const conceptRecordId = idString(deposition['conceptrecid']);
  const doi = asString(metadata['doi']);
  const reservedDoi = asString(prereserveDoi['doi']);

  return {
    depositionId,
    recordId,
    ...(conceptRecordId ? { conceptRecordId } : {}),
    submitted,
    state,
    ...(doi ? { doi } : {}),
    ...(reservedDoi ? { reservedDoi } : {}),
    fileCount: files.length,
    links: {
      ...optionalLegacyLink('self', links['self']),
      ...optionalLegacyLink('html', links['html']),
      ...optionalLegacyLink('bucket', links['bucket'])
    }
  };
}

function pidIdentifier(pids: Record<string, unknown> | null, key: string): string | null {
  const pid = asRecord(pids?.[key]);
  return asString(pid?.['identifier']);
}

function parseZenodoRecordFiles(record: Record<string, unknown>): readonly ZenodoRecordFileSnapshot[] {
  const files = asRecord(record['files']);
  const entries = asRecord(files?.['entries']);
  if (!entries) return [];

  return Object.entries(entries).flatMap(([entryKey, rawEntry]) => {
    const file = asRecord(rawEntry);
    if (!file) return [];
    const key = asString(file['key']) ?? entryKey;
    const checksum = asString(file['checksum']);
    const size = fileSize(file['size']);
    const contentType = asString(file['mimetype']) ?? asString(file['content_type']);
    return [{
      key,
      ...(checksum ? { checksum } : {}),
      ...(size === undefined ? {} : { size }),
      ...(contentType ? { contentType } : {})
    }];
  });
}

function fileSize(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalLink(key: keyof ZenodoRecordIdentifiers['links'], value: unknown): Partial<ZenodoRecordIdentifiers['links']> {
  const link = asString(value);
  return link ? { [key]: link } : {};
}

function optionalLegacyLink(key: keyof ZenodoLegacyDepositionIdentifiers['links'], value: unknown): Partial<ZenodoLegacyDepositionIdentifiers['links']> {
  const link = asString(value);
  return link ? { [key]: link } : {};
}
