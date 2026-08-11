import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import * as publicApi from '../index.js';
import * as displayApi from '../display.js';

const expectedRuntimeExports = [
  'CrossrefApiClient',
  'DEFAULT_ZOTERO_PDF_TAGS',
  'DirectProviderOperationRunner',
  'EvidenceLibraryRedirectResolver',
  'ProviderHttpError',
  'ResilientProviderOperationRunner',
  'ZENODO_INVENIORDM_ACCEPT',
  'ZOTERO_DOI_LIVE_TAG',
  'ZOTERO_ZENODO_SUBMITTED_TAG',
  'ZOTERO_ZENODO_UPLOADED_TAG',
  'ZenodoApiClient',
  'ZoteroApiClient',
  'analyzeDoiDrift',
  'auditCrossrefDepositMetadata',
  'auditZenodoWritePayloadMetadata',
  'buildCanonicalMetadataSnapshot',
  'buildFileManifest',
  'buildFileManifestHash',
  'buildIntendedDiff',
  'buildZenodoWritePayload',
  'buildZoteroWritebackData',
  'buildZoteroWritebackIdentifiers',
  'createNoopLogger',
  'describeDryRunExecution',
  'diffFileManifest',
  'effectiveZenodoDoiPolicy',
  'executeLiveSyncPlan',
  'jsonValueSchema',
  'mergeManagedExtraLines',
  'parseManagedExtraIdentifiers',
  'planZoteroDoiDriftAutofix',
  'planZoteroIdentifierLinkReconciliation',
  'planZoteroIdentifierLinks',
  'planZoteroSuccessTagApplications',
  'planZoteroWriteback',
  'prepareDoiSync',
  'recoverZenodoFileStateFromSnapshot',
  'resolveCanonicalZoteroRecord',
  'resolveDoiCandidates',
  'resolveZenodoSyncState',
  'settleLiveSyncPlan',
  'normalizeDoi'
].sort();

describe('public API surface', () => {
  it('exports only the curated runtime API from the root package', () => {
    expect(Object.keys(publicApi).sort()).toEqual(expectedRuntimeExports);
  });

  it('does not use wildcard exports from the root package', () => {
    const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(indexSource).not.toMatch(/export\s+\*/);
  });

  it('keeps browser-safe display helpers on a dedicated subpath', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      readonly exports?: Record<string, unknown>;
    };

    expect(packageJson.exports?.['./display']).toEqual({
      types: './dist/display.d.ts',
      import: './dist/display.js'
    });
    expect(Object.keys(displayApi).sort()).toEqual(['buildDoiDisplayLinks']);
    expect(Object.keys(publicApi)).not.toContain('buildDoiDisplayLinks');
    expect(readFileSync(new URL('../display.ts', import.meta.url), 'utf8')).not.toMatch(/zotero/i);
  });
});
