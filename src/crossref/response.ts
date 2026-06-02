import { XMLParser } from 'fast-xml-parser';
import { asRecord } from '../guards.js';
import { asJsonObject, toJsonValue, type JsonObject } from '../json.js';
import { crossrefContributorRole } from './contributors.js';

export type CrossrefDiagnosticStatus = 'success' | 'failed' | 'pending';

export interface CrossrefDiagnosticResult {
  readonly status: CrossrefDiagnosticStatus;
  readonly batchStatus?: string;
  readonly recordCount: number;
  readonly successCount: number | null;
  readonly failureCount: number;
}

export interface CrossrefUnixrefRecord {
  readonly doi?: string;
  readonly title?: string;
  readonly abstract?: string;
  readonly abstractLanguage?: string;
  readonly publicationDate?: string;
  readonly publisher?: string;
  readonly institution?: string;
  readonly creators?: readonly CrossrefUnixrefCreator[];
  readonly resourceUrl?: string;
  readonly depositTimestamp?: string;
  readonly relations?: readonly CrossrefUnixrefRelation[];
}

export interface CrossrefUnixrefCreator {
  readonly type: 'personal' | 'organizational';
  readonly name: string;
  readonly creatorType?: string;
  readonly givenName?: string;
  readonly familyName?: string;
}

export interface CrossrefUnixrefRelation {
  readonly type?: string;
  readonly identifierType?: string;
  readonly identifier?: string;
  readonly description?: string;
}

export interface CrossrefRestRelation {
  readonly type: string;
  readonly idType?: string;
  readonly id?: string;
}

export interface CrossrefRestWork {
  readonly doi?: string;
  readonly title?: readonly string[];
  readonly resourceUrl?: string;
  readonly type?: string;
  readonly relations: readonly CrossrefRestRelation[];
  readonly raw: JsonObject;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true
});

export function parseCrossrefDiagnosticXml(xml: string): CrossrefDiagnosticResult {
  const document = asRecord(parser.parse(xml)) ?? {};
  const diagnostic = asRecord(document['doi_batch_diagnostic']);
  const batchData = asRecord(diagnostic?.['batch_data']);
  const recordCount = asNumber(batchData?.['record_count']) ?? 0;
  const successCount = asNumber(batchData?.['success_count']);
  const failureCount = asNumber(batchData?.['failure_count']) ?? 0;

  return {
    status: resolveStatus({ recordCount, successCount, failureCount }),
    ...optionalString('batchStatus', diagnostic?.['@_status']),
    recordCount,
    successCount,
    failureCount
  };
}

export function parseCrossrefUnixrefXml(xml: string): CrossrefUnixrefRecord | null {
  const document = asRecord(parser.parse(xml)) ?? {};
  const doiRecords = asRecord(document['doi_records']);
  const doiRecord = firstRecord(doiRecords?.['doi_record']);
  const crossref = asRecord(doiRecord?.['crossref']);
  const reportPaper = firstRecord(crossref?.['report-paper']);
  const metadata = asRecord(reportPaper?.['report-paper_metadata']);
  if (!metadata) return null;

  const publicationDate = asRecord(metadata['publication_date']);
  const doiData = asRecord(metadata['doi_data']);
  const title = textValue(asRecord(metadata['titles'])?.['title']);
  const abstract = abstractMetadata(metadata);
  const year = textValue(publicationDate?.['year']);
  const month = textValue(publicationDate?.['month']);
  const day = textValue(publicationDate?.['day']);
  const publisher = textValue(asRecord(metadata['publisher'])?.['publisher_name']);
  const institution = textValue(asRecord(metadata['institution'])?.['institution_name']);
  const creators = parseCreators(metadata);
  const relations = parseRelations(metadata);

  return {
    ...optionalString('doi', doiData?.['doi']),
    ...(title ? { title } : {}),
    ...(abstract?.text ? { abstract: abstract.text } : {}),
    ...(abstract?.language ? { abstractLanguage: abstract.language } : {}),
    ...(year ? { publicationDate: formatDateParts(year, month, day) } : {}),
    ...(publisher ? { publisher } : {}),
    ...(institution ? { institution } : {}),
    ...(creators.length > 0 ? { creators } : {}),
    ...optionalString('resourceUrl', doiData?.['resource']),
    ...optionalString('depositTimestamp', doiRecord?.['@_timestamp']),
    ...(relations.length > 0 ? { relations } : {})
  };
}

function abstractMetadata(metadata: Record<string, unknown>): { readonly text: string; readonly language?: string } | null {
  for (const key of ['abstract', 'jats:abstract']) {
    const abstract = asRecord(metadata[key]);
    const paragraph = textValue(abstract?.['p']) ?? textValue(abstract?.['jats:p']) ?? elementText(abstract);
    if (paragraph) {
      const language = textValue(abstract?.['@_xml:lang']) ?? textValue(abstract?.['@_lang']);
      return {
        text: paragraph,
        ...(language ? { language } : {})
      };
    }
  }
  return null;
}

function parseCreators(metadata: Record<string, unknown>): readonly CrossrefUnixrefCreator[] {
  const contributors = asRecord(metadata['contributors']);
  if (!contributors) return [];

  return [
    ...records(contributors['person_name']).flatMap(parsePersonName),
    ...records(contributors['organization']).flatMap(parseOrganization)
  ];
}

function parsePersonName(person: Record<string, unknown>): readonly CrossrefUnixrefCreator[] {
  const givenName = textValue(person['given_name']);
  const familyName = textValue(person['surname']);
  const name = [familyName, givenName].filter((part): part is string => Boolean(part)).join(', ');
  if (!name) return [];

  return [{
    type: 'personal',
    name,
    creatorType: crossrefContributorRole(textValue(person['@_contributor_role']) ?? undefined),
    ...(givenName ? { givenName } : {}),
    ...(familyName ? { familyName } : {})
  }];
}

function parseOrganization(organization: Record<string, unknown>): readonly CrossrefUnixrefCreator[] {
  const name = elementText(organization);
  if (!name) return [];

  return [{
    type: 'organizational',
    name,
    creatorType: crossrefContributorRole(textValue(organization['@_contributor_role']) ?? undefined)
  }];
}

export function parseCrossrefRestRelations(body: string): readonly CrossrefRestRelation[] {
  const document = asRecord(JSON.parse(body)) ?? {};
  const message = asRecord(document['message']);
  const relation = asRecord(message?.['relation']);
  if (!relation) return [];

  const relations: CrossrefRestRelation[] = [];
  for (const [type, rawEntries] of Object.entries(relation)) {
    for (const entry of records(rawEntries)) {
      relations.push({
        type,
        ...optionalString('idType', entry['id-type']),
        ...optionalString('id', entry['id'])
      });
    }
  }
  return relations;
}

export function parseCrossrefRestWorkJson(value: unknown): CrossrefRestWork | null {
  const document = asRecord(value);
  const message = asRecord(document?.['message']);
  if (!message) return null;

  const relation = asRecord(message['relation']);
  const raw = asJsonObject(toJsonValue(message));
  if (!raw) return null;
  const resourceUrl = crossrefRestResourceUrl(message);

  return {
    ...optionalString('doi', message['DOI']),
    ...(resourceUrl ? { resourceUrl } : {}),
    ...optionalString('type', message['type']),
    ...(stringArray(message['title']).length > 0 ? { title: stringArray(message['title']) } : {}),
    relations: relation ? parseCrossrefRestRelationsFromRecord(relation) : [],
    raw
  };
}

function crossrefRestResourceUrl(message: Record<string, unknown>): string | undefined {
  const resource = asRecord(message['resource']);
  const primary = asRecord(resource?.['primary']);
  return textValue(primary?.['URL']) ?? textValue(message['URL']) ?? undefined;
}

function parseCrossrefRestRelationsFromRecord(relation: Record<string, unknown>): readonly CrossrefRestRelation[] {
  const relations: CrossrefRestRelation[] = [];
  for (const [type, rawEntries] of Object.entries(relation)) {
    for (const entry of records(rawEntries)) {
      relations.push({
        type,
        ...optionalString('idType', entry['id-type']),
        ...optionalString('id', entry['id'])
      });
    }
  }
  return relations;
}

function parseRelations(metadata: Record<string, unknown>): readonly CrossrefUnixrefRelation[] {
  const relations: CrossrefUnixrefRelation[] = [];
  for (const program of records(metadata['program'])) {
    for (const relatedItem of records(program['related_item'])) {
      const description = textValue(relatedItem['description']);
      for (const relationElement of [
        ...records(relatedItem['inter_work_relation']),
        ...records(relatedItem['intra_work_relation'])
      ]) {
        const relation: CrossrefUnixrefRelation = {
          ...optionalString('type', relationElement['@_relationship-type']),
          ...optionalString('identifierType', relationElement['@_identifier-type']),
          ...optionalString('identifier', elementText(relationElement)),
          ...(description ? { description } : {})
        };
        relations.push(relation);
      }
    }
  }
  return relations;
}

function resolveStatus(input: {
  readonly recordCount: number;
  readonly successCount: number | null;
  readonly failureCount: number;
}): CrossrefDiagnosticStatus {
  if (input.failureCount > 0) return 'failed';
  if (input.successCount !== null && input.successCount === input.recordCount) return 'success';
  return 'pending';
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => {
    const record = asRecord(entry);
    return record ? [record] : [];
  });
  const record = asRecord(value);
  return record ? [record] : [];
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = textValue(entry);
    return text ? [text] : [];
  });
}

function elementText(value: unknown): string | null {
  return textValue(value) ?? textValue(asRecord(value)?.['#text']);
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalString<Key extends string>(key: Key, value: unknown): { readonly [Property in Key]?: string } {
  const text = textValue(value);
  return text ? { [key]: text } as { readonly [Property in Key]?: string } : {};
}

function formatDateParts(year: string, month: string | null, day: string | null): string {
  return [
    year,
    month ? month.padStart(2, '0') : null,
    day ? day.padStart(2, '0') : null
  ].filter((part): part is string => Boolean(part)).join('-');
}
