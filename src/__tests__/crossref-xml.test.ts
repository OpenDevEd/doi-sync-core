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
			// Funding, references and relations sit somewhere else in each family's container.
			...itemTypes.map((itemType) => buildCrossrefPublicationXml(xmlInput(mappedRecord(itemType, WORK_DETAILS), ARCHIVE_RELATION))),
			buildCrossrefPublicationXml(xmlInput(seriesReport(), ARCHIVE_RELATION)),
			buildCrossrefPublicationXml(xmlInput(seriesReport(), 'delete-all')),
			buildCrossrefPublicationXml(xmlInput(mappedRecord('Report', NO_DETAILS))),
			buildCrossrefPublicationXml(xmlInput(mappedRecord('Report', { ...NO_DETAILS, fields: SERIES_FIELDS }))),
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
				affiliations: [{ name: 'Open\u0002DevEd' }], orcid: '0000-0002-1825-0097'
			}]
		});
		const xml = buildCrossrefPublicationXml(xmlInput(record));

		expect(xml).not.toContain('\u0001');
		expect(xml).not.toContain('\u0002');
		expect(xml).toContain('<title>Evidence report</title>');
		expect(xml).toContain('<ORCID>https://orcid.org/0000-0002-1825-0097</ORCID>');
	});

	it('deposits a work\'s funders, cited DOIs and relations beside the archive link', () => {
		const xml = buildCrossrefPublicationXml(xmlInput(mappedRecord('Report', WORK_DETAILS), ARCHIVE_RELATION));

		expect(xml).toContain('<fr:assertion name="funder_name">National Science Foundation<fr:assertion name="funder_identifier">https://doi.org/10.13039/100000001</fr:assertion></fr:assertion><fr:assertion name="ror">https://ror.org/021nxhr62</fr:assertion><fr:assertion name="award_number">CHE-1152342</fr:assertion><fr:assertion name="award_number">CBET-106</fr:assertion>');
		expect(xml).toContain('<citation key="ref1"><doi>10.1000/cited.1</doi></citation><citation key="ref2"><doi>10.1000/cited.2</doi></citation>');
		expect(xml.match(/<rel:related_item>/g)).toHaveLength(3);
	});

	it('clears funding, citations and relations a record gives as none, and leaves them alone when it gives nothing', () => {
		const cleared = buildCrossrefPublicationXml(xmlInput(mappedRecord('Report', NO_DETAILS)));
		const untouched = buildCrossrefPublicationXml(xmlInput(mappedRecord('Report')));

		expect(cleared).toContain('<fr:program name="fundref"/>');
		expect(cleared).toContain('<rel:program/>');
		expect(cleared).toContain('<citation_list/>');
		expect(untouched).not.toMatch(/fr:program|rel:program|citation_list/);
	});

	it('takes back the full-text links and free to read once the work is withdrawn, keeping the licence', () => {
		const xml = buildCrossrefPublicationXml(xmlInput(mappedRecord('Report', { ...WORK_DETAILS, withdrawnOn: '2026-11-11' })));

		expect(xml).toContain('<collection property="text-mining"/><collection property="crawler-based"/>');
		expect(xml).not.toContain('R100001/pdf');
		expect(xml).not.toContain('ai:free_to_read');
		expect(xml).toContain('<ai:license_ref applies_to="vor">https://creativecommons.org/licenses/by/4.0/legalcode</ai:license_ref>');
	});

	it('deposits the subtitle, roles, affiliations by ROR and country, the funder\'s ROR, the licence and the full text', () => {
		const xml = buildCrossrefPublicationXml(xmlInput(mappedRecord('Report', WORK_DETAILS)));

		expect(xml).toContain('<titles><title>Evidence &amp; impact</title><subtitle>Evidence from Malawi</subtitle></titles>');
		expect(xml).toContain('<role vocab="credit" type="conceptualization"/><role vocab="credit" type="writing-original-draft"/><role vocab="crossref" type="corresponding-author"/>');
		expect(xml).toContain('<institution><institution_name>CERN</institution_name><institution_id type="ror">https://ror.org/01ggx4157</institution_id><institution_place>Switzerland</institution_place></institution><institution><institution_name>A typed institute</institution_name></institution>');
		expect(xml).toContain('<fr:assertion name="ror">https://ror.org/021nxhr62</fr:assertion>');
		expect(xml).toContain('<ai:program name="AccessIndicators"><ai:free_to_read/><ai:license_ref applies_to="vor">https://creativecommons.org/licenses/by/4.0/legalcode</ai:license_ref><ai:license_ref applies_to="tdm">https://creativecommons.org/licenses/by/4.0/legalcode</ai:license_ref></ai:program>');
		expect(xml).toContain('<collection property="text-mining"><item><resource mime_type="application/pdf">https://openscholar.ai/papers/R100001/pdf</resource></item></collection><collection property="crawler-based"><item crawler="similarity-check"><resource>https://openscholar.ai/papers/R100001/pdf</resource></item></collection>');
	});

	it('deposits a report in a series with an ISSN as series metadata', () => {
		const xml = buildCrossrefPublicationXml(xmlInput(seriesReport()));

		expect(xml).toContain('<report-paper_series_metadata language="en"><series_metadata><titles><title>Openscholar Reports</title></titles><issn>2049-3630</issn></series_metadata>');
		expect(xml).not.toContain('<report-paper_metadata');
	});

	it('serializes distinct report organizations and managed type-specific metadata', () => {
		const record = mappedRecord('Report', {
			publisher: 'Evidence Press', institution: 'OpenDevEd',
			fields: { ISBN: '978-1-4028-9462-6', edition: '2', reportNumber: 'R-42', place: 'London, UK' }
		});
		const xml = buildCrossrefPublicationXml(xmlInput(record));

		expect(xml).toContain('<publisher><publisher_name>Evidence Press</publisher_name><publisher_place>London, UK</publisher_place></publisher>');
		expect(xml).toContain('<institution_name>OpenDevEd</institution_name>');
		expect(xml).toContain('<edition_number>2</edition_number>');
		expect(xml).toContain('<isbn>978-1-4028-9462-6</isbn>');
		expect(xml).toContain('<publisher_item><item_number>R-42</item_number></publisher_item>');
	});
});

const WORK_DETAILS = {
	subtitle: 'Evidence from Malawi',
	license: 'cc-by-4.0',
	fullTextUrl: 'https://openscholar.ai/papers/R100001/pdf',
	creators: [
		{
			type: 'personal', name: 'Banda, Chikondi', givenName: 'Chikondi', familyName: 'Banda', orcid: '0000-0002-1825-0097',
			roles: ['conceptualization', 'writing-original-draft'], corresponding: true,
			affiliations: [{ name: 'CERN', ror: '01ggx4157', country: 'CH' }, { name: 'A typed institute' }]
		},
		{ type: 'organizational', name: 'World Health Organization', ror: '01f80g185' }
	],
	funding: [
		{ funderName: 'National Science Foundation', funderIdentifier: 'https://doi.org/10.13039/100000001', funderRor: '021nxhr62', awards: ['CHE-1152342', 'CBET-106'] },
		{ funderName: 'A funder with no identifier', awards: [] }
	],
	references: ['https://doi.org/10.1000/Cited.1', '10.1000/cited.2'],
	relations: [
		{ type: 'isSupplementedBy', identifierType: 'uri', identifier: 'https://github.com/example/code', description: 'Code' },
		{ type: 'hasVersion', identifierType: 'doi', identifier: '10.1000/earlier', description: 'Other version' }
	]
} satisfies Partial<PublicationRecordSnapshot>;

const ARCHIVE_RELATION = {
	type: 'isSupplementedBy', identifierType: 'doi', identifier: '10.5281/zenodo.15043088', description: 'Archived file package'
} as const;

const NO_DETAILS = { funding: [], references: [], relations: [] } satisfies Partial<PublicationRecordSnapshot>;
const SERIES_FIELDS = { reportNumber: 'R100001', seriesTitle: 'Openscholar Reports', ISSN: '2049-3630' };

function seriesReport(): CrossrefMappedRecord {
	return mappedRecord('Report', { ...WORK_DETAILS, fields: SERIES_FIELDS });
}

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
