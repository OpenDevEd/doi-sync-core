import { XMLParser } from 'fast-xml-parser';
import { asRecord } from '../guards.js';
import { asJsonObject, toJsonValue, type JsonObject } from '../json.js';
import { crossrefContributorRole } from './contributors.js';
import type { CrossrefMappedRecord, CrossrefPages } from './record-mapper.js';

export type CrossrefDiagnosticStatus = 'success' | 'failed' | 'pending';

export interface CrossrefDiagnosticResult {
  readonly status: CrossrefDiagnosticStatus;
  readonly batchStatus?: string;
  readonly recordCount: number;
  readonly successCount: number | null;
  readonly failureCount: number;
}

export interface CrossrefUnixrefRecord {
  readonly kind?: CrossrefMappedRecord['kind'];
  readonly doi?: string;
  readonly title?: string;
  readonly abstract?: string;
  readonly abstractLanguage?: string;
  readonly language?: string;
  readonly publicationDate?: string;
  readonly publisher?: string;
  readonly institution?: string;
  readonly containerTitle?: string;
  readonly componentType?: string;
  readonly postedContentType?: string;
  readonly issns?: readonly string[];
  readonly isbns?: readonly string[];
  readonly volume?: string;
  readonly issue?: string;
  readonly pages?: CrossrefPages;
  readonly edition?: string;
  readonly componentNumber?: string;
  readonly conferenceAcronym?: string;
  readonly conferenceName?: string;
  readonly conferenceLocation?: string;
  readonly conferenceDate?: string;
  readonly degree?: string;
  readonly itemNumber?: string;
  readonly version?: string;
  readonly standardsBodyAcronym?: string;
  readonly designator?: string;
  readonly groupTitle?: string;
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
  readonly affiliation?: string;
  readonly orcid?: string;
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
  const container = crossref ? findPublicationContainer(crossref) : null;
  if (!container) return null;
  const { metadata } = container;

  const publicationDate = publicationDateRecord(metadata);
  const doiData = asRecord(metadata['doi_data']);
  const title = textValue(asRecord(metadata['titles'])?.['title']);
  const abstract = abstractMetadata(metadata) ?? (
    container.kind === 'dataset' && textValue(metadata['description'])
      ? { text: textValue(metadata['description']) as string }
      : null
  );
  const language = textValue(metadata['@_language']) ?? container.language;
  const year = textValue(publicationDate?.['year']);
  const month = textValue(publicationDate?.['month']);
  const day = textValue(publicationDate?.['day']);
  const publisher = container.publisher;
  const institution = container.institution;
  const creators = parseCreators(metadata);
  const relations = parseRelations(metadata);

  return {
    kind: container.kind,
    ...optionalString('doi', doiData?.['doi']),
    ...(title ? { title } : {}),
    ...(abstract?.text ? { abstract: abstract.text } : {}),
    ...(abstract?.language ? { abstractLanguage: abstract.language } : {}),
    ...(language ? { language } : {}),
    ...(year ? { publicationDate: formatDateParts(year, month, day) } : {}),
    ...(publisher ? { publisher } : {}),
    ...(institution ? { institution } : {}),
    ...(container.containerTitle ? { containerTitle: container.containerTitle } : {}),
    ...(container.componentType ? { componentType: container.componentType } : {}),
    ...(container.postedContentType ? { postedContentType: container.postedContentType } : {}),
    ...(container.issns ? { issns: container.issns } : {}),
    ...(container.isbns ? { isbns: container.isbns } : {}),
    ...copyOptionalDetails(container),
    ...(creators.length > 0 ? { creators } : {}),
    ...optionalString('resourceUrl', doiData?.['resource']),
    ...optionalString('depositTimestamp', doiRecord?.['@_timestamp']),
    ...(relations.length > 0 ? { relations } : {})
  };
}

function publicationDateRecord(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const databaseDate = asRecord(metadata['database_date']);
  return asRecord(metadata['publication_date'])
    ?? asRecord(metadata['approval_date'])
    ?? asRecord(metadata['posted_date'])
    ?? asRecord(databaseDate?.['publication_date']);
}

interface CrossrefPublicationContainer {
  readonly kind: NonNullable<CrossrefUnixrefRecord['kind']>;
  readonly metadata: Record<string, unknown>;
  readonly containerTitle?: string;
  readonly componentType?: string;
  readonly postedContentType?: string;
  readonly publisher?: string;
  readonly institution?: string;
  readonly issns?: readonly string[];
  readonly isbns?: readonly string[];
  readonly volume?: string;
  readonly issue?: string;
  readonly pages?: CrossrefPages;
  readonly edition?: string;
  readonly componentNumber?: string;
  readonly conferenceAcronym?: string;
  readonly conferenceName?: string;
  readonly conferenceLocation?: string;
  readonly conferenceDate?: string;
  readonly degree?: string;
  readonly itemNumber?: string;
  readonly version?: string;
  readonly standardsBodyAcronym?: string;
  readonly designator?: string;
  readonly language?: string;
  readonly groupTitle?: string;
}

function findPublicationContainer(crossref: Record<string, unknown>): CrossrefPublicationContainer | null {
  const journal = firstRecord(crossref['journal']);
  const journalArticle = firstRecord(journal?.['journal_article']);
  if (journalArticle) {
    const journalMetadata = asRecord(journal?.['journal_metadata']);
    const journalIssue = asRecord(journal?.['journal_issue']);
    return {
      kind: 'journal-article',
      metadata: journalArticle,
      ...optionalContainerTitle(journalMetadata?.['full_title']),
      ...optionalTextValues('issns', journalMetadata?.['issn']),
      ...optionalString('volume', asRecord(journalIssue?.['journal_volume'])?.['volume']),
      ...optionalString('issue', journalIssue?.['issue']),
      ...optionalPages(journalArticle)
    };
  }

  const book = firstRecord(crossref['book']);
  const bookMetadata = asRecord(book?.['book_metadata']);
  const contentItem = firstRecord(book?.['content_item']);
  if (contentItem) {
    return {
      kind: 'book-component',
      metadata: contentItem,
      ...optionalContainerTitle(bookMetadata?.['titles']),
      ...optionalPublisher(bookMetadata),
      ...optionalString('componentType', contentItem['@_component_type']),
      ...optionalTextValues('isbns', bookMetadata?.['isbn']),
      ...optionalString('edition', bookMetadata?.['edition_number']),
      ...optionalString('componentNumber', contentItem['component_number']),
      ...optionalPages(contentItem)
    };
  }
  if (bookMetadata) {
    return {
      kind: 'book', metadata: bookMetadata, ...optionalPublisher(bookMetadata),
      ...optionalTextValues('isbns', bookMetadata['isbn']),
      ...optionalString('edition', bookMetadata['edition_number'])
    };
  }

  const conference = firstRecord(crossref['conference']);
  const proceedingsMetadata = asRecord(conference?.['proceedings_metadata']);
  const conferencePaper = firstRecord(conference?.['conference_paper']);
  if (conferencePaper) {
    return {
      kind: 'conference-paper',
      metadata: conferencePaper,
      ...optionalContainerTitle(proceedingsMetadata?.['proceedings_title']),
      ...optionalPublisher(proceedingsMetadata),
      ...optionalTextValues('isbns', proceedingsMetadata?.['isbn']),
      ...optionalString('conferenceName', asRecord(conference?.['event_metadata'])?.['conference_name']),
      ...optionalString('conferenceAcronym', asRecord(conference?.['event_metadata'])?.['conference_acronym']),
      ...optionalString('conferenceLocation', asRecord(conference?.['event_metadata'])?.['conference_location']),
      ...optionalString('conferenceDate', asRecord(conference?.['event_metadata'])?.['conference_date']),
      ...optionalPages(conferencePaper)
    };
  }

  const dissertation = firstRecord(crossref['dissertation']);
  if (dissertation) {
    return {
      kind: 'dissertation', metadata: dissertation, ...optionalInstitution(dissertation),
      ...optionalTextValues('isbns', dissertation['isbn']),
      ...optionalString('degree', dissertation['degree'])
    };
  }
  const report = firstRecord(crossref['report-paper']);
  const reportMetadata = asRecord(report?.['report-paper_metadata']);
  if (reportMetadata) {
    return {
      kind: 'report', metadata: reportMetadata,
      ...optionalPublisher(reportMetadata), ...optionalInstitution(reportMetadata),
      ...optionalTextValues('isbns', reportMetadata['isbn']),
      ...optionalString('edition', reportMetadata['edition_number']),
      ...optionalItemNumber(reportMetadata)
    };
  }
  const standard = firstRecord(crossref['standard']);
  const standardMetadata = asRecord(standard?.['standard_metadata']);
  if (standardMetadata) {
    const standardsBody = asRecord(standardMetadata['standards_body']);
    return {
      kind: 'standard', metadata: standardMetadata,
      ...optionalString('institution', standardsBody?.['standards_body_name']),
      ...optionalString('standardsBodyAcronym', standardsBody?.['standards_body_acronym']),
      ...optionalString('designator', asRecord(asRecord(standardMetadata['designators'])?.['std_as_published'])?.['std_designator']),
      ...optionalPublisher(standardMetadata),
      ...optionalTextValues('isbns', standardMetadata['isbn']),
      ...optionalString('edition', standardMetadata['edition_number'])
    };
  }
  const database = firstRecord(crossref['database']);
  const databaseMetadata = asRecord(database?.['database_metadata']);
  const dataset = firstRecord(database?.['dataset']);
  if (dataset) {
    return {
      kind: 'dataset',
      metadata: dataset,
      ...optionalContainerTitle(databaseMetadata?.['titles']),
      ...optionalPublisher(databaseMetadata),
      ...optionalInstitution(databaseMetadata),
      ...optionalString('language', databaseMetadata?.['@_language']),
      ...optionalVersion(dataset)
    };
  }
  const postedContent = firstRecord(crossref['posted_content']);
  if (postedContent) {
    return {
      kind: 'posted-content',
      metadata: postedContent,
      ...optionalInstitution(postedContent),
      ...optionalString('groupTitle', postedContent['group_title']),
      ...optionalItemNumber(postedContent),
      ...optionalString('postedContentType', postedContent['@_type'])
    };
  }
  return null;
}

function copyOptionalDetails(container: CrossrefPublicationContainer): Partial<CrossrefUnixrefRecord> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'volume', 'issue', 'pages', 'edition', 'componentNumber', 'conferenceName', 'conferenceAcronym',
    'conferenceLocation', 'conferenceDate', 'degree', 'itemNumber', 'version',
    'standardsBodyAcronym', 'designator', 'groupTitle'
  ] as const) {
    const value = container[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function textValues(value: unknown): readonly string[] {
  return recordsOrValues(value).flatMap((entry) => {
    const text = elementText(entry);
    return text ? [text] : [];
  });
}

function optionalTextValues<Key extends 'issns' | 'isbns'>(
  key: Key,
  value: unknown
): Partial<Readonly<Record<Key, readonly string[]>>> {
  const values = textValues(value);
  return values.length > 0 ? { [key]: values } as Readonly<Record<Key, readonly string[]>> : {};
}

function recordsOrValues(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function optionalPages(metadata: Record<string, unknown>): { readonly pages?: CrossrefPages } {
  const pages = asRecord(metadata['pages']);
  const first = textValue(pages?.['first_page']);
  const last = textValue(pages?.['last_page']);
  return first ? { pages: { first, ...(last ? { last } : {}) } } : {};
}

function optionalItemNumber(metadata: Record<string, unknown>): { readonly itemNumber?: string } {
  return optionalString('itemNumber', asRecord(metadata['publisher_item'])?.['item_number']);
}

function optionalVersion(metadata: Record<string, unknown>): { readonly version?: string } {
  return optionalString('version', asRecord(metadata['version_info'])?.['version']);
}

function optionalPublisher(metadata: Record<string, unknown> | null): { readonly publisher?: string } {
  const publisher = textValue(asRecord(metadata?.['publisher'])?.['publisher_name']);
  return publisher ? { publisher } : {};
}

function optionalInstitution(metadata: Record<string, unknown> | null): { readonly institution?: string } {
  const institution = textValue(asRecord(metadata?.['institution'])?.['institution_name']);
  return institution ? { institution } : {};
}

function optionalContainerTitle(value: unknown): { readonly containerTitle?: string } {
  const title = textValue(asRecord(value)?.['title']) ?? textValue(value);
  return title ? { containerTitle: title } : {};
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
  const affiliation = textValue(
    asRecord(asRecord(person['affiliations'])?.['institution'])?.['institution_name']
  );
  const orcid = textValue(person['ORCID']);
  if (!name) return [];

  return [{
    type: 'personal',
    name,
    creatorType: crossrefContributorRole(textValue(person['@_contributor_role']) ?? undefined),
    ...(givenName ? { givenName } : {}),
    ...(familyName ? { familyName } : {}),
    ...(affiliation ? { affiliation } : {}),
    ...(orcid ? { orcid } : {})
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
  for (const program of [...records(metadata['program']), ...records(metadata['rel:program'])]) {
    for (const relatedItem of [...records(program['related_item']), ...records(program['rel:related_item'])]) {
      const description = textValue(relatedItem['description']);
      for (const relationElement of [
        ...records(relatedItem['inter_work_relation']),
        ...records(relatedItem['intra_work_relation']),
        ...records(relatedItem['rel:inter_work_relation']),
        ...records(relatedItem['rel:intra_work_relation'])
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
