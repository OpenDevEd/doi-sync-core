import { describe, expect, it } from 'vitest';

import { mapZenodoResourceType } from '../zenodo/resource-mapper.js';

describe('Zenodo resource mapper', () => {
	it.each([
		['JournalArticle', { uploadType: 'publication', publicationType: 'article' }],
		['MagazineArticle', { uploadType: 'publication', publicationType: 'article' }],
		['NewspaperArticle', { uploadType: 'publication', publicationType: 'article' }],
		['Book', { uploadType: 'publication', publicationType: 'book' }],
		['BookSection', { uploadType: 'publication', publicationType: 'section' }],
		['DictionaryEntry', { uploadType: 'publication', publicationType: 'section' }],
		['EncyclopediaArticle', { uploadType: 'publication', publicationType: 'section' }],
		['ConferencePaper', { uploadType: 'publication', publicationType: 'conferencepaper' }],
		['Patent', { uploadType: 'publication', publicationType: 'patent' }],
		['Preprint', { uploadType: 'publication', publicationType: 'preprint' }],
		['Report', { uploadType: 'publication', publicationType: 'report' }],
		['Thesis', { uploadType: 'publication', publicationType: 'thesis' }],
		['Artwork', { uploadType: 'image', imageType: 'other' }],
		['Map', { uploadType: 'image', imageType: 'other' }],
		['AudioRecording', { uploadType: 'video' }],
		['Film', { uploadType: 'video' }],
		['Podcast', { uploadType: 'video' }],
		['RadioBroadcast', { uploadType: 'video' }],
		['TvBroadcast', { uploadType: 'video' }],
		['VideoRecording', { uploadType: 'video' }],
		['ComputerProgram', { uploadType: 'software' }],
		['Dataset', { uploadType: 'dataset' }],
		['Presentation', { uploadType: 'presentation' }],
		['Bill', { uploadType: 'publication', publicationType: 'other' }],
		['BlogPost', { uploadType: 'publication', publicationType: 'other' }],
		['Case', { uploadType: 'publication', publicationType: 'other' }],
		['Document', { uploadType: 'publication', publicationType: 'other' }],
		['Email', { uploadType: 'publication', publicationType: 'other' }],
		['ForumPost', { uploadType: 'publication', publicationType: 'other' }],
		['Hearing', { uploadType: 'publication', publicationType: 'other' }],
		['InstantMessage', { uploadType: 'publication', publicationType: 'other' }],
		['Interview', { uploadType: 'publication', publicationType: 'other' }],
		['Letter', { uploadType: 'publication', publicationType: 'other' }],
		['Manuscript', { uploadType: 'publication', publicationType: 'other' }],
		['Standard', { uploadType: 'publication', publicationType: 'other' }],
		['Statute', { uploadType: 'publication', publicationType: 'other' }],
		['Webpage', { uploadType: 'publication', publicationType: 'other' }]
	] as const)('maps %s to the documented controlled vocabulary', (itemType, expected) => {
		expect(mapZenodoResourceType(itemType)).toEqual(expected);
	});

	it.each(['Annotation', 'Attachment', 'Note'])('rejects child item type %s', (itemType) => {
		expect(mapZenodoResourceType(itemType)).toBeNull();
	});

	it('rejects unknown item types instead of silently publishing them as other', () => {
		expect(mapZenodoResourceType('FutureResearchObject')).toBeNull();
	});
});
