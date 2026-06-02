import { resolveCrossrefDoi } from './doi.js';
import { compareCodeUnits } from './sort.js';

export interface ZoteroCreator {
  readonly creatorType: string;
  readonly firstName?: string | null | undefined;
  readonly lastName?: string | null | undefined;
  readonly name?: string | null | undefined;
}

export interface ZoteroTag {
  readonly tag: string;
}

export type ZoteroRelations = Readonly<Record<string, string | readonly string[]>>;

export interface ZoteroParentItem {
  readonly key: string;
  readonly version: number;
  readonly data: {
    readonly itemType: string;
    readonly title?: string | null | undefined;
    readonly DOI?: string | null | undefined;
    readonly doi?: string | null | undefined;
    readonly date?: string | null | undefined;
    readonly abstractNote?: string | null | undefined;
    readonly language?: string | null | undefined;
    readonly institution?: string | null | undefined;
    readonly publisher?: string | null | undefined;
    readonly creators?: readonly ZoteroCreator[] | null | undefined;
    readonly tags?: readonly ZoteroTag[] | null | undefined;
    readonly extra?: string | null | undefined;
    readonly callNumber?: string | null | undefined;
    readonly url?: string | null | undefined;
    readonly deleted?: boolean | number | null | undefined;
    readonly relations?: ZoteroRelations | null | undefined;
  };
}

export interface CanonicalCreator {
  readonly type: 'personal' | 'organizational';
  readonly name: string;
  readonly creatorType?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly affiliation?: string;
  readonly orcid?: string;
}

export interface AuthorEnrichment {
  readonly name: string;
  readonly aliases?: readonly string[] | null | undefined;
  readonly affiliation?: string | null | undefined;
  readonly organization?: string | null | undefined;
  readonly orcid?: string | null | undefined;
}

export interface CanonicalMetadataSnapshot {
  readonly doi: string;
  readonly itemType: string;
  readonly title: string;
  readonly publicationDate: string;
  readonly abstract?: string;
  readonly language?: string;
  readonly publisher?: string;
  readonly creators: readonly CanonicalCreator[];
  readonly tags: readonly string[];
}

export interface BuildCanonicalMetadataInput {
  readonly recordDoi: string;
  readonly zoteroItem: ZoteroParentItem;
  readonly callNumberDoiPrefix?: string | null | undefined;
  readonly fallbackPublicationDate: string;
  readonly authorEnrichments?: readonly AuthorEnrichment[] | null | undefined;
}

/** Normalizes a Zotero parent item into the canonical metadata shared by Crossref and Zenodo. */
export function buildCanonicalMetadataSnapshot(input: BuildCanonicalMetadataInput): CanonicalMetadataSnapshot {
  const data = input.zoteroItem.data;
  const resolvedDoi = resolveCrossrefDoi({
    recordDoi: input.recordDoi,
    zoteroDoi: data.DOI,
    zoteroLowercaseDoi: data.doi,
    extra: data.extra,
    callNumber: data.callNumber,
    callNumberDoiPrefix: input.callNumberDoiPrefix
  });
  if (!resolvedDoi.doi) throw new Error('Cannot build canonical metadata without a valid DOI');

  return withOptionalMetadata({
    doi: resolvedDoi.doi,
    itemType: data.itemType,
    title: normalizeWhitespace(data.title) || 'Untitled',
    publicationDate: normalizeDate(data.date, input.fallbackPublicationDate),
    creators: enrichCreators(normalizeCreators(data.creators ?? []), input.authorEnrichments ?? []),
    tags: normalizeTags(data.tags ?? [])
  }, data);
}

function withOptionalMetadata(
  base: Omit<CanonicalMetadataSnapshot, 'abstract' | 'language' | 'publisher'>,
  data: ZoteroParentItem['data']
): CanonicalMetadataSnapshot {
  const abstract = normalizeWhitespace(data.abstractNote);
  const language = normalizeWhitespace(data.language);
  const publisher = normalizeWhitespace(data.institution)
    || normalizeWhitespace(data.publisher)
    || publisherFromDoiNamespace(base.doi);

  return {
    ...base,
    ...(abstract ? { abstract } : {}),
    ...(language ? { language } : {}),
    ...(publisher ? { publisher } : {})
  };
}

function normalizeCreators(creators: readonly ZoteroCreator[]): readonly CanonicalCreator[] {
  return creators.map((creator) => {
    const firstName = normalizeWhitespace(creator.firstName);
    const lastName = normalizeWhitespace(creator.lastName);
    const name = normalizeWhitespace(creator.name);

    if (lastName || firstName) {
      return {
        type: 'personal',
        name: [lastName, firstName].filter(Boolean).join(', '),
        creatorType: normalizeCreatorType(creator.creatorType),
        ...(firstName ? { givenName: firstName } : {}),
        ...(lastName ? { familyName: lastName } : {})
      };
    }

    return {
      type: 'organizational',
      name: name || 'Unknown creator',
      creatorType: normalizeCreatorType(creator.creatorType)
    };
  });
}

function enrichCreators(
  creators: readonly CanonicalCreator[],
  enrichments: readonly AuthorEnrichment[]
): readonly CanonicalCreator[] {
  if (enrichments.length === 0) return creators;

  const index = buildAuthorEnrichmentIndex(enrichments);
  return creators.map((creator) => {
    const enrichment = findAuthorEnrichment(creator, index);
    if (!enrichment) return creator;

    return {
      ...creator,
      ...(enrichment.affiliation ? { affiliation: enrichment.affiliation } : {}),
      ...(enrichment.orcid ? { orcid: enrichment.orcid } : {})
    };
  });
}

interface NormalizedAuthorEnrichment {
  readonly affiliation?: string;
  readonly orcid?: string;
}

function buildAuthorEnrichmentIndex(enrichments: readonly AuthorEnrichment[]): ReadonlyMap<string, NormalizedAuthorEnrichment> {
  const index = new Map<string, NormalizedAuthorEnrichment>();
  for (const enrichment of enrichments) {
    const normalized = normalizeAuthorEnrichment(enrichment);
    if (!normalized) continue;

    for (const name of [enrichment.name, ...(enrichment.aliases ?? [])]) {
      const key = authorLookupKey(name);
      if (key) index.set(key, normalized);
    }
  }
  return index;
}

function normalizeAuthorEnrichment(enrichment: AuthorEnrichment): NormalizedAuthorEnrichment | null {
  const affiliation = normalizeWhitespace(enrichment.affiliation) || normalizeWhitespace(enrichment.organization);
  const orcid = normalizeWhitespace(enrichment.orcid);
  if (!affiliation && !orcid) return null;
  return {
    ...(affiliation ? { affiliation } : {}),
    ...(orcid ? { orcid } : {})
  };
}

function findAuthorEnrichment(
  creator: CanonicalCreator,
  index: ReadonlyMap<string, NormalizedAuthorEnrichment>
): NormalizedAuthorEnrichment | undefined {
  for (const candidate of authorLookupCandidates(creator)) {
    const key = authorLookupKey(candidate);
    const enrichment = key ? index.get(key) : undefined;
    if (enrichment) return enrichment;
  }
  return undefined;
}

function authorLookupCandidates(creator: CanonicalCreator): readonly string[] {
  return [
    creator.name,
    [creator.givenName, creator.familyName].filter(Boolean).join(' '),
    [creator.familyName, creator.givenName].filter(Boolean).join(', ')
  ].filter((candidate) => candidate.trim().length > 0);
}

function authorLookupKey(value: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeCreatorType(value: string | null | undefined): string {
  return normalizeWhitespace(value) ?? 'author';
}

function normalizeTags(tags: readonly ZoteroTag[]): readonly string[] {
  return [...new Set(tags.map((tag) => normalizeWhitespace(tag.tag)).filter(isExternalMetadataTag))]
    .sort(compareCodeUnits);
}

function isExternalMetadataTag(tag: string | null): tag is string {
  if (!tag) return false;
  const lower = tag.toLowerCase();
  if (tag.startsWith('_')) return false;
  if (tag.includes(':')) return false;
  if (lower === 'internal') return false;
  if (lower === 'publication') return false;
  if (lower === 'doi_active') return false;
  if (lower === 'no_custom_doi') return false;
  if (lower === 'fix_metadata') return false;
  return true;
}

function normalizeDate(value: string | null | undefined, fallbackPublicationDate: string): string {
  const normalized = normalizeWhitespace(value);
  const fallback = normalizeFallbackPublicationDate(fallbackPublicationDate);
  if (!normalized) return fallback;

  const isoDate = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDate?.[1] && isoDate[2] && isoDate[3]) {
    return formatDateParts(isoDate[1], isoDate[2], isoDate[3]);
  }

  const isoDateTime = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)$/);
  if (isoDateTime?.[1] && isoDateTime[2] && isoDateTime[3]) {
    return formatDateParts(isoDateTime[1], isoDateTime[2], isoDateTime[3]);
  }

  const dayMonthYear = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dayMonthYear?.[1] && dayMonthYear[2] && dayMonthYear[3]) {
    return formatDateParts(dayMonthYear[3], dayMonthYear[2], dayMonthYear[1]);
  }

  const dayMonthNameYear = normalized.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dayMonthNameYear?.[1] && dayMonthNameYear[2] && dayMonthNameYear[3]) {
    const month = monthNumber(dayMonthNameYear[2]);
    if (month) return formatDateParts(dayMonthNameYear[3], month, dayMonthNameYear[1]);
  }

  const monthNameDayYear = normalized.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthNameDayYear?.[1] && monthNameDayYear[2] && monthNameDayYear[3]) {
    const month = monthNumber(monthNameDayYear[1]);
    if (month) return formatDateParts(monthNameDayYear[3], month, monthNameDayYear[2]);
  }

  const monthNameYear = normalized.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthNameYear?.[1] && monthNameYear[2]) {
    const month = monthNumber(monthNameYear[1]);
    if (month) return formatDateParts(monthNameYear[2], month, '1');
  }

  const yearMonth = normalized.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonth?.[1] && yearMonth[2]) {
    return formatDateParts(yearMonth[1], yearMonth[2], '1');
  }

  const year = normalized.match(/\b\d{4}\b/)?.[0];
  return year ? `${year}-01-01` : fallback;
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : null;
}

function formatDateParts(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function normalizeFallbackPublicationDate(value: string): string {
  const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error('Fallback publication date must be an explicit YYYY-MM-DD date');
  }
  return formatDateParts(match[1], match[2], match[3]);
}

function monthNumber(value: string): string | null {
  const key = value.toLowerCase();
  const months: Readonly<Record<string, string>> = {
    jan: '1',
    january: '1',
    feb: '2',
    february: '2',
    mar: '3',
    march: '3',
    apr: '4',
    april: '4',
    may: '5',
    jun: '6',
    june: '6',
    jul: '7',
    july: '7',
    aug: '8',
    august: '8',
    sep: '9',
    sept: '9',
    september: '9',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12'
  };
  return months[key] ?? null;
}

function publisherFromDoiNamespace(doi: string): string | null {
  const namespace = doi.trim().toLowerCase().match(/^10\.53832\/([a-z0-9-]+)\./)?.[1];
  if (!namespace) return null;
  const publishers: Readonly<Record<string, string>> = {
    edtechhub: 'EdTech Hub',
    ekitabu: 'eKitabu Scaling Inclusive Early Learning for Deaf Children',
    opendeved: 'Open Development & Education',
    unlockingdata: 'Unlocking data'
  };
  return publishers[namespace] ?? null;
}
