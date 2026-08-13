import { describe, expect, it } from 'vitest';

import {
	verifyZenodoLegacyDepositionState,
	type ZenodoExpectedPublishedFile
} from '../zenodo/verification.js';
import {
	buildZenodoWritePayload,
	parseZenodoLegacyDepositionPayload
} from '../zenodo/records.js';
import { ZenodoApiClient, type ZenodoFetchLike, type ZenodoResponseLike } from '../zenodo/client.js';

const expectedPayload = buildZenodoWritePayload({
	doiPolicy: 'dual',
	metadata: {
		itemType: 'Report',
		title: 'Evidence report',
		publicationDate: '2026-08-13',
		abstract: 'A complete description.',
		language: 'eng',
		license: 'cc-by-4.0',
		publisher: 'OpenDevEd',
		institution: 'OpenDevEd',
		creators: [{
			type: 'personal',
			name: 'Researcher, Rina',
			affiliation: 'OpenDevEd',
			orcid: '0000-0002-1825-0097'
		}],
		tags: ['education', 'evidence']
	},
	resourceUrl: 'https://library.example/lib/REPORT01'
});

const expectedFiles: readonly ZenodoExpectedPublishedFile[] = [{
	filename: 'report.pdf',
	size: 4,
	md5: '08d6c05a21512a79a1dfeb9d2a8f262f'
}];

function deposition(overrides: Readonly<Record<string, unknown>> = {}) {
	return {
		id: 501,
		record_id: 501,
		submitted: true,
		state: 'done',
		metadata: {
			...expectedPayload.metadata,
			doi: '10.5072/zenodo.501',
			prereserve_doi: { doi: '10.5072/zenodo.501', recid: 501 },
			communities: [{ identifier: 'provider-owned-community' }],
			contributors: [
				{ name: 'Provider editor', type: 'Editor' },
				{ name: 'OpenDevEd', type: 'HostingInstitution' }
			]
		},
		files: [{
			id: 'file-1',
			filename: 'report.pdf',
			filesize: 4,
			checksum: '08d6c05a21512a79a1dfeb9d2a8f262f'
		}],
		...overrides
	};
}

describe('Zenodo published-state verification', () => {
	it('matches managed metadata and files while ignoring provider-owned metadata', () => {
		expect(verifyZenodoLegacyDepositionState({
			response: deposition(),
			expectedPayload,
			expectedFiles
		})).toEqual({ status: 'matched' });
	});

	it('reports every managed metadata and file difference', () => {
		expect(verifyZenodoLegacyDepositionState({
			response: deposition({
				metadata: {
					...expectedPayload.metadata,
					title: 'Changed remotely',
					contributors: [{ name: 'Another host', type: 'HostingInstitution' }]
				},
				files: [{
					id: 'file-1',
					filename: 'report.pdf',
					filesize: 5,
					checksum: 'md5:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
				}]
			}),
			expectedPayload,
			expectedFiles
		})).toEqual({
			status: 'drifted',
			metadataReasons: ['metadata.contributors', 'metadata.title'],
			fileReasons: ['files.report.pdf.md5', 'files.report.pdf.size']
		});
	});

	it('compares an external DOI when the saved payload owns it', () => {
		const externalPayload = buildZenodoWritePayload({
			doiPolicy: 'external-crossref',
			metadata: {
				itemType: 'Report',
				title: 'Evidence report',
				publicationDate: '2026-08-13',
				abstract: 'A complete description.',
				creators: [{ type: 'organizational', name: 'OpenDevEd' }],
				tags: [],
				doi: '10.1234/evidence.1'
			}
		});
		const response = deposition({
			metadata: { ...externalPayload.metadata, doi: '10.1234/changed' },
			files: []
		});
		expect(verifyZenodoLegacyDepositionState({
			response,
			expectedPayload: externalPayload,
			expectedFiles: []
		})).toEqual({
			status: 'drifted',
			metadataReasons: ['metadata.doi'],
			fileReasons: []
		});
	});

	it('detects removed optional managed fields and unexpected files', () => {
		const metadata = { ...expectedPayload.metadata };
		delete metadata['language'];
		expect(verifyZenodoLegacyDepositionState({
			response: deposition({
				metadata,
				files: [
					{ id: 'file-1', filename: 'report.pdf', filesize: 4, checksum: 'md5:08d6c05a21512a79a1dfeb9d2a8f262f' },
					{ id: 'file-2', filename: 'extra.pdf', filesize: 1, checksum: 'md5:7fc56270e7a70fa81a5935b72eacbe29' }
				]
			}),
			expectedPayload,
			expectedFiles
		})).toEqual({
			status: 'drifted',
			metadataReasons: ['metadata.language'],
			fileReasons: ['files.extra.pdf.unexpected']
		});
	});

	it('rejects malformed provider responses instead of treating them as drift', () => {
		expect(() => verifyZenodoLegacyDepositionState({
			response: { submitted: true, state: 'done', metadata: {}, files: 'not-an-array' },
			expectedPayload,
			expectedFiles
		})).toThrow('Expected Zenodo deposition files array');
		expect(() => verifyZenodoLegacyDepositionState({
			response: { submitted: true, state: 'done', files: [] },
			expectedPayload,
			expectedFiles
		})).toThrow('Expected Zenodo deposition metadata object');
		expect(() => verifyZenodoLegacyDepositionState({
			response: deposition({ submitted: false, state: 'unsubmitted' }),
			expectedPayload,
			expectedFiles
		})).toThrow('Expected a published Zenodo deposition');
		expect(() => verifyZenodoLegacyDepositionState({
			response: deposition({ files: [{ id: 'file-1', filename: 'report.pdf' }] }),
			expectedPayload,
			expectedFiles
		})).toThrow('missing filesize or MD5 checksum');
	});

	it('parses persisted plan snapshots at the provider boundary', () => {
		expect(parseZenodoLegacyDepositionPayload(expectedPayload)).toEqual(expectedPayload);
		expect(() => parseZenodoLegacyDepositionPayload({ metadata: null })).toThrow(
			'Expected Zenodo legacy deposition payload with metadata object'
		);
	});

	it('reads and verifies the owner deposition through the authenticated API', async () => {
		const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
		const fetch: ZenodoFetchLike = (url, init) => {
			calls.push({ url, init });
			return Promise.resolve(jsonResponse(deposition()));
		};
		const client = new ZenodoApiClient({
			endpoint: 'https://sandbox.zenodo.org',
			fetch
		});

		await expect(client.verifyPublishedState({
			token: 'sandbox-token',
			recordId: '501',
			expectedPayload,
			files: expectedFiles
		})).resolves.toEqual({ status: 'matched' });
		expect(calls).toEqual([{
			url: 'https://sandbox.zenodo.org/api/deposit/depositions/501',
			init: {
				method: 'GET',
				headers: { Authorization: 'Bearer sandbox-token' }
			}
		}]);
	});

	it('reports a missing published deposition without throwing', async () => {
		const client = new ZenodoApiClient({
			fetch: () => Promise.resolve({
				ok: false,
				status: 404,
				json: () => Promise.resolve({}),
				text: () => Promise.resolve('not found')
			})
		});
		await expect(client.verifyPublishedState({
			token: 'sandbox-token',
			recordId: 'missing',
			expectedPayload,
			files: []
		})).resolves.toEqual({ status: 'missing' });
	});
});

function jsonResponse(body: unknown): ZenodoResponseLike {
	return {
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(JSON.stringify(body))
	};
}
