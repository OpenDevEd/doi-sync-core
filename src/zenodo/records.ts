import { asJsonObject, toJsonValue, type JsonObject } from '../json.js';
import { asBoolean, asRecord, asString, idString } from '../guards.js';

/** Accept header required to receive the current InvenioRDM Zenodo API shape. */
export const ZENODO_INVENIORDM_ACCEPT = 'application/vnd.inveniordm.v1+json';

export interface ZenodoRecordIdentifiers {
  readonly latestRecordId: string;
  readonly parentId: string;
  readonly publishedAt: Date;
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
  const publishedAt = parseRequiredPublicationTime(record['created']);

  return {
    latestRecordId: id,
    parentId,
    publishedAt,
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

function parseRequiredPublicationTime(value: unknown): Date {
  const raw = asString(value);
  const parsed = raw ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error('Expected current InvenioRDM record shape with created publication time');
  }
  return parsed;
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
