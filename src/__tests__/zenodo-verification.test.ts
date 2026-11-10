import { describe, expect, it } from 'vitest';

import { verifyZenodoRecordState, type ZenodoExpectedPublishedFile } from '../zenodo/verification.js';
import { buildZenodoRecordPayload } from '../zenodo/rdm-payload.js';
import { ZenodoApiClient, type ZenodoFetchLike, type ZenodoResponseLike } from '../zenodo/client.js';

const expectedPayload = buildZenodoRecordPayload({
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
			familyName: 'Researcher',
			givenName: 'Rina',
			affiliations: [{ name: 'CERN', ror: '01ggx4157' }],
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
		metadata: {},
		files: [{ id: 'file-1', filename: 'report.pdf', filesize: 4, checksum: '08d6c05a21512a79a1dfeb9d2a8f262f' }],
		...overrides
	};
}

/** The record as Zenodo serves it: what was written, with what its vocabularies add (a ROR's name, a licence's title). */
function record(metadata: Readonly<Record<string, unknown>> = {}, rest: Readonly<Record<string, unknown>> = {}) {
	const written = expectedPayload.metadata as Record<string, unknown>;
	return {
		id: '501',
		pids: { doi: { identifier: '10.5072/zenodo.501', provider: 'datacite' } },
		metadata: {
			...written,
			resource_type: { id: 'publication-report', title: { en: 'Report' } },
			creators: [{
				person_or_org: { type: 'personal', name: 'Researcher, Rina', given_name: 'Rina', family_name: 'Researcher', identifiers: [{ scheme: 'orcid', identifier: '0000-0002-1825-0097' }] },
				affiliations: [{ id: '01ggx4157', name: 'European Organization for Nuclear Research', identifiers: [{ scheme: 'ror', identifier: '01ggx4157' }] }]
			}],
			rights: [{ id: 'cc-by-4.0', title: { en: 'Creative Commons Attribution 4.0 International' } }],
			languages: [{ id: 'eng', title: { en: 'English' } }],
			...metadata
		},
		custom_fields: { 'code:codeRepository': 'provider-owned' },
		...rest
	};
}

describe('Zenodo published-state verification', () => {
	it('matches what was written inside what Zenodo adds to it', () => {
		expect(verifyZenodoRecordState({ deposition: deposition(), record: record(), expectedPayload, expectedFiles })).toEqual({ status: 'matched' });
	});

	it('reports every managed metadata and file difference', () => {
		expect(verifyZenodoRecordState({
			deposition: deposition({ files: [{ id: 'file-1', filename: 'report.pdf', filesize: 5, checksum: 'md5:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }] }),
			record: record({ title: 'Changed remotely', contributors: [{ person_or_org: { type: 'organizational', name: 'Another host' }, role: { id: 'hostinginstitution' } }] }),
			expectedPayload,
			expectedFiles
		})).toEqual({
			status: 'drifted',
			metadataReasons: ['metadata.contributors', 'metadata.title'],
			fileReasons: ['files.report.pdf.md5', 'files.report.pdf.size']
		});
	});

	it('compares an external DOI when the written payload owns it', () => {
		const externalPayload = buildZenodoRecordPayload({
			doiPolicy: 'external-crossref',
			metadata: { itemType: 'Report', title: 'Evidence report', publicationDate: '2026-08-13', creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [], doi: '10.1234/evidence.1' }
		});
		expect(verifyZenodoRecordState({
			deposition: deposition({ files: [] }),
			record: { metadata: externalPayload.metadata, custom_fields: {}, pids: { doi: { identifier: '10.1234/changed', provider: 'external' } } },
			expectedPayload: externalPayload,
			expectedFiles: []
		})).toEqual({ status: 'drifted', metadataReasons: ['pids.doi.identifier'], fileReasons: [] });
	});

	it('detects a removed managed field and an unexpected file', () => {
		expect(verifyZenodoRecordState({
			deposition: deposition({
				files: [
					{ id: 'file-1', filename: 'report.pdf', filesize: 4, checksum: 'md5:08d6c05a21512a79a1dfeb9d2a8f262f' },
					{ id: 'file-2', filename: 'extra.pdf', filesize: 1, checksum: 'md5:7fc56270e7a70fa81a5935b72eacbe29' }
				]
			}),
			record: record({ languages: undefined }),
			expectedPayload,
			expectedFiles
		})).toEqual({ status: 'drifted', metadataReasons: ['metadata.languages'], fileReasons: ['files.extra.pdf.unexpected'] });
	});

	it('rejects malformed provider responses instead of treating them as drift', () => {
		expect(() => verifyZenodoRecordState({ deposition: deposition({ files: 'not-an-array' }), record: record(), expectedPayload, expectedFiles })).toThrow('Expected Zenodo deposition files array');
		expect(() => verifyZenodoRecordState({ deposition: deposition(), record: null, expectedPayload, expectedFiles })).toThrow('Expected Zenodo record object');
		expect(() => verifyZenodoRecordState({ deposition: deposition({ submitted: false, state: 'unsubmitted' }), record: record(), expectedPayload, expectedFiles })).toThrow('Expected a published Zenodo deposition');
		expect(() => verifyZenodoRecordState({ deposition: deposition({ files: [{ id: 'file-1', filename: 'report.pdf' }] }), record: record(), expectedPayload, expectedFiles })).toThrow('missing filesize or MD5 checksum');
	});

	it('reads the deposition and the record through the authenticated API', async () => {
		const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
		const fetch: ZenodoFetchLike = (url, init) => {
			calls.push({ url, init });
			return Promise.resolve(jsonResponse(url.includes('/deposit/') ? deposition() : record()));
		};
		const client = new ZenodoApiClient({ endpoint: 'https://sandbox.zenodo.org', fetch });

		await expect(client.verifyPublishedState({ token: 'sandbox-token', recordId: '501', expectedPayload, files: expectedFiles })).resolves.toEqual({ status: 'matched' });
		expect(calls.map(({ url, init }) => [url, (init.headers as Record<string, string>)['Accept'], (init.headers as Record<string, string>)['Authorization']])).toEqual([
			['https://sandbox.zenodo.org/api/deposit/depositions/501', 'application/json', 'Bearer sandbox-token'],
			['https://sandbox.zenodo.org/api/records/501', 'application/vnd.inveniordm.v1+json', 'Bearer sandbox-token']
		]);
	});

	it('reports a missing published deposition without throwing', async () => {
		const client = new ZenodoApiClient({
			fetch: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('not found') })
		});
		await expect(client.verifyPublishedState({ token: 'sandbox-token', recordId: 'missing', expectedPayload, files: [] })).resolves.toEqual({ status: 'missing' });
	});
});

function jsonResponse(body: unknown): ZenodoResponseLike {
	return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}
