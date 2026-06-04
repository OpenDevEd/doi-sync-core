import type { FileManifest } from './files.js';
import type { JsonValue } from './hash.js';
import { sha256Hex } from './hash.js';
import { toJsonValue } from './json.js';
import type { CanonicalMetadataSnapshot } from './metadata.js';
import type { CrossrefRelation } from './crossref/xml.js';
import { effectiveZenodoDoiPolicy } from './zenodo/doi-policy.js';
import { buildZenodoWritePayload, type DoiPolicy } from './zenodo/records.js';

export const CROSSREF_PAYLOAD_FORMAT = 'doi-sync-core-crossref-report-paper-1';

export interface BuildSyncPayloadSnapshotsInput {
  readonly metadata: CanonicalMetadataSnapshot;
  readonly fileManifest: FileManifest;
  readonly doiPolicy: DoiPolicy;
  readonly existingZenodoVersionDoi?: string | null | undefined;
  readonly resourceUrl: string;
  readonly crossrefRelation?: CrossrefRelation;
  /** Zotero `zotero://select/...` URL emitted into the legacy Zenodo deposition `related_identifiers` write payload. */
  readonly zoteroSelectUrl?: string;
}

export interface SyncPayloadSnapshots {
  readonly crossrefPayload: JsonValue;
  readonly zenodoPayload: JsonValue;
  readonly fileManifest: JsonValue;
}

export function buildSyncPayloadSnapshots(input: BuildSyncPayloadSnapshotsInput): SyncPayloadSnapshots {
  return {
    crossrefPayload: toJsonValue({
      format: CROSSREF_PAYLOAD_FORMAT,
      metadata: input.metadata,
      resourceUrl: input.resourceUrl,
      ...(input.crossrefRelation ? { relation: input.crossrefRelation } : {})
    }),
    zenodoPayload: toJsonValue(buildZenodoWritePayload({
      doiPolicy: effectiveZenodoDoiPolicy({
        configuredPolicy: input.doiPolicy,
        crossrefDoi: input.metadata.doi,
        existingVersionDoi: input.existingZenodoVersionDoi
      }),
      metadata: input.metadata,
      resourceUrl: input.resourceUrl,
      ...(input.zoteroSelectUrl ? { zoteroSelectUrl: input.zoteroSelectUrl } : {})
    })),
    fileManifest: buildFileManifestSnapshot(input.fileManifest)
  };
}

export function buildFileManifestSnapshot(fileManifest: FileManifest): JsonValue {
  return toJsonValue({
    files: fileManifest.files.map((file) => ({
      zoteroAttachmentKey: file.zoteroAttachmentKey,
      filename: file.filename,
      contentType: file.contentType,
      linkMode: file.linkMode,
      source: file.source,
      zoteroMd5: file.zoteroMd5 ?? null,
      zoteroMtime: file.zoteroMtime ?? null
    }))
  });
}

export function buildFileManifestHash(fileManifest: FileManifest): string {
  return sha256Hex(buildFileManifestSnapshot(fileManifest));
}
