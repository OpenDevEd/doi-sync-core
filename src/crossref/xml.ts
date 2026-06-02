import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';
import type { CanonicalMetadataSnapshot } from '../metadata.js';
import { crossrefContributorRole } from './contributors.js';

export type CrossrefRelationType = 'isSupplementedBy' | 'references' | 'hasVersion' | 'isRelatedMaterial';
export type CrossrefIdentifierType = 'doi' | 'uri' | 'ark' | 'handle' | 'uuid' | 'other';

export interface CrossrefRelation {
  readonly type: CrossrefRelationType;
  readonly identifierType: CrossrefIdentifierType;
  readonly identifier: string;
  readonly description?: string;
}

export type CrossrefDepositRelation = CrossrefRelation | 'delete-all';

export interface CrossrefXmlInput {
  readonly batchId: string;
  readonly timestamp: string;
  readonly depositorName: string;
  readonly emailAddress: string;
  readonly registrant: string;
  readonly metadata: CanonicalMetadataSnapshot;
  readonly resourceUrl: string;
  readonly relation?: CrossrefDepositRelation;
}

const XML_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const CROSSREF_REPORT_PAPER_WORK_TYPE = 'report';
const CROSSREF_REPORT_PAPER_ELEMENT = 'report-paper';

export function buildCrossrefReportPaperXml(input: CrossrefXmlInput): string {
  const publicationDate = splitDate(input.metadata.publicationDate);
  const doc = create()
    .dec({ version: '1.0', encoding: 'UTF-8' });
  const root = doc.ele('doi_batch', {
    version: '5.4.0',
    xmlns: 'http://www.crossref.org/schema/5.4.0',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xmlns:jats': 'http://www.ncbi.nlm.nih.gov/JATS1',
    'xsi:schemaLocation': 'http://www.crossref.org/schema/5.4.0 http://www.crossref.org/schema/deposit/crossref5.4.0.xsd'
  });

  const head = root.ele('head');
  appendTextElement(head, 'doi_batch_id', input.batchId);
  appendTextElement(head, 'timestamp', input.timestamp);
  const depositor = head.ele('depositor');
  appendTextElement(depositor, 'depositor_name', input.depositorName);
  appendTextElement(depositor, 'email_address', input.emailAddress);
  appendTextElement(head, 'registrant', input.registrant);

  const reportPaperMetadata = root
    .ele('body')
    .ele(CROSSREF_REPORT_PAPER_ELEMENT)
    .ele('report-paper_metadata');

  appendContributors(reportPaperMetadata, input.metadata.creators);

  const titles = reportPaperMetadata.ele('titles');
  appendTextElement(titles, 'title', input.metadata.title);

  if (input.metadata.abstract) {
    reportPaperMetadata
      .ele('jats:abstract', { 'xml:lang': crossrefXmlLanguage(input.metadata.language) })
      .ele('jats:p')
      .txt(sanitizeXmlText(input.metadata.abstract));
  }

  const publication = reportPaperMetadata.ele('publication_date', { media_type: 'online' });
  if (publicationDate.month) appendTextElement(publication, 'month', publicationDate.month);
  if (publicationDate.day) appendTextElement(publication, 'day', publicationDate.day);
  appendTextElement(publication, 'year', publicationDate.year);

  if (input.metadata.publisher) {
    appendTextElement(reportPaperMetadata.ele('publisher'), 'publisher_name', input.metadata.publisher);
    appendTextElement(reportPaperMetadata.ele('institution'), 'institution_name', input.metadata.publisher);
  }

  if (input.relation === 'delete-all') appendBlankRelationshipProgram(reportPaperMetadata);
  else if (input.relation) appendRelation(reportPaperMetadata, input.relation);

  const doiData = reportPaperMetadata.ele('doi_data');
  appendTextElement(doiData, 'doi', input.metadata.doi);
  appendTextElement(doiData, 'resource', normalizeResourceUrl(input.resourceUrl));

  return doc.end({ prettyPrint: false });
}

function splitDate(date: string): { readonly year: string; readonly month?: string; readonly day?: string } {
  const [year, month, day] = date.split('-');
  if (!year) throw new Error(`Invalid publication date: ${date}`);
  return {
    year,
    ...(month ? { month } : {}),
    ...(day ? { day } : {})
  };
}

function normalizeResourceUrl(value: string): string {
  const sanitized = sanitizeXmlText(value);
  return /^https?:\/\//i.test(sanitized) ? sanitized : `https://${sanitized}`;
}

function appendTextElement(parent: XMLBuilder, name: string, value: string): XMLBuilder {
  return parent.ele(name).txt(sanitizeXmlText(value));
}

function appendContributors(parent: XMLBuilder, creators: CanonicalMetadataSnapshot['creators']): void {
  if (creators.length === 0) return;

  const contributors = parent.ele('contributors');
  creators.forEach((creator, index) => {
    const creatorType = crossrefContributorRole(creator.creatorType);
    if (creator.type === 'personal') {
      const person = contributors.ele('person_name', {
        contributor_role: creatorType,
        sequence: index === 0 ? 'first' : 'additional'
      });
      if (creator.givenName) appendTextElement(person, 'given_name', creator.givenName);
      appendTextElement(person, 'surname', creator.familyName ?? creator.name);
      return;
    }

    contributors
      .ele('organization', {
        contributor_role: creatorType,
        sequence: index === 0 ? 'first' : 'additional'
      })
      .txt(sanitizeXmlText(creator.name));
  });
}

function crossrefXmlLanguage(value: string | undefined): string {
  const normalized = sanitizeXmlText(value ?? '').trim();
  return XML_LANGUAGE_PATTERN.test(normalized) ? normalized : 'en';
}

function appendRelation(parent: XMLBuilder, relation: CrossrefRelation): void {
  const relatedItem = parent
    .ele('program', { xmlns: 'http://www.crossref.org/relations.xsd' })
    .ele('related_item');
  if (relation.description) appendTextElement(relatedItem, 'description', relation.description);
  relatedItem
    .ele('inter_work_relation', {
      'relationship-type': relation.type,
      'identifier-type': relation.identifierType
    })
    .txt(sanitizeXmlText(relation.identifier));
}

function appendBlankRelationshipProgram(parent: XMLBuilder): void {
  parent.ele('program', { xmlns: 'http://www.crossref.org/relations.xsd' });
}

function sanitizeXmlText(value: string): string {
  return Array.from(value).filter(isXml10Character).join('');
}

function isXml10Character(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint === 0x9
    || codePoint === 0xA
    || codePoint === 0xD
    || (codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0xD7FF)
    || (codePoint !== undefined && codePoint >= 0xE000 && codePoint <= 0xFFFD)
    || (codePoint !== undefined && codePoint >= 0x10000 && codePoint <= 0x10FFFF);
}
