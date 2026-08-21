import { describe, expect, it } from 'vitest';

import type { PublicationRecordSnapshot } from '../publication/record.js';
import { ZENODO_LICENSE_IDS } from '../zenodo/licenses.js';
import {
	buildZenodoProviderMetadata,
	validateZenodoPublicationRecord
} from '../zenodo/publication-mapper.js';

describe('Zenodo publication mapper', () => {
	it.each([
		['unknown item type', { itemType: 'FutureResearchObject' }, 'itemType'],
		['partial date', { publicationDate: '2026-05' }, 'publicationDate'],
		['impossible date', { publicationDate: '2026-02-30' }, 'publicationDate'],
		['missing description', { abstract: undefined }, 'abstract'],
		['missing creators', { creators: [] }, 'creators'],
		['two-letter language', { language: 'en' }, 'language'],
		['unknown license', { license: 'made-up-license' }, 'license']
	] as const)('returns a structured issue for %s', (_label, changes, path) => {
		const issues = validateZenodoPublicationRecord({ ...record(), ...changes });
		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toBe(path);
	});

	it('normalizes controlled language and license values in the shared provider projection', () => {
		expect(buildZenodoProviderMetadata({
			record: record({ language: 'ENG', license: 'CC-BY-4.0' }),
			identifiers: { managedCrossrefDoi: '10.53832/opendeved.1' },
			identifierPolicy: 'reuse-crossref'
		})).toMatchObject({ language: 'eng', license: 'cc-by-4.0', doi: '10.53832/opendeved.1' });
	});

	it('accepts licenses from the complete Zenodo vocabulary snapshot', () => {
		expect(ZENODO_LICENSE_IDS.size).toBe(444);
		expect(validateZenodoPublicationRecord(record({ license: 'agpl-3.0-only' }))).toEqual([]);
	});
});

function record(overrides: Partial<PublicationRecordSnapshot> = {}): PublicationRecordSnapshot {
	return {
		recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report', title: 'Evidence',
		publicationDate: '2026-05-20', language: 'eng', license: 'cc-by-4.0',
		abstract: 'Evidence summary', publisher: 'OpenDevEd',
		creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
		landingUrl: 'https://example.org/items/ABC12345', fields: {},
		...overrides
	};
}

describe('reuse-external', () => {
	it('sends the record\'s own DOI to Zenodo', () => {
		expect(buildZenodoProviderMetadata({
			record: record(),
			identifiers: { bibliographicDoi: '10.1080/09500693.2021.1887' },
			identifierPolicy: 'reuse-external'
		})).toMatchObject({ doi: '10.1080/09500693.2021.1887' });
	});
});
