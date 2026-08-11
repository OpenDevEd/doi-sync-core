export type ZenodoPublicationType =
	| 'annotationcollection'
	| 'book'
	| 'section'
	| 'conferencepaper'
	| 'datamanagementplan'
	| 'article'
	| 'patent'
	| 'preprint'
	| 'deliverable'
	| 'milestone'
	| 'proposal'
	| 'report'
	| 'softwaredocumentation'
	| 'taxonomictreatment'
	| 'technicalnote'
	| 'thesis'
	| 'workingpaper'
	| 'other';

export type ZenodoImageType = 'figure' | 'plot' | 'drawing' | 'diagram' | 'photo' | 'other';

export type ZenodoResourceType =
	| { readonly uploadType: 'publication'; readonly publicationType: ZenodoPublicationType }
	| { readonly uploadType: 'image'; readonly imageType: ZenodoImageType }
	| { readonly uploadType: 'poster' | 'presentation' | 'dataset' | 'video' | 'software' | 'lesson' | 'physicalobject' | 'other' };

const CHILD_ITEM_TYPES = new Set(['Annotation', 'Attachment', 'Note']);

/** Maps canonical Evidence Library parent types to Zenodo's documented legacy-deposit vocabulary. */
export function mapZenodoResourceType(itemType: string): ZenodoResourceType | null {
	if (CHILD_ITEM_TYPES.has(itemType)) return null;

	switch (itemType) {
		case 'JournalArticle':
		case 'MagazineArticle':
		case 'NewspaperArticle':
			return publication('article');
		case 'Book':
			return publication('book');
		case 'BookSection':
		case 'DictionaryEntry':
		case 'EncyclopediaArticle':
			return publication('section');
		case 'ConferencePaper':
			return publication('conferencepaper');
		case 'Patent':
			return publication('patent');
		case 'Preprint':
			return publication('preprint');
		case 'Report':
			return publication('report');
		case 'Thesis':
			return publication('thesis');
		case 'Artwork':
		case 'Map':
			return { uploadType: 'image', imageType: 'other' };
		case 'AudioRecording':
		case 'Film':
		case 'Podcast':
		case 'RadioBroadcast':
		case 'TvBroadcast':
		case 'VideoRecording':
			return { uploadType: 'video' };
		case 'ComputerProgram':
			return { uploadType: 'software' };
		case 'Dataset':
			return { uploadType: 'dataset' };
		case 'Presentation':
			return { uploadType: 'presentation' };
		case 'Bill':
		case 'BlogPost':
		case 'Case':
		case 'Document':
		case 'Email':
		case 'ForumPost':
		case 'Hearing':
		case 'InstantMessage':
		case 'Interview':
		case 'Letter':
		case 'Manuscript':
		case 'Standard':
		case 'Statute':
		case 'Webpage':
			return publication('other');
		default:
			return null;
	}
}

function publication(publicationType: ZenodoPublicationType): ZenodoResourceType {
	return { uploadType: 'publication', publicationType };
}
