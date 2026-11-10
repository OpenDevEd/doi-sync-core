import { describe, expect, it } from 'vitest';

import { buildZenodoRecordPayload, parseZenodoRecordPayload } from '../zenodo/rdm-payload.js';
import {
	parseZenodoLegacyDepositionIdentifiers,
	parseZenodoRecordIdentifiers,
	ZENODO_INVENIORDM_ACCEPT
} from '../zenodo/records.js';

const metadata = {
	doi: '10.53832/opendeved.1205',
	itemType: 'Report',
	title: 'Evidence report',
	publicationDate: '2026-05-20',
	abstract: 'Summary',
	language: 'eng',
	publisher: 'OpenDevEd Press',
	institution: 'Open Development & Education',
	rights: 'Copyright OpenDevEd',
	license: 'cc-by-4.0',
	creators: [{ type: 'personal' as const, name: 'Lovelace, Ada', orcid: '0000-0001-2345-6789' }],
	tags: ['evidence']
};

describe('Zenodo records', () => {
	it('uses the current InvenioRDM accept header', () => {
		expect(ZENODO_INVENIORDM_ACCEPT).toBe('application/vnd.inveniordm.v1+json');
	});

	it('writes every field a record holds in the InvenioRDM format, and a ROR Zenodo lacks by name', () => {
		const payload = buildZenodoRecordPayload({
			doiPolicy: 'external-crossref',
			resourceUrl: 'https://openscholar.ai/papers/R100001',
			known: { affiliations: new Set(['01ggx4157']), funders: new Set(['021nxhr62']) },
			metadata: {
				...metadata,
				subtitle: 'Evidence from Malawi',
				creators: [
					{
						type: 'personal', name: 'Banda, Chikondi', givenName: 'Chikondi', familyName: 'Banda', orcid: 'https://orcid.org/0000-0002-1825-0097',
						corresponding: true, roles: ['conceptualization'],
						affiliations: [{ name: 'CERN', ror: '01ggx4157', country: 'CH' }, { name: 'Unknown institute', ror: '0abcdef12' }]
					},
					{ type: 'personal', name: 'Okafor, Ada', givenName: 'Ada', familyName: 'Okafor', creatorType: 'editor' },
					{ type: 'organizational', name: 'World Health Organization', ror: '01f80g185' }
				],
				subjects: ['Climate change impacts on agriculture', 'SDG 2: Zero hunger'],
				methods: 'Observational study',
				locations: [{ place: 'Malawi', country: 'MW' }],
				pages: 12,
				formats: ['application/pdf'],
				copyright: '© 2026 The authors',
				withdrawnOn: '2026-11-10',
				funding: [
					{ funderName: 'National Science Foundation', funderRor: '021nxhr62', awards: ['CHE-1152342', 'CBET-106'] },
					{ funderName: 'A funder Zenodo lacks', funderRor: '0zzzzzz12', awards: [] }
				],
				references: ['https://doi.org/10.1038/NATURE12373'],
				relations: [
					{ type: 'isSupplementedBy', identifierType: 'doi', identifier: '10.5281/zenodo.42', description: 'Data' },
					{ type: 'hasVersion', identifierType: 'uri', identifier: 'https://example.org/preprint' }
				],
				fields: { seriesTitle: 'Openscholar Reports', ISSN: '2049-3630', reportNumber: 'R100001', place: 'Nairobi, Kenya' }
			}
		});

		expect(payload.pids).toEqual({ doi: { identifier: '10.53832/opendeved.1205', provider: 'external' } });
		expect(payload.metadata).toMatchObject({
			resource_type: { id: 'publication-report' },
			title: 'Evidence report',
			additional_titles: [{ title: 'Evidence from Malawi', type: { id: 'subtitle' } }],
			publisher: 'OpenDevEd Press',
			creators: [
				{
					person_or_org: { type: 'personal', given_name: 'Chikondi', family_name: 'Banda', identifiers: [{ scheme: 'orcid', identifier: '0000-0002-1825-0097' }] },
					affiliations: [{ id: '01ggx4157' }, { name: 'Unknown institute' }],
					role: { id: 'contactperson' }
				},
				{ person_or_org: { type: 'organizational', name: 'World Health Organization', identifiers: [{ scheme: 'ror', identifier: '01f80g185' }] } }
			],
			contributors: [
				{ person_or_org: { type: 'personal', given_name: 'Ada', family_name: 'Okafor' }, role: { id: 'editor' } },
				{ person_or_org: { type: 'organizational', name: 'Open Development & Education' }, role: { id: 'hostinginstitution' } }
			],
			additional_descriptions: [
				{ description: 'Observational study', type: { id: 'methods' } },
				{ description: 'Openscholar Reports, ISSN 2049-3630', type: { id: 'series-information' } },
				{ description: 'Copyright OpenDevEd', type: { id: 'other' } }
			],
			rights: [{ id: 'cc-by-4.0' }],
			copyright: '© 2026 The authors',
			subjects: [{ subject: 'Climate change impacts on agriculture' }, { subject: 'SDG 2: Zero hunger' }, { subject: 'evidence' }],
			languages: [{ id: 'eng' }],
			dates: [{ date: '2026-11-10', type: { id: 'withdrawn' } }],
			identifiers: [{ identifier: 'https://openscholar.ai/papers/R100001', scheme: 'url' }, { identifier: 'R100001', scheme: 'other' }],
			related_identifiers: [
				{ identifier: '10.5281/zenodo.42', scheme: 'doi', relation_type: { id: 'issupplementedby' } },
				{ identifier: 'https://example.org/preprint', scheme: 'url', relation_type: { id: 'hasversion' } },
				{ identifier: '2049-3630', scheme: 'issn', relation_type: { id: 'ispartof' } }
			],
			sizes: ['12 pages'],
			formats: ['application/pdf'],
			locations: { features: [{ place: 'Malawi' }] },
			funding: [
				{ funder: { id: '021nxhr62' }, award: { number: 'CHE-1152342', title: { en: 'CHE-1152342' } } },
				{ funder: { id: '021nxhr62' }, award: { number: 'CBET-106', title: { en: 'CBET-106' } } },
				{ funder: { name: 'A funder Zenodo lacks' } }
			],
			references: [{ reference: 'https://doi.org/10.1038/nature12373', identifier: '10.1038/nature12373', scheme: 'doi' }]
		});
		expect(payload.custom_fields).toEqual({ 'imprint:imprint': { title: 'Openscholar Reports', place: 'Nairobi, Kenya' } });
	});

	it('leaves the DOI to Zenodo when it mints one', () => {
		expect(buildZenodoRecordPayload({ doiPolicy: 'dual', metadata })).not.toHaveProperty('pids');
		const withoutDoi = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'doi')) as Omit<typeof metadata, 'doi'>;
		expect(() => buildZenodoRecordPayload({ doiPolicy: 'external-crossref', metadata: withoutDoi })).toThrow('requires a DOI');
	});

	it('names the type, the journal, the conference and the thesis in Zenodo\'s fields', () => {
		const journal = buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'JournalArticle', fields: { publicationTitle: 'Evidence Journal', ISSN: '2049-3630', volume: '12', issue: '3', pages: '10-24' } } });
		expect(journal.metadata['resource_type']).toEqual({ id: 'publication-article' });
		expect(journal.custom_fields).toEqual({ 'journal:journal': { title: 'Evidence Journal', issn: '2049-3630', volume: '12', issue: '3', pages: '10-24' } });
		// The meeting is where the conference was held; the imprint, where its proceedings were published.
		const paper = buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'ConferencePaper', fields: { conferenceName: 'Evidence Conference', proceedingsTitle: 'Proceedings', place: 'Oxford, UK', eventPlace: 'Nairobi, Kenya' } } });
		expect(paper.custom_fields).toEqual({ 'imprint:imprint': { title: 'Proceedings', place: 'Oxford, UK' }, 'meeting:meeting': { title: 'Evidence Conference', place: 'Nairobi, Kenya' } });
		// Zenodo keeps theses as dissertations, and standards under a type of their own.
		const thesis = buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'Thesis', fields: { thesisType: 'PhD' } } });
		expect(thesis.metadata['resource_type']).toEqual({ id: 'publication-dissertation' });
		expect(thesis.custom_fields).toEqual({ 'thesis:thesis': { university: 'Open Development & Education', type: 'PhD' } });
		expect(buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'Standard' } }).metadata['resource_type']).toEqual({ id: 'publication-standard' });
		expect(buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'Map' } }).metadata['resource_type']).toEqual({ id: 'image-other' });
		const entry = buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'DictionaryEntry', fields: { dictionaryTitle: 'Evidence Dictionary', PMID: '12345678' } } });
		expect(entry.custom_fields).toEqual({ 'imprint:imprint': { title: 'Evidence Dictionary' } });
		expect(entry.metadata['identifiers']).toEqual([{ identifier: '12345678', scheme: 'pmid' }]);
		// A programming language goes by Zenodo's ID, and only when its vocabulary holds it.
		const software = (known: ReadonlySet<string>) => buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'ComputerProgram', fields: { programmingLanguage: 'Python' } }, known: { affiliations: new Set(), funders: new Set(), programmingLanguages: known } });
		expect(software(new Set(['python'])).custom_fields).toEqual({ 'code:programmingLanguage': [{ id: 'python' }] });
		expect(software(new Set()).custom_fields).toEqual({});
	});

	it('reads a saved payload back, and refuses one saved in the legacy deposit format', () => {
		const payload = buildZenodoRecordPayload({ doiPolicy: 'external-crossref', metadata });
		expect(parseZenodoRecordPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
		expect(() => parseZenodoRecordPayload({ metadata: { upload_type: 'publication' } })).toThrow('InvenioRDM format');
	});

	it('rejects child records because attachments are published as files, not records', () => {
		expect(() => buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, itemType: 'Attachment' } })).toThrow('item type Attachment');
	});

	it('links the public landing page once, however often the description is built', () => {
		const resourceUrl = 'https://example.org/items/ABC?x=1&y=2';
		const once = buildZenodoRecordPayload({ doiPolicy: 'dual', metadata, resourceUrl });
		const description = once.metadata['description'];
		const twice = buildZenodoRecordPayload({ doiPolicy: 'dual', metadata: { ...metadata, abstract: typeof description === 'string' ? description : '' }, resourceUrl });
		const finalDescription = twice.metadata['description'];
		expect(typeof finalDescription === 'string' ? finalDescription.match(/Available from/g) : null).toHaveLength(1);
		expect(finalDescription).toContain('https://example.org/items/ABC?x=1&amp;y=2');
	});

	it('parses published record and concept identifiers', () => {
		expect(parseZenodoRecordIdentifiers({
			id: '42', parent: { id: '41', pids: { doi: { identifier: '10.5281/zenodo.41' } } },
			pids: { doi: { identifier: '10.5281/zenodo.42' } },
			created: '2026-04-20T09:30:00.000Z',
			links: { self_html: 'https://zenodo.org/records/42' }
		})).toEqual({
			latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42',
			conceptDoi: '10.5281/zenodo.41', publishedAt: new Date('2026-04-20T09:30:00.000Z'),
			links: { selfHtml: 'https://zenodo.org/records/42' }
		});
		expect(() => parseZenodoRecordIdentifiers({
			id: '42', parent: { id: '41' }
		})).toThrow('created publication time');
	});

	it('parses only unpublished legacy depositions', () => {
		expect(parseZenodoLegacyDepositionIdentifiers({
			id: 42, record_id: 42, submitted: false, state: 'unsubmitted', files: [], metadata: {}, links: {}
		})).toMatchObject({ depositionId: '42', recordId: '42', submitted: false });
		expect(parseZenodoLegacyDepositionIdentifiers({
			id: 42, record_id: 42, submitted: true, state: 'done'
		})).toBeNull();
	});
});
