import type { CrossrefRestWork } from './crossref/response.js';
import { isRecord } from './guards.js';
import type { JsonValue } from './hash.js';
import { isJsonObject } from './json.js';
import type { CanonicalCreator, CanonicalMetadataSnapshot } from './metadata.js';
import { compareCodeUnits } from './sort.js';
import type { ZenodoLegacyDepositionPayload, ZenodoRecordSnapshot } from './zenodo/records.js';
import { CROSSREF_REPORT_PAPER_WORK_TYPE } from './crossref/xml.js';

export type MetadataAuditProvider = 'crossref' | 'zenodo';
export type MetadataAuditSeverity = 'info' | 'review' | 'unsafe';
export type MetadataAuditValue = string | readonly string[];

export interface MetadataAuditFinding {
  readonly provider: MetadataAuditProvider;
  readonly severity: MetadataAuditSeverity;
  readonly field: string;
  readonly current: MetadataAuditValue | undefined;
  readonly planned: MetadataAuditValue | undefined;
  readonly message: string;
}

export interface AuditCrossrefDepositMetadataInput {
  readonly current: CrossrefRestWork | null;
  readonly planned: CanonicalMetadataSnapshot;
  readonly plannedResourceUrl: string;
}

export interface AuditZenodoWritePayloadMetadataInput {
  readonly current: ZenodoRecordSnapshot | null;
  readonly planned: ZenodoLegacyDepositionPayload;
}

interface ComparableCrossrefMetadata {
  readonly doi?: string;
  readonly itemType?: string;
  readonly title?: string;
  readonly publicationDate?: string;
  readonly abstract?: string;
  readonly publisher?: string;
  readonly creators: readonly string[];
  readonly resourceUrl?: string;
}

/** Compares a planned Crossref deposit with the currently indexed Crossref record before writing. */
export function auditCrossrefDepositMetadata(input: AuditCrossrefDepositMetadataInput): readonly MetadataAuditFinding[] {
  if (!input.current) {
    return [{
      provider: 'crossref',
      severity: 'review',
      field: 'record',
      current: undefined,
      planned: input.planned.doi,
      message: 'Crossref has no current REST record for this DOI; review this as a first deposit or indexing delay'
    }];
  }

  const current = comparableCrossrefMetadata(input.current);
  const planned = comparablePlannedCrossrefMetadata(input.planned, input.plannedResourceUrl);

  return [
    ...auditRequiredIdentity(current, planned),
    ...auditOptionalField({
      provider: 'crossref',
      field: 'title',
      current: current.title,
      planned: planned.title,
      missingMessage: 'planned Crossref metadata would remove the current title',
      changedMessage: 'planned Crossref title differs from the current provider record; review against Zotero canonical metadata'
    }),
    ...auditPublicationDate(current.publicationDate, planned.publicationDate),
    ...auditOptionalField({
      provider: 'crossref',
      field: 'publisher',
      current: current.publisher,
      planned: planned.publisher,
      missingMessage: 'planned Crossref metadata would remove the current publisher',
      changedMessage: 'planned Crossref publisher differs from the current provider record; review against Zotero canonical metadata'
    }),
    ...auditAbstract(current.abstract, planned.abstract),
    ...auditCreators(current.creators, planned.creators),
    ...auditOptionalField({
      provider: 'crossref',
      field: 'resourceUrl',
      current: current.resourceUrl,
      planned: planned.resourceUrl,
      missingMessage: 'planned Crossref deposit would remove the current resource URL',
      changedMessage: 'planned Crossref resource URL differs from the current provider record; review the landing page'
    })
  ];
}

export function auditZenodoWritePayloadMetadata(input: AuditZenodoWritePayloadMetadataInput): readonly MetadataAuditFinding[] {
  if (!input.current) {
    return [{
      provider: 'zenodo',
      severity: 'review',
      field: 'record',
      current: undefined,
      planned: stringJson(input.planned.metadata['doi']),
      message: 'Zenodo has no current published record snapshot; review this as a first publish or indexing delay'
    }];
  }

  const current = comparableZenodoMetadata(input.current);
  const planned = comparablePlannedZenodoMetadata(input.planned);
  return [
    ...auditZenodoDoi(current.doi, planned.doi),
    ...auditOptionalField({
      provider: 'zenodo',
      field: 'title',
      current: current.title,
      planned: planned.title,
      missingMessage: 'planned Zenodo metadata would remove the current title',
      changedMessage: 'planned Zenodo title differs from the current provider record; review against Zotero canonical metadata'
    }),
    ...auditZenodoPublicationDate(current.publicationDate, planned.publicationDate),
    ...auditZenodoDescription(current.description, planned.description),
    ...auditZenodoCreators(current.creators, planned.creators),
    ...auditZenodoBackLinks(current.zoteroBackLinks, planned.zoteroBackLinks)
  ];
}

function auditRequiredIdentity(
  current: ComparableCrossrefMetadata,
  planned: ComparableCrossrefMetadata
): readonly MetadataAuditFinding[] {
  const findings: MetadataAuditFinding[] = [];
  if (current.doi && !sameNormalized(current.doi, planned.doi)) {
    findings.push(finding({
      provider: 'crossref',
      field: 'doi',
      severity: 'unsafe',
      current: current.doi,
      planned: planned.doi,
      message: 'planned Crossref DOI differs from the current provider record'
    }));
  }
  if (current.itemType && planned.itemType && !sameNormalized(current.itemType, planned.itemType)) {
    findings.push(finding({
      provider: 'crossref',
      field: 'itemType',
      severity: 'review',
      current: current.itemType,
      planned: planned.itemType,
      message: 'planned Crossref type differs from the current provider record; review against Zotero canonical metadata'
    }));
  }
  return findings;
}

function auditOptionalField(input: {
  readonly provider: MetadataAuditProvider;
  readonly field: string;
  readonly current: string | undefined;
  readonly planned: string | undefined;
  readonly missingMessage: string;
  readonly changedMessage: string;
}): readonly MetadataAuditFinding[] {
  if (!input.current && !input.planned) return [];
  if (input.current && !input.planned) {
    return [finding({
      provider: input.provider,
      field: input.field,
      severity: 'unsafe',
      current: input.current,
      planned: undefined,
      message: input.missingMessage
    })];
  }
  if (input.current && input.planned && !sameNormalized(input.current, input.planned)) {
    return [finding({
      provider: input.provider,
      field: input.field,
      severity: 'review',
      current: input.current,
      planned: input.planned,
      message: input.changedMessage
    })];
  }
  return [];
}

function auditPublicationDate(current: string | undefined, planned: string | undefined): readonly MetadataAuditFinding[] {
  if (!current && !planned) return [];
  if (current && !planned) {
    return [finding({
      provider: 'crossref',
      field: 'publicationDate',
      severity: 'unsafe',
      current,
      planned: undefined,
      message: 'planned Crossref metadata would remove the current publication date'
    })];
  }
  if (!current || !planned || current === planned) return [];
  return [finding({
    provider: 'crossref',
    field: 'publicationDate',
    severity: plannedDateLosesMonthPrecision(current, planned) ? 'unsafe' : 'review',
    current,
    planned,
    message: plannedDateLosesMonthPrecision(current, planned)
      ? 'planned Crossref publication date appears to lose month precision from the current provider record'
      : 'planned Crossref publication date differs from the current provider record; review against Zotero canonical metadata'
  })];
}

function auditAbstract(current: string | undefined, planned: string | undefined): readonly MetadataAuditFinding[] {
  if (!current && !planned) return [];
  if (current && !planned) {
    return [finding({
      provider: 'crossref',
      field: 'abstract',
      severity: 'unsafe',
      current,
      planned: undefined,
      message: 'planned Crossref metadata would remove the current abstract'
    })];
  }
  if (!current || !planned || sameNormalized(current, planned)) return [];
  const plannedLength = normalizedComparableText(planned).length;
  const currentLength = normalizedComparableText(current).length;
  return [finding({
    provider: 'crossref',
    field: 'abstract',
    severity: currentLength > 0 && plannedLength / currentLength < 0.7 ? 'unsafe' : 'review',
    current,
    planned,
    message: currentLength > 0 && plannedLength / currentLength < 0.7
      ? 'planned Crossref abstract is much shorter than the current provider record'
      : 'planned Crossref abstract differs from the current provider record; review against Zotero canonical metadata'
  })];
}

function auditCreators(current: readonly string[], planned: readonly string[]): readonly MetadataAuditFinding[] {
  if (current.length === 0 && planned.length === 0) return [];
  if (current.length > planned.length) {
    return [finding({
      provider: 'crossref',
      field: 'creators',
      severity: 'unsafe',
      current,
      planned,
      message: 'planned Crossref metadata would drop creator entries from the current provider record'
    })];
  }
  if (!sameStringList(current, planned)) {
    return [finding({
      provider: 'crossref',
      field: 'creators',
      severity: 'review',
      current,
      planned,
      message: 'planned Crossref creators differ from the current provider record; review against Zotero canonical metadata'
    })];
  }
  return [];
}

function finding(input: MetadataAuditFinding): MetadataAuditFinding {
  return input;
}

function comparablePlannedCrossrefMetadata(
  metadata: CanonicalMetadataSnapshot,
  resourceUrl: string
): ComparableCrossrefMetadata {
  return {
    doi: metadata.doi,
    itemType: CROSSREF_REPORT_PAPER_WORK_TYPE,
    title: metadata.title,
    publicationDate: metadata.publicationDate,
    ...(metadata.abstract ? { abstract: metadata.abstract } : {}),
    ...(metadata.publisher ? { publisher: metadata.publisher } : {}),
    creators: metadata.creators.map(creatorDisplayName).sort(compareCodeUnits),
    resourceUrl
  };
}

function comparableCrossrefMetadata(work: CrossrefRestWork): ComparableCrossrefMetadata {
  const title = firstString(work.raw['title']);
  const publicationDate = crossrefPublicationDate(work.raw);
  const abstract = crossrefAbstract(work.raw);
  const publisher = stringValue(work.raw['publisher']);
  return {
    ...(work.doi ? { doi: work.doi } : {}),
    ...(work.type ? { itemType: work.type } : {}),
    ...(title ? { title } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(abstract ? { abstract } : {}),
    ...(publisher ? { publisher } : {}),
    creators: [...crossrefCreatorNames(work.raw)].sort(compareCodeUnits),
    ...(work.resourceUrl ? { resourceUrl: work.resourceUrl } : {})
  };
}

interface ComparableZenodoMetadata {
  readonly doi?: string;
  readonly title?: string;
  readonly publicationDate?: string;
  readonly description?: string;
  readonly creators: readonly string[];
  readonly zoteroBackLinks: readonly string[];
}

function comparableZenodoMetadata(snapshot: ZenodoRecordSnapshot): ComparableZenodoMetadata {
  const title = stringJson(snapshot.metadata['title']);
  const publicationDate = stringJson(snapshot.metadata['publication_date']);
  const description = zenodoDescription(snapshot.metadata['description']);
  return {
    ...(snapshot.identifiers.versionDoi ? { doi: snapshot.identifiers.versionDoi } : {}),
    ...(title ? { title } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(description ? { description } : {}),
    creators: zenodoCurrentCreatorNames(snapshot.metadata['creators']),
    zoteroBackLinks: zenodoIdentifierUrls(snapshot.metadata['identifiers'])
  };
}

function comparablePlannedZenodoMetadata(payload: ZenodoLegacyDepositionPayload): ComparableZenodoMetadata {
  const metadata = payload.metadata;
  const doi = stringJson(metadata['doi']);
  const title = stringJson(metadata['title']);
  const publicationDate = stringJson(metadata['publication_date']);
  const description = zenodoDescription(metadata['description']);
  return {
    ...(doi ? { doi } : {}),
    ...(title ? { title } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(description ? { description } : {}),
    creators: zenodoLegacyCreatorNames(metadata['creators']),
    zoteroBackLinks: zenodoLegacyRelatedIdentifierUrls(metadata['related_identifiers'])
  };
}

function auditZenodoDoi(current: string | undefined, planned: string | undefined): readonly MetadataAuditFinding[] {
  if (!planned || !current || sameNormalized(current, planned)) return [];
  return [finding({
    provider: 'zenodo',
    severity: 'unsafe',
    field: 'doi',
    current,
    planned,
    message: 'planned Zenodo DOI differs from the current provider record'
  })];
}

function auditZenodoPublicationDate(current: string | undefined, planned: string | undefined): readonly MetadataAuditFinding[] {
  if (!current && !planned) return [];
  if (current && !planned) {
    return [finding({
      provider: 'zenodo',
      field: 'publicationDate',
      severity: 'unsafe',
      current,
      planned: undefined,
      message: 'planned Zenodo metadata would remove the current publication date'
    })];
  }
  if (!current || !planned || current === planned) return [];
  return [finding({
    provider: 'zenodo',
    field: 'publicationDate',
    severity: plannedDateLosesMonthPrecision(current, planned) ? 'unsafe' : 'review',
    current,
    planned,
    message: plannedDateLosesMonthPrecision(current, planned)
      ? 'planned Zenodo publication date appears to lose month precision from the current provider record'
      : 'planned Zenodo publication date differs from the current provider record; review against Zotero canonical metadata'
  })];
}

function auditZenodoCreators(current: readonly string[], planned: readonly string[]): readonly MetadataAuditFinding[] {
  if (current.length === 0 && planned.length === 0) return [];
  if (current.length > planned.length) {
    return [finding({
      provider: 'zenodo',
      severity: 'unsafe',
      field: 'creators',
      current,
      planned,
      message: 'planned Zenodo metadata would drop creator entries from the current provider record'
    })];
  }
  if (!sameStringList(current, planned)) {
    return [finding({
      provider: 'zenodo',
      severity: 'review',
      field: 'creators',
      current,
      planned,
      message: 'planned Zenodo creators differ from the current provider record; review against Zotero canonical metadata'
    })];
  }
  return [];
}

function auditZenodoDescription(current: string | undefined, planned: string | undefined): readonly MetadataAuditFinding[] {
  if (!current && !planned) return [];
  if (current && !planned) {
    return [finding({
      provider: 'zenodo',
      severity: 'unsafe',
      field: 'description',
      current,
      planned: undefined,
      message: 'planned Zenodo metadata would remove the current description'
    })];
  }
  if (!current || !planned) return [];
  if (sameNormalized(current, planned) || normalizedComparableText(planned).includes(normalizedComparableText(current))) return [];
  const plannedLength = normalizedComparableText(planned).length;
  const currentLength = normalizedComparableText(current).length;
  return [finding({
    provider: 'zenodo',
    severity: currentLength > 0 && plannedLength / currentLength < 0.7 ? 'unsafe' : 'review',
    field: 'description',
    current,
    planned,
    message: currentLength > 0 && plannedLength / currentLength < 0.7
      ? 'planned Zenodo description is much shorter than the current provider record'
      : 'planned Zenodo description differs from the current provider record; review against Zotero canonical metadata'
  })];
}

function auditZenodoBackLinks(current: readonly string[], planned: readonly string[]): readonly MetadataAuditFinding[] {
  if (planned.length === 0) return [];
  const missing = planned.filter((url) => !current.some((entry) => sameNormalized(entry, url)));
  if (missing.length === 0) return [];
  return [finding({
    provider: 'zenodo',
    severity: 'review',
    field: 'zoteroBackLinks',
    current,
    planned,
    message: 'planned Zenodo Zotero back-link identifiers are not all present on the current provider record'
  })];
}

function stringJson(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? normalizeSingleLine(value) : undefined;
}

function zenodoDescription(value: JsonValue | undefined): string | undefined {
  return normalizeSingleLine(stripMarkup(stringJson(value)));
}

function zenodoCurrentCreatorNames(value: JsonValue | undefined): readonly string[] {
  return jsonRecords(value)
    .map((creator) => {
      const personOrOrg = jsonRecord(creator['person_or_org']);
      return stringJson(personOrOrg?.['name']) ?? stringJson(creator['name']);
    })
    .filter(isString)
    .sort(compareCodeUnits);
}

function zenodoLegacyCreatorNames(value: JsonValue | undefined): readonly string[] {
  return jsonRecords(value)
    .map((creator) => stringJson(creator['name']))
    .filter(isString)
    .sort(compareCodeUnits);
}

function zenodoIdentifierUrls(value: JsonValue | undefined): readonly string[] {
  return jsonRecords(value)
    .filter((entry) => stringJson(entry['scheme']) === 'url')
    .map((entry) => stringJson(entry['identifier']))
    .filter(isString)
    .sort(compareCodeUnits);
}

function zenodoLegacyRelatedIdentifierUrls(value: JsonValue | undefined): readonly string[] {
  return jsonRecords(value)
    .filter((entry) => stringJson(entry['scheme']) === 'url')
    .map((entry) => stringJson(entry['identifier']))
    .filter(isString)
    .sort(compareCodeUnits);
}

function jsonRecords(value: JsonValue | undefined): readonly Readonly<Record<string, JsonValue>>[] {
  const entries: readonly JsonValue[] = Array.isArray(value) ? value : [];
  const output: Array<Readonly<Record<string, JsonValue>>> = [];
  for (const entry of entries) {
    const record = jsonRecord(entry);
    if (record) output.push(record);
  }
  return output;
}

function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null {
  return value !== undefined && isJsonObject(value) ? value : null;
}

function creatorDisplayName(creator: CanonicalCreator): string {
  return creator.name;
}

function crossrefCreatorNames(raw: Readonly<Record<string, unknown>>): readonly string[] {
  return records(raw['author'])
    .map((author) => {
      const family = stringValue(author['family']);
      const given = stringValue(author['given']);
      const name = stringValue(author['name']);
      return normalizeSingleLine([family, given].filter(isString).join(', ')) ?? normalizeSingleLine(name);
    })
    .filter(isString);
}

function crossrefPublicationDate(raw: Readonly<Record<string, unknown>>): string | undefined {
  return datePartsValue(raw['published'])
    ?? datePartsValue(raw['published-online'])
    ?? datePartsValue(raw['issued']);
}

function datePartsValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const dateParts = record ? arrays(record['date-parts']) : [];
  const first = dateParts[0];
  if (!first) return undefined;
  const year = numberPart(first[0]);
  if (!year) return undefined;
  const month = numberPart(first[1]) ?? '01';
  const day = numberPart(first[2]) ?? '01';
  return `${year}-${month}-${day}`;
}

function numberPart(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? String(value).padStart(2, '0')
    : undefined;
}

function crossrefAbstract(raw: Readonly<Record<string, unknown>>): string | undefined {
  return normalizeSingleLine(stripMarkup(stringValue(raw['abstract'])));
}

function stripMarkup(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function plannedDateLosesMonthPrecision(current: string, planned: string): boolean {
  const currentParts = parseIsoDate(current);
  const plannedParts = parseIsoDate(planned);
  if (!currentParts || !plannedParts) return false;
  return currentParts.year === plannedParts.year
    && currentParts.month !== '01'
    && plannedParts.month === '01'
    && plannedParts.day === '01';
}

function parseIsoDate(value: string): { readonly year: string; readonly month: string; readonly day: string } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    year: match[1],
    month: match[2],
    day: match[3]
  };
}

function firstString(value: unknown): string | undefined {
  const entries: readonly unknown[] = Array.isArray(value) ? value : [];
  const first = entries[0];
  return normalizeSingleLine(stringValue(first));
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => sameNormalized(entry, right[index]));
}

function sameNormalized(left: string | undefined, right: string | undefined): boolean {
  return normalizedComparableText(left) === normalizedComparableText(right);
}

function normalizedComparableText(value: string | undefined): string {
  return normalizeSingleLine(value)?.toLowerCase() ?? '';
}

function normalizeSingleLine(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function records(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  const output: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record) output.push(record);
  }
  return output;
}

function arrays(value: unknown): readonly (readonly unknown[])[] {
  return Array.isArray(value) ? value.filter((entry): entry is readonly unknown[] => Array.isArray(entry)) : [];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string';
}
