import { asBoolean, asRecord, asString } from '../guards.js';
import { stableJson, type JsonValue } from '../hash.js';
import { asJsonObject, toJsonValue, type JsonObject } from '../json.js';
import { compareCodeUnits } from '../sort.js';
import type { ZenodoRecordPayload } from './rdm-payload.js';

export interface ZenodoExpectedPublishedFile {
	readonly filename: string;
	readonly size: number;
	readonly md5: string;
}

export interface ZenodoLegacyDepositionFile {
	readonly id: string;
	readonly filename: string;
	readonly size?: number;
	readonly md5?: string;
}

export type ZenodoPublishedStateVerification =
	| { readonly status: 'matched' }
	| {
		readonly status: 'drifted';
		readonly metadataReasons: readonly string[];
		readonly fileReasons: readonly string[];
	};

/**
 * Whether a published record holds what was written: the deposition for its state and files, the record in the
 * InvenioRDM format for its metadata. Zenodo fills in what it knows about a vocabulary entry (a ROR's name, a
 * licence's title), so each written value is looked for in what Zenodo holds, not compared with all of it.
 */
export function verifyZenodoRecordState(input: {
	readonly deposition: unknown;
	readonly record: unknown;
	readonly expectedPayload: ZenodoRecordPayload;
	readonly expectedFiles: readonly ZenodoExpectedPublishedFile[];
}): ZenodoPublishedStateVerification {
	const deposition = asRecord(input.deposition);
	if (!deposition) throw new Error('Expected Zenodo deposition response object');
	if (asBoolean(deposition['submitted']) !== true || asString(deposition['state']) !== 'done') {
		throw new Error('Expected a published Zenodo deposition with submitted=true and state=done');
	}
	const record = asJsonObject(toJsonValue(asRecord(input.record) ?? null));
	if (!record) throw new Error('Expected Zenodo record object');
	const metadataReasons = [
		...differences(input.expectedPayload.metadata, record['metadata'], 'metadata'),
		...differences(input.expectedPayload.custom_fields, record['custom_fields'], 'custom_fields'),
		...(input.expectedPayload.pids ? differences(input.expectedPayload.pids, record['pids'], 'pids') : [])
	].sort(compareCodeUnits);
	const fileReasons = publishedFileDifferences(
		parseZenodoLegacyDepositionFiles(deposition['files']),
		input.expectedFiles
	);
	return metadataReasons.length === 0 && fileReasons.length === 0
		? { status: 'matched' }
		: { status: 'drifted', metadataReasons, fileReasons };
}

/** Where `held` lacks what `wrote` gave: each key written, each list entry in order, each text with its spaces evened out. */
function differences(wrote: JsonValue | undefined, held: JsonValue | undefined, path: string): readonly string[] {
	if (Array.isArray(wrote)) {
		if (!Array.isArray(held) || held.length !== wrote.length) return [path];
		const list = held as readonly JsonValue[];
		return (wrote as readonly JsonValue[]).flatMap((entry, index) => differences(entry, list[index], `${path}.${index}`)).length ? [path] : [];
	}
	if (wrote && typeof wrote === 'object') {
		if (!held || typeof held !== 'object' || Array.isArray(held)) return [path];
		return Object.entries(wrote).flatMap(([key, entry]) => differences(entry, (held as JsonObject)[key], `${path}.${key}`));
	}
	if (typeof wrote === 'string' && typeof held === 'string') return wrote.replace(/\s+/gu, ' ').trim() === held.replace(/\s+/gu, ' ').trim() ? [] : [path];
	return stableJson(wrote ?? null) === stableJson(held ?? null) ? [] : [path];
}

export function parseZenodoLegacyDepositionFiles(response: unknown): readonly ZenodoLegacyDepositionFile[] {
	if (!Array.isArray(response)) throw new Error('Expected Zenodo deposition files array');
	return response.map((entry) => {
		const file = asRecord(entry);
		const id = asString(file?.['id']);
		if (!id) throw new Error('Expected Zenodo deposition file id');
		const filename = asString(file?.['filename']) ?? asString(file?.['name']);
		if (!filename) throw new Error('Expected Zenodo deposition file filename');
		const rawSize = file?.['filesize'] ?? file?.['size'];
		const md5 = normalizeMd5(asString(file?.['checksum']));
		return {
			id,
			filename,
			...(typeof rawSize === 'number' && Number.isSafeInteger(rawSize) && rawSize >= 0
				? { size: rawSize }
				: {}),
			...(md5 ? { md5 } : {})
		};
	});
}

function publishedFileDifferences(
	observedFiles: readonly ZenodoLegacyDepositionFile[],
	expectedFiles: readonly ZenodoExpectedPublishedFile[]
): readonly string[] {
	const expectedByName = new Map(expectedFiles.map((file) => {
		const filename = file.filename.trim();
		const md5 = normalizeMd5(file.md5);
		if (!filename) throw new Error('Expected Zenodo filename must not be empty');
		if (!Number.isSafeInteger(file.size) || file.size < 0) {
			throw new Error(`Expected Zenodo file ${filename} has an invalid size`);
		}
		if (!md5) throw new Error(`Expected Zenodo file ${filename} has an invalid MD5`);
		return [filename, { size: file.size, md5 }] as const;
	}));
	if (expectedByName.size !== expectedFiles.length) {
		throw new Error('Expected Zenodo files contain duplicate filenames');
	}

	const observedByName = new Map<string, { size?: number; md5?: string }>();
	for (const file of observedFiles) {
		if (observedByName.has(file.filename)) {
			throw new Error(`Zenodo deposition contains duplicate filename ${file.filename}`);
		}
		if (file.size === undefined || file.md5 === undefined) {
			throw new Error(`Published Zenodo file ${file.filename} is missing filesize or MD5 checksum`);
		}
		observedByName.set(file.filename, {
			size: file.size,
			md5: file.md5
		});
	}

	const reasons: string[] = [];
	for (const [filename, expected] of [...expectedByName].sort(([left], [right]) => compareCodeUnits(left, right))) {
		const observed = observedByName.get(filename);
		if (!observed) {
			reasons.push(`files.${filename}.missing`);
			continue;
		}
		if (observed.md5 !== expected.md5) reasons.push(`files.${filename}.md5`);
		if (observed.size !== expected.size) reasons.push(`files.${filename}.size`);
	}
	for (const filename of [...observedByName.keys()].sort(compareCodeUnits)) {
		if (!expectedByName.has(filename)) reasons.push(`files.${filename}.unexpected`);
	}
	return reasons;
}

function normalizeMd5(value: string | null | undefined): string | undefined {
	const normalized = value?.trim().toLowerCase().replace(/^md5:/u, '');
	return normalized && /^[0-9a-f]{32}$/u.test(normalized) ? normalized : undefined;
}
