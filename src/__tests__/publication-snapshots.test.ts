import { describe, expect, it } from 'vitest';

import { mapCrossrefRecord } from '../crossref/record-mapper.js';
import type { PublicationRecordSnapshot } from '../publication/record.js';
import {
	buildCrossrefPayloadSnapshot, buildPublicationPayloadHash, buildZenodoPayloadSnapshot
} from '../snapshots.js';
import { buildZenodoWritePayload } from '../zenodo/records.js';
import { buildZenodoProviderMetadata } from '../zenodo/publication-mapper.js';

describe('publication payload snapshots', () => {
	it('keeps the Crossref hash stable when metadata omitted from its wire contract changes', () => {
		const before = mappedCrossref({ tags: ['evidence'], license: 'cc-by-4.0', rights: 'Copyright' });
		const after = mappedCrossref({ tags: ['different'], license: 'cc0-1.0', rights: 'Public domain' });

		expect(buildPublicationPayloadHash(buildCrossrefPayloadSnapshot({ record: after }))).toBe(
			buildPublicationPayloadHash(buildCrossrefPayloadSnapshot({ record: before }))
		);
	});

	it('changes the Crossref hash when a serialized type-specific field changes', () => {
		const before = mappedCrossref({ fields: { publicationTitle: 'Evidence', volume: '1' } });
		const after = mappedCrossref({ fields: { publicationTitle: 'Evidence', volume: '2' } });

		expect(buildPublicationPayloadHash(buildCrossrefPayloadSnapshot({ record: after }))).not.toBe(
			buildPublicationPayloadHash(buildCrossrefPayloadSnapshot({ record: before }))
		);
	});

	it('keeps the Crossref hash stable across creator source fields that serialize identically', () => {
		const before = mappedCrossref({
			creators: [{
				type: 'personal', name: 'Original display name', givenName: 'Ada', familyName: 'Lovelace',
				creatorType: 'unsupported-one'
			}]
		});
		const after = mappedCrossref({
			creators: [{
				type: 'personal', name: 'Different display name', givenName: 'Ada', familyName: 'Lovelace',
				creatorType: 'unsupported-two'
			}]
		});

		expect(buildPublicationPayloadHash(buildCrossrefPayloadSnapshot({ record: after }))).toBe(
			buildPublicationPayloadHash(buildCrossrefPayloadSnapshot({ record: before }))
		);
	});

	it('hashes the actual managed Zenodo wire payload', () => {
		const snapshot = buildZenodoPayloadSnapshot({
			record: record(),
			identifiers: {},
			identifierPolicy: 'mint-zenodo'
		});

		expect(snapshot).toMatchObject({
			metadata: {
				upload_type: 'dataset',
				keywords: ['education', 'evidence'],
				license: 'cc-by-4.0',
				notes: 'Copyright OpenDevEd',
				language: 'eng',
				contributors: [{ name: 'OpenDevEd', type: 'HostingInstitution' }]
			}
		});
		expect(snapshot).not.toHaveProperty('record.fields');
		expect(snapshot).toEqual(buildZenodoWritePayload({
			doiPolicy: 'dual',
			metadata: buildZenodoProviderMetadata({
				record: record(), identifiers: {}, identifierPolicy: 'mint-zenodo'
			}),
			resourceUrl: record().landingUrl
		}));
	});

	it.each([
		['item type', { itemType: 'Report' }],
		['license', { license: 'cc0-1.0' }],
		['rights', { rights: 'Public domain' }],
		['language', { language: 'fra' }],
		['tags', { tags: ['different'] }],
		['institution', { institution: 'Another institution' }]
	] as const)('changes the Zenodo hash when managed %s changes', (_label, changes) => {
		const before = buildZenodoPayloadSnapshot({
			record: record(), identifiers: {}, identifierPolicy: 'mint-zenodo'
		});
		const after = buildZenodoPayloadSnapshot({
			record: { ...record(), ...changes }, identifiers: {}, identifierPolicy: 'mint-zenodo'
		});
		expect(buildPublicationPayloadHash(after)).not.toBe(buildPublicationPayloadHash(before));
	});
});

function mappedCrossref(overrides: Partial<PublicationRecordSnapshot>) {
	const result = mapCrossrefRecord({
		...record(), itemType: 'JournalArticle',
		fields: { publicationTitle: 'Evidence' },
		...overrides
	}, '10.53832/opendeved.1');
	if (!result.ok) throw new Error(JSON.stringify(result.issues));
	return result.record;
}

function record(): PublicationRecordSnapshot {
	return {
		recordKey: 'DATA1234', canonicalRevision: 1, itemType: 'Dataset', title: 'Evidence data',
		publicationDate: '2026-05-20', abstract: 'Dataset description', language: 'eng',
		publisher: 'OpenDevEd Press', institution: 'OpenDevEd', rights: 'Copyright OpenDevEd',
		license: 'cc-by-4.0', creators: [{ type: 'organizational', name: 'OpenDevEd' }],
		tags: ['evidence', 'education'], landingUrl: 'https://example.org/items/DATA1234', fields: {}
	};
}
