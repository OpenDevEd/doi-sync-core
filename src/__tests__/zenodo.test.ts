import { describe, expect, it } from 'vitest';

import {
	buildZenodoWritePayload,
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

	it('omits client-supplied DOI fields when Zenodo mints the DOI', () => {
		expect(buildZenodoWritePayload({
			doiPolicy: 'dual',
			metadata,
			existingMetadata: {
				doi: '10.53832/opendeved.1205',
				prereserve_doi: { doi: '10.5072/zenodo.42' }
			}
		}).metadata).toMatchObject({
			title: 'Evidence report',
			publication_date: '2026-05-20'
		});
		expect(buildZenodoWritePayload({ doiPolicy: 'dual', metadata }).metadata).not.toHaveProperty('doi');
	});

	it('requires and emits the managed Crossref DOI for external DOI records', () => {
		expect(buildZenodoWritePayload({
			doiPolicy: 'external-crossref', metadata
		}).metadata['doi']).toBe('10.53832/opendeved.1205');
		const withoutDoi = {
			itemType: metadata.itemType,
			title: metadata.title,
			publicationDate: metadata.publicationDate,
			abstract: metadata.abstract,
			creators: metadata.creators,
			tags: metadata.tags
		};
		expect(() => buildZenodoWritePayload({
			doiPolicy: 'external-crossref', metadata: withoutDoi
		})).toThrow('requires a DOI');
	});

	it('preserves provider-owned metadata while replacing managed fields', () => {
		const payload = buildZenodoWritePayload({
			doiPolicy: 'dual',
			metadata: { ...metadata, title: 'Updated title' },
			existingMetadata: {
				title: 'Old title',
				license: 'cc-by-4.0',
				communities: [{ identifier: 'opendeved' }]
			}
		});
		expect(payload.metadata).toMatchObject({
			title: 'Updated title',
			license: 'cc-by-4.0',
			communities: [{ identifier: 'opendeved' }],
			keywords: ['evidence'],
			notes: 'Copyright OpenDevEd',
			language: 'eng',
			imprint_publisher: 'OpenDevEd Press',
			contributors: [{ name: 'Open Development & Education', type: 'HostingInstitution' }]
		});
	});

	it('preserves provider-owned contributor roles while replacing only the managed institution', () => {
		const payload = buildZenodoWritePayload({
			doiPolicy: 'dual',
			metadata,
			existingMetadata: {
				contributors: [
					{ name: 'Editor One', type: 'Editor' },
					{ name: 'Old Institution', type: 'HostingInstitution' },
					{ name: 'Curator One', type: 'DataCurator' }
				]
			}
		});

		expect(payload.metadata['contributors']).toEqual([
			{ name: 'Editor One', type: 'Editor' },
			{ name: 'Curator One', type: 'DataCurator' },
			{ name: 'Open Development & Education', type: 'HostingInstitution' }
		]);
	});

	it('emits the precise resource type and clears obsolete conditional fields', () => {
		expect(buildZenodoWritePayload({
			doiPolicy: 'dual',
			metadata: { ...metadata, itemType: 'Dataset' },
			existingMetadata: { publication_type: 'report', image_type: 'figure' }
		}).metadata).toMatchObject({ upload_type: 'dataset' });
		expect(buildZenodoWritePayload({
			doiPolicy: 'dual', metadata: { ...metadata, itemType: 'Dataset' }
		}).metadata).not.toHaveProperty('publication_type');
	});

	it('rejects child records because attachments are published as files, not records', () => {
		expect(() => buildZenodoWritePayload({
			doiPolicy: 'dual', metadata: { ...metadata, itemType: 'Attachment' }
		})).toThrow('cannot publish Evidence Library item type Attachment');
	});

	it('appends the public landing URL idempotently', () => {
		const resourceUrl = 'https://example.org/items/ABC12345';
		const once = buildZenodoWritePayload({ doiPolicy: 'dual', metadata, resourceUrl });
		const description = once.metadata['description'];
		expect(typeof description).toBe('string');
		const twice = buildZenodoWritePayload({
			doiPolicy: 'dual', metadata: { ...metadata, abstract: typeof description === 'string' ? description : '' }, resourceUrl
		});
		const finalDescription = twice.metadata['description'];
		expect(typeof finalDescription === 'string' ? finalDescription.match(/Available from/g) : null).toHaveLength(1);
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
