import { describe, expect, it } from 'vitest';

import { mapCrossrefRecord } from '../crossref/record-mapper.js';
import type { PublicationRecordSnapshot } from '../publication/record.js';

describe('Crossref record mapper', () => {
	it.each([
		['JournalArticle', 'journal-article'],
		['Book', 'book'],
		['BookSection', 'book-component'],
		['DictionaryEntry', 'book-component'],
		['EncyclopediaArticle', 'book-component'],
		['ConferencePaper', 'conference-paper'],
		['Thesis', 'dissertation'],
		['Report', 'report'],
		['Standard', 'standard'],
		['Dataset', 'dataset'],
		['Preprint', 'posted-content'],
		['BlogPost', 'posted-content'],
		['Letter', 'posted-content'],
		['Document', 'posted-content'],
		['Manuscript', 'posted-content'],
		['Presentation', 'posted-content']
	] as const)('maps supported %s without a report fallback', (itemType, kind) => {
		const result = mapCrossrefRecord(record({ itemType }), '10.53832/opendeved.1');

		expect(result).toMatchObject({ ok: true, record: { kind } });
	});

	it.each([
		'Annotation', 'Artwork', 'Attachment', 'AudioRecording', 'Bill', 'Case', 'ComputerProgram',
		'Email', 'Film', 'ForumPost', 'Hearing', 'InstantMessage', 'Interview', 'MagazineArticle',
		'Map', 'NewspaperArticle', 'Note', 'Patent', 'Podcast', 'RadioBroadcast', 'Statute',
		'TvBroadcast', 'VideoRecording', 'Webpage'
	]) (
		'blocks unsupported %s instead of silently depositing it as a report',
		(itemType) => {
			const result = mapCrossrefRecord(record({ itemType }), '10.53832/opendeved.1');
			expect(result).toMatchObject({
				ok: false,
				issues: [{ code: 'UNSUPPORTED_ITEM_TYPE', path: 'itemType' }]
			});
		}
	);

	it('returns structured field requirements for supported types', () => {
		const result = mapCrossrefRecord(record({
			itemType: 'JournalArticle',
			fields: {}
		}), '10.53832/opendeved.1');

		expect(result).toEqual({
			ok: false,
			issues: [{
				code: 'MISSING_REQUIRED_FIELD',
				path: 'fields.publicationTitle',
				message: 'Crossref requires journal title'
			}]
		});
	});

	it('requires explicit Crossref eligibility for ambiguous posted content', () => {
		expect(mapCrossrefRecord(record({ itemType: 'Document', fields: {} }), '10.53832/opendeved.1'))
			.toMatchObject({ ok: false, issues: [{ code: 'INVALID_FIELD_VALUE' }] });
		expect(mapCrossrefRecord(record({
			itemType: 'Presentation', fields: { presentationType: 'slides' }
		}), '10.53832/opendeved.1'))
			.toMatchObject({ ok: false, issues: [{ code: 'INVALID_FIELD_VALUE' }] });
	});

	it.each(['not-a-date', '2026-02-30', '1399', '2201'])('rejects invalid Crossref publication date %s before planning', (publicationDate) => {
		expect(mapCrossrefRecord(record({ publicationDate }), '10.53832/opendeved.1')).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_FIELD_VALUE', path: 'publicationDate' }]
		});
	});

	it('rejects invalid language and ORCID values before planning', () => {
		expect(mapCrossrefRecord(record({ language: 'english' }), '10.53832/opendeved.1'))
			.toMatchObject({ ok: false, issues: [{ path: 'language' }] });
		expect(mapCrossrefRecord(record({
			creators: [{ type: 'personal', name: 'Ada', orcid: 'not-an-orcid' }]
		}), '10.53832/opendeved.1'))
			.toMatchObject({ ok: false, issues: [{ path: 'creators.0.orcid' }] });
		expect(mapCrossrefRecord(record({
			creators: [{ type: 'personal', name: 'Ada', orcid: '0000-0002-1825-0098' }]
		}), '10.53832/opendeved.1'))
			.toMatchObject({ ok: false, issues: [{ path: 'creators.0.orcid' }] });
	});

	it('rejects a Crossref DOI suffix longer than the schema limit', () => {
		expect(mapCrossrefRecord(record({}), `10.53832/${'x'.repeat(201)}`)).toMatchObject({
			ok: false, issues: [{ path: 'identifiers.managedCrossrefDoi' }]
		});
	});

	it('keeps distinct report publisher and institution and maps all managed report fields', () => {
		const result = mapCrossrefRecord(record({
			publisher: 'Evidence Press',
			institution: 'OpenDevEd',
			fields: { ISBN: '978-1-4028-9462-6', edition: '2', reportNumber: 'R-42' }
		}), '10.53832/opendeved.1');

		expect(result).toMatchObject({
			ok: true,
			record: {
				kind: 'report', publisher: 'Evidence Press', institution: 'OpenDevEd',
				isbns: ['978-1-4028-9462-6'], edition: '2', itemNumber: 'R-42'
			}
		});
	});
});

function record(overrides: Partial<PublicationRecordSnapshot>): PublicationRecordSnapshot {
	return {
		recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report', title: 'Evidence',
		publicationDate: '2026-05-20', publisher: 'OpenDevEd', institution: 'OpenDevEd',
		creators: [{ type: 'personal', name: 'Ada Lovelace', familyName: 'Lovelace' }], tags: [],
		landingUrl: 'https://example.org/items/ABC12345',
		fields: {
			publicationTitle: 'Evidence Journal', bookTitle: 'Evidence Book',
			dictionaryTitle: 'Evidence Dictionary', encyclopediaTitle: 'Evidence Encyclopedia',
			conferenceName: 'Evidence Conference', proceedingsTitle: 'Evidence Proceedings',
			number: 'ODE-1', databaseTitle: 'Evidence Data', websiteTitle: 'OpenDevEd',
			postedContentConfirmed: true, presentationType: 'poster'
		},
		...overrides
	};
}
