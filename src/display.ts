import { normalizeDoi } from './doi.js';

export type DoiDisplayProvider = 'doi' | 'crossref' | 'zenodo';
export type DoiDisplayKind = 'doi' | 'record' | 'concept-record';

export interface BuildDoiDisplayLinksInput {
  readonly bibliographicDoi?: string | null;
  readonly crossrefDoi?: string | null;
  readonly zenodoVersionDoi?: string | null;
  readonly zenodoConceptDoi?: string | null;
  readonly zenodoRecordId?: string | number | null;
  readonly zenodoConceptRecordId?: string | number | null;
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
  readonly bibliographicDoi?: DoiDisplayLink;
  readonly crossrefDoi?: DoiDisplayLink;
  readonly zenodoVersionDoi?: DoiDisplayLink;
  readonly zenodoConceptDoi?: DoiDisplayLink;
  readonly zenodoRecord?: DoiDisplayLink;
  readonly zenodoConceptRecord?: DoiDisplayLink;
  readonly links: readonly DoiDisplayLink[];
}

const DEFAULT_ZENODO_BASE_URL = 'https://zenodo.org';

/** Builds display-ready links from identifiers already classified by the host application. */
export function buildDoiDisplayLinks(input: BuildDoiDisplayLinksInput): DoiDisplayLinks {
  const bibliographicDoi = normalizeDoi(input.bibliographicDoi);
  const crossrefDoi = normalizeDoi(input.crossrefDoi);
  const zenodoVersionDoi = normalizeDoi(input.zenodoVersionDoi);
  const zenodoConceptDoi = normalizeDoi(input.zenodoConceptDoi);
  const zenodoRecordId = normalizeRecordId(input.zenodoRecordId);
  const zenodoConceptRecordId = normalizeRecordId(input.zenodoConceptRecordId);
  const zenodoBaseUrl = input.zenodoBaseUrl === undefined || input.zenodoBaseUrl === null
    ? DEFAULT_ZENODO_BASE_URL
    : normalizeBaseUrl(input.zenodoBaseUrl);

  const crossrefDoiLink = crossrefDoi
    ? doiLink('crossref', 'Crossref DOI', crossrefDoi)
    : undefined;
  const bibliographicDoiLink = bibliographicDoi
    ? bibliographicDoi === crossrefDoi
      ? crossrefDoiLink
      : doiLink('doi', 'DOI', bibliographicDoi)
    : undefined;
  const zenodoVersionDoiLink = zenodoVersionDoi
    ? doiLink('zenodo', 'Zenodo DOI', zenodoVersionDoi)
    : undefined;
  const zenodoConceptDoiLink = zenodoConceptDoi
    ? doiLink('zenodo', 'Zenodo concept DOI', zenodoConceptDoi)
    : undefined;
  const zenodoRecordLink = zenodoRecordId && zenodoBaseUrl
    ? recordLink('record', 'Zenodo archive', zenodoRecordId, zenodoBaseUrl)
    : undefined;
  const zenodoConceptRecordLink = zenodoConceptRecordId
    && zenodoConceptRecordId !== zenodoRecordId
    && zenodoBaseUrl
    ? recordLink('concept-record', 'Zenodo concept record', zenodoConceptRecordId, zenodoBaseUrl)
    : undefined;

  return {
    ...(bibliographicDoiLink ? { bibliographicDoi: bibliographicDoiLink } : {}),
    ...(crossrefDoiLink ? { crossrefDoi: crossrefDoiLink } : {}),
    ...(zenodoVersionDoiLink ? { zenodoVersionDoi: zenodoVersionDoiLink } : {}),
    ...(zenodoConceptDoiLink ? { zenodoConceptDoi: zenodoConceptDoiLink } : {}),
    ...(zenodoRecordLink ? { zenodoRecord: zenodoRecordLink } : {}),
    ...(zenodoConceptRecordLink ? { zenodoConceptRecord: zenodoConceptRecordLink } : {}),
    links: uniqueLinks([
      bibliographicDoiLink,
      crossrefDoiLink,
      zenodoVersionDoiLink,
      zenodoConceptDoiLink,
      zenodoRecordLink,
      zenodoConceptRecordLink
    ])
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
  kind: Extract<DoiDisplayKind, 'record' | 'concept-record'>,
  label: string,
  recordId: string,
  baseUrl: string
): DoiDisplayLink {
  return {
    provider: 'zenodo',
    kind,
    label,
    value: recordId,
    url: `${baseUrl}/records/${encodeURIComponent(recordId)}`
  };
}

function normalizeRecordId(value: string | number | null | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }

  const trimmed = value?.trim();
  return trimmed && /^\d+$/u.test(trimmed) ? trimmed : null;
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/u, '');
  if (!trimmed || !URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.pathname !== '/'
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) return null;
  return url.origin;
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
