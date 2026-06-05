import { normalizeDoi } from './doi.js';
import { parseManagedExtraIdentifiers } from './zotero/writeback.js';

export type DoiDisplayProvider = 'crossref' | 'zenodo';
export type DoiDisplayKind = 'doi' | 'record' | 'concept-record';

export interface DoiDisplayAttachment {
  readonly linkMode?: string | null;
  readonly title?: string | null;
  readonly url?: string | null;
  readonly tags?: readonly string[] | null;
}

export interface BuildDoiDisplayLinksInput {
  readonly DOI?: string | null;
  readonly doi?: string | null;
  readonly extra?: string | null;
  readonly attachmentsData?: readonly DoiDisplayAttachment[] | null;
  readonly zenodoBaseUrl?: string | null;
}

export interface DoiDisplayLink {
  readonly provider: DoiDisplayProvider;
  readonly kind: DoiDisplayKind;
  readonly label: string;
  readonly value: string;
  readonly url: string;
}

export interface DoiDisplayLinks {
  readonly crossrefDoi?: DoiDisplayLink;
  readonly zenodoVersionDoi?: DoiDisplayLink;
  readonly zenodoConceptDoi?: DoiDisplayLink;
  readonly zenodoRecord?: DoiDisplayLink;
  readonly zenodoConceptRecord?: DoiDisplayLink;
  readonly links: readonly DoiDisplayLink[];
}

interface ParsedExtraDisplayIdentifiers {
  readonly crossrefDoi?: string;
  readonly zenodoVersionDoi?: string;
  readonly zenodoConceptDoi?: string;
  readonly zenodoBaseUrl?: string;
}

const DEFAULT_ZENODO_BASE_URL = 'https://zenodo.org';
const ZENODO_DOI_PATTERN = /^10\.(?:5281|5072)\/zenodo\.\d+$/i;
const ZENODO_RECORD_URL_PATTERN = /^https?:\/\/(?:sandbox\.)?zenodo\.org\/(?:record|records)\/(\d+)\b/i;
const ZENODO_RECORD_TAGS = new Set(['_r:zenodorecord', '_r:zenododeposit']);
const DOI_TAG = '_r:doi';

/** Builds display-ready Crossref and Zenodo identifier links from Zotero item data.
 *
 * This helper intentionally does not synthesize Zenodo/DataCite DOIs from Zenodo record IDs.
 * External-Crossref Zenodo records should show the Crossref DOI plus a Zenodo archive record link;
 * a separate Zenodo DOI is returned only when the Zotero Extra field explicitly contains one. */
export function buildDoiDisplayLinks(input: BuildDoiDisplayLinksInput): DoiDisplayLinks {
  const extraIdentifiers = parseDisplayExtra(input.extra);
  const managedZenodoIdentifiers = parseManagedExtraIdentifiers(input.extra);
  const attachmentIdentifiers = parseDisplayAttachments(input.attachmentsData);

  const crossrefDoi = firstDefined([
    normalizeDoi(input.DOI),
    normalizeDoi(input.doi),
    extraIdentifiers.crossrefDoi,
    attachmentIdentifiers.crossrefDoi
  ]);

  const zenodoLatestRecordId = firstDefined([
    managedZenodoIdentifiers.zenodoLatestRecordId,
    attachmentIdentifiers.zenodoLatestRecordId
  ]);
  const zenodoParentId = managedZenodoIdentifiers.zenodoParentId;
  const zenodoBaseUrl = normalizeBaseUrl(input.zenodoBaseUrl)
    ?? extraIdentifiers.zenodoBaseUrl
    ?? attachmentIdentifiers.zenodoBaseUrl
    ?? DEFAULT_ZENODO_BASE_URL;

  const crossrefDoiLink = crossrefDoi
    ? doiLink('crossref', 'Crossref DOI', crossrefDoi)
    : undefined;
  const zenodoVersionDoiLink = extraIdentifiers.zenodoVersionDoi
    ? doiLink('zenodo', 'Zenodo DOI', extraIdentifiers.zenodoVersionDoi)
    : undefined;
  const zenodoConceptDoiLink = extraIdentifiers.zenodoConceptDoi
    ? doiLink('zenodo', 'Zenodo concept DOI', extraIdentifiers.zenodoConceptDoi)
    : undefined;
  const zenodoRecordLink = zenodoLatestRecordId
    ? recordLink('zenodo', 'record', 'Zenodo archive', zenodoLatestRecordId, zenodoBaseUrl)
    : undefined;
  const zenodoConceptRecordLink = zenodoParentId && zenodoParentId !== zenodoLatestRecordId
    ? recordLink('zenodo', 'concept-record', 'Zenodo concept record', zenodoParentId, zenodoBaseUrl)
    : undefined;

  const links = uniqueLinks([
    crossrefDoiLink,
    zenodoVersionDoiLink,
    zenodoConceptDoiLink,
    zenodoRecordLink,
    zenodoConceptRecordLink
  ]);

  return {
    ...(crossrefDoiLink ? { crossrefDoi: crossrefDoiLink } : {}),
    ...(zenodoVersionDoiLink ? { zenodoVersionDoi: zenodoVersionDoiLink } : {}),
    ...(zenodoConceptDoiLink ? { zenodoConceptDoi: zenodoConceptDoiLink } : {}),
    ...(zenodoRecordLink ? { zenodoRecord: zenodoRecordLink } : {}),
    ...(zenodoConceptRecordLink ? { zenodoConceptRecord: zenodoConceptRecordLink } : {}),
    links
  };
}

function parseDisplayExtra(extra: string | null | undefined): ParsedExtraDisplayIdentifiers {
  let crossrefDoi: string | undefined;
  let zenodoVersionDoi: string | undefined;
  let zenodoConceptDoi: string | undefined;
  let zenodoBaseUrl: string | undefined;

  for (const rawLine of (extra ?? '').split(/\r?\n/)) {
    const separator = rawLine.indexOf(':');
    if (separator < 0) continue;
    const key = rawLine.slice(0, separator).trim().toLowerCase();
    const value = rawLine.slice(separator + 1).trim();
    if (!value) continue;

    if (key === 'archive') {
      const baseUrl = zenodoBaseUrlFromRecordUrl(value);
      if (baseUrl) zenodoBaseUrl = baseUrl;
      continue;
    }

    const normalizedDoi = normalizeDoi(value);
    if (!normalizedDoi) continue;

    if (key === 'doi' && !isZenodoDoi(normalizedDoi)) {
      crossrefDoi ??= normalizedDoi;
      continue;
    }

    if ((key === 'zenodoversiondoi' || key === 'zenododoi') && isZenodoDoi(normalizedDoi)) {
      zenodoVersionDoi ??= normalizedDoi;
      continue;
    }

    if (key === 'zenodoconceptdoi' && isZenodoDoi(normalizedDoi)) {
      zenodoConceptDoi ??= normalizedDoi;
      continue;
    }

    if (key === 'doi' && !crossrefDoi && isZenodoDoi(normalizedDoi)) {
      zenodoVersionDoi ??= normalizedDoi;
    }
  }

  return {
    ...(crossrefDoi ? { crossrefDoi } : {}),
    ...(zenodoVersionDoi ? { zenodoVersionDoi } : {}),
    ...(zenodoConceptDoi ? { zenodoConceptDoi } : {}),
    ...(zenodoBaseUrl ? { zenodoBaseUrl } : {})
  };
}

function parseDisplayAttachments(attachments: readonly DoiDisplayAttachment[] | null | undefined): {
  readonly crossrefDoi?: string;
  readonly zenodoLatestRecordId?: string;
  readonly zenodoBaseUrl?: string;
} {
  let crossrefDoi: string | undefined;
  let zenodoLatestRecordId: string | undefined;
  let zenodoBaseUrl: string | undefined;

  for (const attachment of attachments ?? []) {
    const url = attachment.url?.trim();
    if (!url) continue;
    const normalizedTags = new Set((attachment.tags ?? []).map((tag) => tag.trim().toLowerCase()));

    if (!crossrefDoi && normalizedTags.has(DOI_TAG)) {
      const doi = normalizeDoi(url);
      if (doi && !isZenodoDoi(doi)) crossrefDoi = doi;
    }

    if (!zenodoLatestRecordId && hasAnyTag(normalizedTags, ZENODO_RECORD_TAGS)) {
      const recordId = zenodoRecordIdFromUrl(url);
      if (recordId) {
        zenodoLatestRecordId = recordId;
        zenodoBaseUrl = zenodoBaseUrlFromRecordUrl(url) ?? zenodoBaseUrl;
      }
    }
  }

  return {
    ...(crossrefDoi ? { crossrefDoi } : {}),
    ...(zenodoLatestRecordId ? { zenodoLatestRecordId } : {}),
    ...(zenodoBaseUrl ? { zenodoBaseUrl } : {})
  };
}

function doiLink(provider: DoiDisplayProvider, label: string, doi: string): DoiDisplayLink {
  return {
    provider,
    kind: 'doi',
    label,
    value: doi,
    url: `https://doi.org/${doi}`
  };
}

function recordLink(
  provider: DoiDisplayProvider,
  kind: Extract<DoiDisplayKind, 'record' | 'concept-record'>,
  label: string,
  recordId: string,
  baseUrl: string
): DoiDisplayLink {
  return {
    provider,
    kind,
    label,
    value: recordId,
    url: `${baseUrl}/records/${encodeURIComponent(recordId)}`
  };
}

function isZenodoDoi(doi: string): boolean {
  return ZENODO_DOI_PATTERN.test(doi);
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/u, '');
  if (!trimmed || !/^https?:\/\/[^/]+$/i.test(trimmed)) return null;
  return trimmed;
}

function zenodoRecordIdFromUrl(url: string): string | null {
  return ZENODO_RECORD_URL_PATTERN.exec(url)?.[1] ?? null;
}

function zenodoBaseUrlFromRecordUrl(url: string): string | undefined {
  const recordId = zenodoRecordIdFromUrl(url);
  if (!recordId) return undefined;
  const parsed = URL.canParse(url) ? new URL(url) : null;
  return parsed ? `${parsed.protocol}//${parsed.host}` : undefined;
}

function hasAnyTag(tags: ReadonlySet<string>, desiredTags: ReadonlySet<string>): boolean {
  for (const tag of desiredTags) {
    if (tags.has(tag)) return true;
  }
  return false;
}

function firstDefined(values: readonly (string | null | undefined)[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function uniqueLinks(links: readonly (DoiDisplayLink | undefined)[]): readonly DoiDisplayLink[] {
  const seen = new Set<string>();
  const unique: DoiDisplayLink[] = [];
  for (const link of links) {
    if (!link || seen.has(link.url)) continue;
    seen.add(link.url);
    unique.push(link);
  }
  return unique;
}
