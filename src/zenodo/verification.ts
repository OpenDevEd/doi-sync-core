import { asBoolean, asRecord, asString } from '../guards.js';
import { stableJson, type JsonValue } from '../hash.js';
import { asJsonObject, toJsonValue } from '../json.js';
import { compareCodeUnits } from '../sort.js';
import type { ZenodoLegacyDepositionPayload } from './records.js';

const MANAGED_METADATA_KEYS = [
	'access_right',
	'contributors',
	'creators',
	'description',
	'doi',
	'image_type',
	'imprint_publisher',
	'keywords',
	'language',
	'license',
	'notes',
	'publication_date',
	'publication_type',
	'thesis_university',
	'title',
	'upload_type'
] as const;

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

export function verifyZenodoLegacyDepositionState(input: {
	readonly response: unknown;
	readonly expectedPayload: ZenodoLegacyDepositionPayload;
	readonly expectedFiles: readonly ZenodoExpectedPublishedFile[];
}): ZenodoPublishedStateVerification {
	const deposition = asRecord(input.response);
	if (!deposition) throw new Error('Expected Zenodo deposition response object');
	if (asBoolean(deposition['submitted']) !== true || asString(deposition['state']) !== 'done') {
		throw new Error('Expected a published Zenodo deposition with submitted=true and state=done');
	}
	const rawMetadata = asRecord(deposition['metadata']);
	if (!rawMetadata) throw new Error('Expected Zenodo deposition metadata object');
	const metadata = asJsonObject(toJsonValue(rawMetadata));
	if (!metadata) throw new Error('Expected Zenodo deposition metadata object');
	const metadataReasons = managedMetadataDifferences(
		metadata,
		input.expectedPayload.metadata
	);
	const fileReasons = publishedFileDifferences(
		parseZenodoLegacyDepositionFiles(deposition['files']),
		input.expectedFiles
	);
	return metadataReasons.length === 0 && fileReasons.length === 0
		? { status: 'matched' }
		: { status: 'drifted', metadataReasons, fileReasons };
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

function managedMetadataDifferences(
	observed: Readonly<Record<string, JsonValue>>,
	expected: Readonly<Record<string, JsonValue>>
): readonly string[] {
	return MANAGED_METADATA_KEYS.flatMap((key) => {
		if (key === 'doi' && expected[key] === undefined) return [];
		const observedValue = normalizeManagedMetadataValue(key, observed[key]);
		const expectedValue = normalizeManagedMetadataValue(key, expected[key]);
		return stableJson(observedValue) === stableJson(expectedValue)
			? []
			: [`metadata.${key}`];
	}).sort(compareCodeUnits);
}

function normalizeManagedMetadataValue(
	key: typeof MANAGED_METADATA_KEYS[number],
	value: JsonValue | undefined
): JsonValue | undefined {
	if (key === 'contributors') {
		if (!Array.isArray(value)) return undefined;
		const hostingInstitutions = value.filter((entry) => (
			asString(asRecord(entry)?.['type']) === 'HostingInstitution'
		));
		return hostingInstitutions.length > 0 ? hostingInstitutions : undefined;
	}
	if (key === 'keywords' && Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === 'string')
			.sort(compareCodeUnits);
	}
	return value;
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
