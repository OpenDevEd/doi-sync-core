import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import * as displayApi from '../display.js';
import * as publicApi from '../index.js';

const expectedRuntimeExports = [
	'CrossrefApiClient',
	'CROSSREF_PAYLOAD_FORMAT',
	'DirectProviderOperationRunner',
	'ProviderHttpError',
	'ResilientProviderOperationRunner',
	'ZENODO_INVENIORDM_ACCEPT',
	'ZenodoApiClient',
	'analyzeDoiDrift',
	'buildCrossrefPayloadSnapshot',
	'buildCrossrefPublicationXml',
	'buildPublicationFileManifestHash',
	'buildPublicationFileManifestSnapshot',
	'buildPublicationPayloadHash',
	'buildPublicationPayloadSnapshots',
	'buildZenodoPayloadSnapshot',
	'buildZenodoWritePayload',
	'createNoopLogger',
	'describeDryRun',
	'executeLivePublicationSyncPlan',
	'jsonValueSchema',
	'mapCrossrefRecord',
	'mapZenodoResourceType',
	'normalizeDoi',
	'parsePublicationFileManifest',
	'parsePublicationIdentifiers',
	'parsePublicationRecordSnapshot',
	'parsePublicationTargetPolicy',
	'parseProviderSyncState',
	'parseZenodoLegacyDepositionPayload',
	'parseZenodoLegacyDepositionFiles',
	'planPublicationSync',
	'retryAfterMsFromHeaders',
	'resolveDoiCandidates',
	'settleProviderSyncFailure',
	'settlePublicationSyncState',
	'verifyZenodoLegacyDepositionState'
].sort();

describe('public API surface', () => {
	it('exports only the provider-neutral runtime API', () => {
		expect(Object.keys(publicApi).sort()).toEqual(expectedRuntimeExports);
		expect(Object.keys(publicApi).join(' ')).not.toMatch(/zotero/i);
	});

	it('uses explicit exports and keeps browser-safe display isolated', () => {
		const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
		expect(indexSource).not.toMatch(/export\s+\*/);
		expect(Object.keys(displayApi).sort()).toEqual(['buildDoiDisplayLinks']);
		expect(Object.keys(publicApi)).not.toContain('buildDoiDisplayLinks');
		expect(readFileSync(new URL('../display.ts', import.meta.url), 'utf8')).not.toMatch(/zotero/i);
	});
});
