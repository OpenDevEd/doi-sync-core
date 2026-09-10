import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces.js';

import type { PublicationCreator } from '../publication/record.js';
import { crossrefContributorRole } from './contributors.js';
import type { CrossrefMappedRecord, CrossrefPages } from './record-mapper.js';

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
	readonly record: CrossrefMappedRecord;
	readonly relation?: CrossrefDepositRelation;
}

const XML_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const ORCID_PATTERN = /^(?:https?:\/\/orcid\.org\/)?([0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[X0-9])$/i;

export function buildCrossrefPublicationXml(input: CrossrefXmlInput): string {
	const doc = create().dec({ version: '1.0', encoding: 'UTF-8' });
	const root = doc.ele('doi_batch', {
		version: '5.5.0',
		xmlns: 'http://www.crossref.org/schema/5.5.0',
		'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
		'xmlns:jats': 'http://www.ncbi.nlm.nih.gov/JATS1',
		'xmlns:rel': 'http://www.crossref.org/relations.xsd',
		'xsi:schemaLocation': 'http://www.crossref.org/schema/5.5.0 https://www.crossref.org/schemas/crossref5.5.0.xsd'
	});

	const head = root.ele('head');
	appendTextElement(head, 'doi_batch_id', input.batchId);
	appendTextElement(head, 'timestamp', input.timestamp);
	const depositor = head.ele('depositor');
	appendTextElement(depositor, 'depositor_name', input.depositorName);
	appendTextElement(depositor, 'email_address', input.emailAddress);
	appendTextElement(head, 'registrant', input.registrant);

	appendMappedRecord(root.ele('body'), input.record, input.relation);
	return doc.end({ prettyPrint: false });
}

function appendMappedRecord(
	body: XMLBuilder,
	record: CrossrefMappedRecord,
	relation: CrossrefDepositRelation | undefined
): void {
	switch (record.kind) {
		case 'journal-article':
			appendJournalArticle(body, record, relation);
			return;
		case 'book':
			appendBook(body, record, relation);
			return;
		case 'book-component':
			appendBookComponent(body, record, relation);
			return;
		case 'conference-paper':
			appendConferencePaper(body, record, relation);
			return;
		case 'dissertation':
			appendDissertation(body, record, relation);
			return;
		case 'report':
			appendReport(body, record, relation);
			return;
		case 'standard':
			appendStandard(body, record, relation);
			return;
		case 'dataset':
			appendDataset(body, record, relation);
			return;
		case 'posted-content':
			appendPostedContent(body, record, relation);
	}
}

function appendJournalArticle(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'journal-article' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const journal = body.ele('journal');
	const journalMetadata = journal.ele('journal_metadata');
	appendTextElement(journalMetadata, 'full_title', record.journalTitle);
	record.issns.forEach((issn) => appendTextElement(journalMetadata, 'issn', issn));
	if (record.volume || record.issue) {
		const journalIssue = journal.ele('journal_issue');
		appendDate(journalIssue, 'publication_date', record.metadata.publicationDate);
		if (record.volume) appendTextElement(journalIssue.ele('journal_volume'), 'volume', record.volume);
		if (record.issue) appendTextElement(journalIssue, 'issue', record.issue);
	}
	const article = journal.ele('journal_article', languageAttributes(record.metadata.language));
	appendTitles(article, record.metadata.title);
	appendContributors(article, record.metadata.creators);
	appendAbstract(article, record.metadata.abstract, record.metadata.language);
	appendDate(article, 'publication_date', record.metadata.publicationDate);
	appendPages(article, record.pages);
	appendRelation(article, relation);
	appendDoiData(article, record.metadata.doi, record.landingUrl);
}

function appendBook(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'book' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const metadata = body.ele('book', { book_type: 'monograph' }).ele(
		'book_metadata',
		languageAttributes(record.metadata.language)
	);
	appendContributors(metadata, record.metadata.creators);
	appendTitles(metadata, record.metadata.title);
	appendAbstract(metadata, record.metadata.abstract, record.metadata.language);
	if (record.edition) appendTextElement(metadata, 'edition_number', record.edition);
	appendDate(metadata, 'publication_date', record.metadata.publicationDate);
	appendIsbnChoice(metadata, record.isbns);
	appendPublisher(metadata, record.publisher);
	appendRelation(metadata, relation);
	appendDoiData(metadata, record.metadata.doi, record.landingUrl);
}

function appendBookComponent(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'book-component' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const bookType = record.componentType === 'reference_entry' ? 'reference' : 'edited_book';
	const book = body.ele('book', { book_type: bookType });
	const bookMetadata = book.ele('book_metadata', languageAttributes(record.metadata.language));
	appendTitles(bookMetadata, record.bookTitle);
	if (record.edition) appendTextElement(bookMetadata, 'edition_number', record.edition);
	appendDate(bookMetadata, 'publication_date', record.metadata.publicationDate);
	appendIsbnChoice(bookMetadata, record.isbns);
	appendPublisher(bookMetadata, record.publisher);

	const item = book.ele('content_item', {
		component_type: record.componentType,
		...languageAttributes(record.metadata.language)
	});
	appendContributors(item, record.metadata.creators);
	appendTitles(item, record.metadata.title);
	appendAbstract(item, record.metadata.abstract, record.metadata.language);
	if (record.componentNumber) appendTextElement(item, 'component_number', record.componentNumber);
	appendDate(item, 'publication_date', record.metadata.publicationDate);
	appendPages(item, record.pages);
	appendRelation(item, relation);
	appendDoiData(item, record.metadata.doi, record.landingUrl);
}

function appendConferencePaper(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'conference-paper' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const conference = body.ele('conference');
	const eventMetadata = conference.ele('event_metadata');
	appendTextElement(eventMetadata, 'conference_name', record.conferenceName);
	if (record.conferenceAcronym) appendTextElement(eventMetadata, 'conference_acronym', record.conferenceAcronym);
	if (record.conferenceLocation) appendTextElement(eventMetadata, 'conference_location', record.conferenceLocation);
	if (record.conferenceDate) appendTextElement(eventMetadata, 'conference_date', record.conferenceDate);
	const proceedings = conference.ele('proceedings_metadata', languageAttributes(record.metadata.language));
	appendTextElement(proceedings, 'proceedings_title', record.proceedingsTitle);
	appendPublisher(proceedings, record.publisher);
	appendDate(proceedings, 'publication_date', record.metadata.publicationDate);
	appendIsbnChoice(proceedings, record.isbns);

	const paper = conference.ele('conference_paper', languageAttributes(record.metadata.language));
	appendContributors(paper, record.metadata.creators);
	appendTitles(paper, record.metadata.title);
	appendAbstract(paper, record.metadata.abstract, record.metadata.language);
	appendDate(paper, 'publication_date', record.metadata.publicationDate);
	appendPages(paper, record.pages);
	appendRelation(paper, relation);
	appendDoiData(paper, record.metadata.doi, record.landingUrl);
}

function appendDissertation(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'dissertation' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const dissertation = body.ele('dissertation', languageAttributes(record.metadata.language));
	appendContributors(dissertation, record.metadata.creators, true);
	appendTitles(dissertation, record.metadata.title);
	appendAbstract(dissertation, record.metadata.abstract, record.metadata.language);
	appendDate(dissertation, 'approval_date', record.metadata.publicationDate);
	appendInstitution(dissertation, record.institution);
	if (record.degree) appendTextElement(dissertation, 'degree', record.degree);
	record.isbns.forEach((isbn) => appendTextElement(dissertation, 'isbn', isbn));
	appendRelation(dissertation, relation);
	appendDoiData(dissertation, record.metadata.doi, record.landingUrl);
}

function appendReport(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'report' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const metadata = body.ele('report-paper').ele(
		'report-paper_metadata',
		languageAttributes(record.metadata.language)
	);
	appendContributors(metadata, record.metadata.creators);
	appendTitles(metadata, record.metadata.title);
	if (record.edition) appendTextElement(metadata, 'edition_number', record.edition);
	appendAbstract(metadata, record.metadata.abstract, record.metadata.language);
	appendDate(metadata, 'publication_date', record.metadata.publicationDate);
	record.isbns.forEach((isbn) => appendTextElement(metadata, 'isbn', isbn));
	if (record.publisher) appendPublisher(metadata, record.publisher);
	if (record.institution) appendInstitution(metadata, record.institution);
	appendPublisherItem(metadata, record.itemNumber);
	appendRelation(metadata, relation);
	appendDoiData(metadata, record.metadata.doi, record.landingUrl);
}

function appendStandard(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'standard' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const metadata = body.ele('standard').ele(
		'standard_metadata',
		languageAttributes(record.metadata.language)
	);
	appendContributors(metadata, record.metadata.creators);
	appendTitles(metadata, record.metadata.title);
	appendAbstract(metadata, record.metadata.abstract, record.metadata.language);
	appendTextElement(metadata.ele('designators').ele('std_as_published'), 'std_designator', record.designator);
	if (record.edition) appendTextElement(metadata, 'edition_number', record.edition);
	appendDate(metadata, 'approval_date', record.metadata.publicationDate);
	record.isbns.forEach((isbn) => appendTextElement(metadata, 'isbn', isbn));
	if (record.publisher) appendPublisher(metadata, record.publisher);
	const bodyElement = metadata.ele('standards_body');
	appendTextElement(bodyElement, 'standards_body_name', record.standardsBody);
	appendTextElement(bodyElement, 'standards_body_acronym', record.standardsBodyAcronym);
	appendRelation(metadata, relation);
	appendDoiData(metadata, record.metadata.doi, record.landingUrl);
}

function appendDataset(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'dataset' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const database = body.ele('database');
	const databaseMetadata = database.ele('database_metadata', languageAttributes(record.metadata.language));
	appendTitles(databaseMetadata, record.databaseTitle);
	if (record.publisher) appendPublisher(databaseMetadata, record.publisher);
	if (record.institution) appendInstitution(databaseMetadata, record.institution);

	const dataset = database.ele('dataset', { dataset_type: 'record' });
	appendContributors(dataset, record.metadata.creators);
	appendTitles(dataset, record.metadata.title);
	const databaseDate = dataset.ele('database_date');
	appendDate(databaseDate, 'publication_date', record.metadata.publicationDate);
	if (record.metadata.abstract) appendTextElement(dataset, 'description', record.metadata.abstract);
	appendRelation(dataset, relation);
	appendVersionInfo(dataset, record.version);
	appendDoiData(dataset, record.metadata.doi, record.landingUrl);
}

function appendPostedContent(
	body: XMLBuilder,
	record: Extract<CrossrefMappedRecord, { readonly kind: 'posted-content' }>,
	relation: CrossrefDepositRelation | undefined
): void {
	const posted = body.ele('posted_content', {
		type: record.postedContentType,
		...languageAttributes(record.metadata.language)
	});
	appendTextElement(posted, 'group_title', record.hostingIdentity);
	appendContributors(posted, record.metadata.creators);
	appendTitles(posted, record.metadata.title);
	appendDate(posted, 'posted_date', record.metadata.publicationDate);
	appendInstitution(posted, record.hostingIdentity);
	if (record.itemNumber) appendTextElement(posted, 'item_number', record.itemNumber);
	appendAbstract(posted, record.metadata.abstract, record.metadata.language);
	appendRelation(posted, relation);
	appendDoiData(posted, record.metadata.doi, record.landingUrl);
}

function appendTitles(parent: XMLBuilder, title: string): void {
	appendTextElement(parent.ele('titles'), 'title', title);
}

function appendAbstract(parent: XMLBuilder, abstract: string | undefined, language: string | undefined): void {
	if (!abstract) return;
	parent
		.ele('jats:abstract', { 'xml:lang': crossrefXmlLanguage(language) })
		.ele('jats:p')
		.txt(sanitizeXmlText(abstract));
}

function appendDate(parent: XMLBuilder, elementName: string, date: string): void {
	const parts = splitDate(date);
	const element = parent.ele(elementName, { media_type: 'online' });
	if (parts.month) appendTextElement(element, 'month', parts.month);
	if (parts.day) appendTextElement(element, 'day', parts.day);
	appendTextElement(element, 'year', parts.year);
}

function appendPublisher(parent: XMLBuilder, publisher: string): void {
	appendTextElement(parent.ele('publisher'), 'publisher_name', publisher);
}

function appendInstitution(parent: XMLBuilder, institution: string): void {
	appendTextElement(parent.ele('institution'), 'institution_name', institution);
}

function appendIsbnChoice(parent: XMLBuilder, isbns: readonly string[]): void {
	if (isbns.length === 0) {
		parent.ele('noisbn', { reason: 'archive_volume' });
		return;
	}
	isbns.forEach((isbn) => appendTextElement(parent, 'isbn', isbn));
}

function appendPages(parent: XMLBuilder, pages: CrossrefPages | undefined): void {
	if (!pages) return;
	const element = parent.ele('pages');
	appendTextElement(element, 'first_page', pages.first);
	if (pages.last) appendTextElement(element, 'last_page', pages.last);
}

function appendPublisherItem(parent: XMLBuilder, itemNumber: string | undefined): void {
	if (!itemNumber) return;
	appendTextElement(parent.ele('publisher_item'), 'item_number', itemNumber);
}

function appendVersionInfo(parent: XMLBuilder, version: string | undefined): void {
	if (!version) return;
	appendTextElement(parent.ele('version_info'), 'version', version);
}

function appendDoiData(parent: XMLBuilder, doi: string, resourceUrl: string): void {
	const doiData = parent.ele('doi_data');
	appendTextElement(doiData, 'doi', doi);
	appendTextElement(doiData, 'resource', normalizeResourceUrl(resourceUrl));
}

function appendContributors(
	parent: XMLBuilder,
	creators: readonly PublicationCreator[],
	required = false
): void {
	if (creators.length === 0) {
		if (required) throw new Error('Crossref requires at least one dissertation contributor');
		return;
	}

	const contributors = parent.ele('contributors');
	creators.forEach((creator, index) => {
		const attributes = {
			contributor_role: crossrefContributorRole(creator.creatorType),
			sequence: index === 0 ? 'first' : 'additional'
		};
		if (creator.type === 'personal') {
			const person = contributors.ele('person_name', attributes);
			if (creator.givenName) appendTextElement(person, 'given_name', creator.givenName);
			appendTextElement(person, 'surname', creator.familyName ?? creator.name);
			if (creator.affiliation) {
				appendInstitution(person.ele('affiliations'), creator.affiliation);
			}
			const orcid = normalizeOrcid(creator.orcid);
			if (orcid) appendTextElement(person, 'ORCID', orcid);
			return;
		}

		contributors.ele('organization', attributes).txt(sanitizeXmlText(creator.name));
	});
}

function appendRelation(parent: XMLBuilder, relation: CrossrefDepositRelation | undefined): void {
	if (!relation) return;
	if (relation === 'delete-all') {
		parent.ele('rel:program');
		return;
	}
	const relatedItem = parent.ele('rel:program').ele('rel:related_item');
	if (relation.description) appendTextElement(relatedItem, 'rel:description', relation.description);
	relatedItem
		.ele('rel:inter_work_relation', {
			'relationship-type': relation.type,
			'identifier-type': relation.identifierType
		})
		.txt(sanitizeXmlText(relation.identifier));
}

function splitDate(date: string): { readonly year: string; readonly month?: string; readonly day?: string } {
	const [year, month, day] = date.split('-');
	if (!year) throw new Error(`Invalid publication date: ${date}`);
	return { year, ...(month ? { month } : {}), ...(day ? { day } : {}) };
}

function normalizeResourceUrl(value: string): string {
	const sanitized = sanitizeXmlText(value);
	return /^https?:\/\//i.test(sanitized) ? sanitized : `https://${sanitized}`;
}

function normalizeOrcid(value: string | undefined): string | undefined {
	const match = value?.trim().match(ORCID_PATTERN);
	return match?.[1] ? `https://orcid.org/${match[1].toUpperCase()}` : undefined;
}

function languageAttributes(value: string | undefined): { readonly language?: string } {
	const normalized = sanitizeXmlText(value ?? '').trim();
	return XML_LANGUAGE_PATTERN.test(normalized) ? { language: normalized } : {};
}

function crossrefXmlLanguage(value: string | undefined): string {
	return languageAttributes(value).language ?? 'en';
}

function appendTextElement(parent: XMLBuilder, name: string, value: string): XMLBuilder {
	return parent.ele(name).txt(sanitizeXmlText(value));
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
