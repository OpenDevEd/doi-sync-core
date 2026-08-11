import type { CrossrefRelation } from './crossref/xml.js';
import type { CrossrefMappedRecord } from './crossref/record-mapper.js';
import type { JsonValue } from './hash.js';
import { sha256Hex } from './hash.js';
import { toJsonValue } from './json.js';
import {
	buildPublicationFileManifestSnapshot,
	type PublicationFileManifest
} from './publication/files.js';
import type {
	PublicationIdentifiers,
	PublicationRecordSnapshot
} from './publication/record.js';
import type { ZenodoIdentifierPolicy } from './publication/targets.js';
import { buildZenodoWritePayload } from './zenodo/records.js';
import { buildZenodoProviderMetadata } from './zenodo/publication-mapper.js';

export const CROSSREF_PAYLOAD_FORMAT = 'doi-sync-core-crossref-publication-1';

interface ZenodoPayloadSnapshotInput {
	readonly record: PublicationRecordSnapshot;
	readonly identifiers: PublicationIdentifiers;
}

export interface BuildCrossrefPayloadSnapshotInput {
	readonly record: CrossrefMappedRecord;
	readonly relation?: CrossrefRelation;
}

export interface BuildZenodoPayloadSnapshotInput extends ZenodoPayloadSnapshotInput {
	readonly identifierPolicy: ZenodoIdentifierPolicy;
}

export interface PublicationPayloadSnapshots {
	readonly crossrefPayload?: JsonValue;
	readonly zenodoPayload?: JsonValue;
	readonly fileManifest: JsonValue;
}

export function buildCrossrefPayloadSnapshot(input: BuildCrossrefPayloadSnapshotInput): JsonValue {
	return toJsonValue({
		format: CROSSREF_PAYLOAD_FORMAT,
		record: input.record,
		...(input.relation ? { relation: input.relation } : {})
	});
}

export function buildZenodoPayloadSnapshot(input: BuildZenodoPayloadSnapshotInput): JsonValue {
	const payload = buildZenodoWritePayload({
		doiPolicy: input.identifierPolicy === 'reuse-crossref' ? 'external-crossref' : 'dual',
		metadata: buildZenodoProviderMetadata({
			record: input.record,
			identifiers: input.identifiers,
			identifierPolicy: input.identifierPolicy
		}),
		resourceUrl: input.record.landingUrl
	});
	return toJsonValue(payload);
}

export function buildPublicationPayloadHash(snapshot: JsonValue): string {
	return sha256Hex(snapshot);
}

export function buildPublicationPayloadSnapshots(input: {
	readonly crossref?: BuildCrossrefPayloadSnapshotInput;
	readonly zenodo?: BuildZenodoPayloadSnapshotInput;
	readonly files: PublicationFileManifest;
}): PublicationPayloadSnapshots {
	return {
		...(input.crossref ? { crossrefPayload: buildCrossrefPayloadSnapshot(input.crossref) } : {}),
		...(input.zenodo ? { zenodoPayload: buildZenodoPayloadSnapshot(input.zenodo) } : {}),
		fileManifest: buildPublicationFileManifestSnapshot(input.files)
	};
}
