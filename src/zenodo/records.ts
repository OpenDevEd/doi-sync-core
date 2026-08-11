import type { PublicationProviderMetadata } from '../publication/record.js';
import type { JsonValue } from '../hash.js';
import { asJsonObject, toJsonValue, type JsonObject } from '../json.js';
import { asBoolean, asRecord, asString, idString } from '../guards.js';
import { mapZenodoResourceType, type ZenodoResourceType } from './resource-mapper.js';

/** Accept header required to receive the current InvenioRDM Zenodo API shape. */
export const ZENODO_INVENIORDM_ACCEPT = 'application/vnd.inveniordm.v1+json';

export type DoiPolicy = 'dual' | 'external-crossref';

export interface ZenodoWritePayloadInput {
  readonly doiPolicy: DoiPolicy;
  readonly metadata: PublicationProviderMetadata;
  readonly existingMetadata?: Readonly<Record<string, JsonValue>>;
  /** Public resource URL (e.g. Kerko); appended to `description` as an idempotent `<p>Available from ...</p>` block. */
  readonly resourceUrl?: string;
}

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
  const resourceType = mapZenodoResourceType(metadata.itemType);
  if (!resourceType) throw new Error(`Zenodo cannot publish Evidence Library item type ${metadata.itemType}`);
  if (!metadata.abstract) throw new Error('Zenodo requires an abstract or description');
  if (metadata.creators.length === 0) throw new Error('Zenodo requires at least one creator');

  output['title'] = metadata.title;
  applyResourceType(output, resourceType);
  output['publication_date'] = metadata.publicationDate;
  output['description'] = withResourceUrlAppendix(metadata.abstract, input.resourceUrl);
  output['creators'] = metadata.creators.map(zenodoCreator);
  output['access_right'] = 'open';
  replaceOptional(output, 'license', metadata.license);
  replaceOptional(output, 'notes', metadata.rights);
  replaceOptional(output, 'language', metadata.language);
  replaceOptional(output, 'imprint_publisher', metadata.publisher);
  replaceOptional(
    output,
    'thesis_university',
    metadata.itemType === 'Thesis' ? metadata.institution : undefined
  );
  if (metadata.tags.length > 0) output['keywords'] = [...new Set(metadata.tags)].sort();
  else delete output['keywords'];
  replaceManagedHostingInstitution(output, metadata.institution);
  const communities = normalizeLegacyCommunities(output['communities']);
  if (communities.length > 0) output['communities'] = communities;
  else delete output['communities'];

  if (input.doiPolicy === 'external-crossref') {
    if (!metadata.doi) throw new Error('Zenodo external DOI policy requires a DOI');
    output['doi'] = metadata.doi;
  } else {
    removeClientSuppliedDoiFields(output);
  }

  return { metadata: output };
}

function replaceManagedHostingInstitution(output: Record<string, JsonValue>, institution: string | undefined): void {
  const preserved = Array.isArray(output['contributors'])
    ? output['contributors'].filter((contributor) => (
        asString(asRecord(contributor)?.['type']) !== 'HostingInstitution'
      ))
    : [];
  if (institution) preserved.push({ name: institution, type: 'HostingInstitution' });
  if (preserved.length > 0) output['contributors'] = preserved;
  else delete output['contributors'];
}

function applyResourceType(output: Record<string, JsonValue>, resourceType: ZenodoResourceType): void {
  delete output['publication_type'];
  delete output['image_type'];
  output['upload_type'] = resourceType.uploadType;
  if (resourceType.uploadType === 'publication') output['publication_type'] = resourceType.publicationType;
  if (resourceType.uploadType === 'image') output['image_type'] = resourceType.imageType;
}

function replaceOptional(output: Record<string, JsonValue>, key: string, value: string | undefined): void {
  if (value) output[key] = value;
  else delete output[key];
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

function zenodoCreator(creator: PublicationProviderMetadata['creators'][number]): Readonly<Record<string, string>> {
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
