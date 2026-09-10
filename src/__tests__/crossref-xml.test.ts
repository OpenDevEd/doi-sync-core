import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mapCrossrefRecord, type CrossrefMappedRecord } from '../crossref/record-mapper.js';
import { buildCrossrefPublicationXml } from '../crossref/xml.js';
import type { PublicationRecordSnapshot } from '../publication/record.js';

const schemaPath = fileURLToPath(new URL(
	'./fixtures/crossref-schema-5.5.0/crossref5.5.0.xsd',
	import.meta.url
));

describe('Crossref 5.5 publication XML', () => {
	it.each([
		['JournalArticle', '<journal>'],
		['Book', '<book book_type="monograph">'],
		['BookSection', '<content_item component_type="chapter"'],
		['DictionaryEntry', '<content_item component_type="reference_entry"'],
		['EncyclopediaArticle', '<content_item component_type="reference_entry"'],
		['ConferencePaper', '<conference>'],
		['Thesis', '<dissertation language="en">'],
		['Report', '<report-paper>'],
		['Standard', '<standard>'],
		['Dataset', '<database>'],
		['Preprint', '<posted_content type="preprint"'],
		['BlogPost', '<posted_content type="blog"'],
		['Letter', '<posted_content type="letter"'],
		['Document', '<posted_content type="other"'],
		['Manuscript', '<posted_content type="other"'],
		['Presentation', '<posted_content type="poster"']
	] as const)('builds schema-valid %s XML', (itemType, expectedElement) => {
		const xml = buildCrossrefPublicationXml(xmlInput(mappedRecord(itemType)));

		expect(xml).toContain('<doi_batch version="5.5.0"');
		expect(xml).toContain(expectedElement);
		expect(xml).toContain('<doi>10.53832/opendeved.1205</doi>');
	});

	it('validates every supported family and relation mode against the official XSD 1.1 bundle', () => {
		const itemTypes = [
			'JournalArticle', 'Book', 'BookSection', 'DictionaryEntry', 'EncyclopediaArticle',
			'ConferencePaper', 'Thesis', 'Report', 'Standard', 'Dataset', 'Preprint', 'BlogPost',
			'Letter', 'Document', 'Manuscript', 'Presentation'
		];
		const report = mappedRecord('Report');
		const xmlDocuments = [
			...itemTypes.map((itemType) => buildCrossrefPublicationXml(xmlInput(mappedRecord(itemType)))),
			buildCrossrefPublicationXml(xmlInput(report, {
				type: 'isSupplementedBy', identifierType: 'doi', identifier: '10.5281/zenodo.15043088'
			})),
			buildCrossrefPublicationXml(xmlInput(report, 'delete-all'))
		];

		expect(validateAgainstOfficialSchema(xmlDocuments)).toEqual({ status: 0, stderr: '' });
	}, 90_000);

	it('deposits and explicitly clears relations in the schema relation slot', () => {
		const record = mappedRecord('Report');
		const relatedXml = buildCrossrefPublicationXml(xmlInput(record, {
			type: 'isSupplementedBy',
			identifierType: 'doi',
			identifier: '10.5281/zenodo.15043088',
			description: 'Archived file package'
		}));
		const clearedXml = buildCrossrefPublicationXml(xmlInput(record, 'delete-all'));

		expect(relatedXml).toContain('<rel:related_item>');
		expect(relatedXml).toContain(
			'<rel:inter_work_relation relationship-type="isSupplementedBy" identifier-type="doi">10.5281/zenodo.15043088</rel:inter_work_relation>'
		);
		expect(clearedXml).toContain('<rel:program/>');
		expect(clearedXml).not.toContain('rel:related_item');
	});

	it('sanitizes XML text and emits normalized ORCID and contributor data', () => {
		const record = mappedRecord('Report', {
			title: 'Evidence\u0001 report',
			creators: [{
				type: 'personal', name: 'Lovelace, Ada', givenName: 'Ada', familyName: 'Lovelace',
				affiliation: 'Open\u0002DevEd', orcid: '0000-0002-1825-0097'
			}]
		});
		const xml = buildCrossrefPublicationXml(xmlInput(record));

		expect(xml).not.toContain('\u0001');
		expect(xml).not.toContain('\u0002');
		expect(xml).toContain('<title>Evidence report</title>');
		expect(xml).toContain('<ORCID>https://orcid.org/0000-0002-1825-0097</ORCID>');
	});

	it('serializes distinct report organizations and managed type-specific metadata', () => {
		const record = mappedRecord('Report', {
			publisher: 'Evidence Press', institution: 'OpenDevEd',
			fields: { ISBN: '978-1-4028-9462-6', edition: '2', reportNumber: 'R-42' }
		});
		const xml = buildCrossrefPublicationXml(xmlInput(record));

		expect(xml).toContain('<publisher_name>Evidence Press</publisher_name>');
		expect(xml).toContain('<institution_name>OpenDevEd</institution_name>');
		expect(xml).toContain('<edition_number>2</edition_number>');
		expect(xml).toContain('<isbn>978-1-4028-9462-6</isbn>');
		expect(xml).toContain('<publisher_item><item_number>R-42</item_number></publisher_item>');
	});
});

function xmlInput(record: CrossrefMappedRecord, relation?: Parameters<typeof buildCrossrefPublicationXml>[0]['relation']) {
	return {
		batchId: 'doi-sync-rec-1-abc',
		timestamp: '20260520123001000',
		depositorName: 'OpenDevEd',
		emailAddress: 'doi@example.org',
		registrant: 'Open Development & Education',
		record,
		...(relation ? { relation } : {})
	};
}

function mappedRecord(
	itemType: string,
	overrides: Partial<PublicationRecordSnapshot> = {}
): CrossrefMappedRecord {
	const result = mapCrossrefRecord({
		recordKey: 'ABC12345',
		canonicalRevision: 1,
		itemType,
		title: 'Evidence & impact',
		publicationDate: '2026-05-20',
		abstract: 'Short summary.',
		language: 'en',
		publisher: 'Open Development & Education',
		institution: 'Open Development & Education',
		creators: [{ type: 'personal', name: 'Lovelace, Ada', givenName: 'Ada', familyName: 'Lovelace' }],
		tags: ['evidence'],
		landingUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
		fields: {
			ISSN: '2049-3630',
			ISBN: '978-1-4028-9462-6',
			volume: '12',
			issue: '3',
			pages: '10-24',
			edition: '2',
			publicationTitle: 'Evidence Journal',
			bookTitle: 'Evidence Handbook',
			dictionaryTitle: 'Evidence Dictionary',
			encyclopediaTitle: 'Evidence Encyclopedia',
			conferenceName: 'Evidence Conference',
			conferenceAcronym: 'EC',
			conferenceDate: '20-22 May 2026',
			place: 'London, UK',
			proceedingsTitle: 'Evidence Proceedings',
			number: 'ODE-2026-1',
			reportNumber: 'R-42',
			degree: 'PhD',
			version: '2.0',
			databaseTitle: 'Evidence Data',
			websiteTitle: 'OpenDevEd',
			postedContentConfirmed: true,
			presentationType: 'poster'
		},
		...overrides
	}, '10.53832/opendeved.1205');
	if (!result.ok) throw new Error(JSON.stringify(result.issues));
	return result.record;
}

function validateAgainstOfficialSchema(xmlDocuments: readonly string[]): { readonly status: number | null; readonly stderr: string } {
	const directory = mkdtempSync(join(tmpdir(), 'crossref-5.5-'));
	try {
		const xmlPaths = xmlDocuments.map((xml, index) => {
			const xmlPath = join(directory, `deposit-${index}.xml`);
			writeFileSync(xmlPath, xml);
			return xmlPath;
		});
		for (let offset = 0; offset < xmlPaths.length; offset += 3) {
			const result = spawnSync('uvx', [
				'--from', 'xmlschema==4.3.2',
				'xmlschema-validate', '-vv', '--version', '1.1', '--schema', schemaPath,
				...xmlPaths.slice(offset, offset + 3)
			], { encoding: 'utf8' });
			if (result.status !== 0) return { status: result.status, stderr: result.stderr };
		}
		return { status: 0, stderr: '' };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
