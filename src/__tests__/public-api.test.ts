import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import * as publicApi from '../index.js';

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
  'resolveZenodoSyncState',
  'settleLiveSyncPlan'
].sort();

describe('public API surface', () => {
  it('exports only the curated runtime API from the root package', () => {
    expect(Object.keys(publicApi).sort()).toEqual(expectedRuntimeExports);
  });

  it('does not use wildcard exports from the root package', () => {
    const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(indexSource).not.toMatch(/export\s+\*/);
  });
});
