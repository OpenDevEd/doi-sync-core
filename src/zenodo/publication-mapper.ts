import type {
	PublicationIdentifiers,
	PublicationProviderMetadata,
	PublicationRecordSnapshot
} from '../publication/record.js';
import { zenodoReusedDoi, type ZenodoIdentifierPolicy } from '../publication/targets.js';
import { ZENODO_LANGUAGE_CODES } from '../publication/languages.js';
import { ZENODO_LICENSE_IDS } from './licenses.js';
import { mapZenodoResourceType } from './resource-mapper.js';

export interface ZenodoRecordValidationIssue {
	readonly code: 'UNSUPPORTED_ITEM_TYPE' | 'INVALID_FIELD_VALUE';
	readonly path: string;
	readonly message: string;
}

export function validateZenodoPublicationRecord(
	record: PublicationRecordSnapshot
): readonly ZenodoRecordValidationIssue[] {
	const issues: ZenodoRecordValidationIssue[] = [];
	if (!mapZenodoResourceType(record.itemType)) {
		issues.push({
			code: 'UNSUPPORTED_ITEM_TYPE', path: 'itemType',
			message: `Zenodo does not support Evidence Library item type ${record.itemType}`
		});
	}
	if (!isRealIsoDate(record.publicationDate)) {
		issues.push({
			code: 'INVALID_FIELD_VALUE', path: 'publicationDate',
			message: 'Zenodo publication date must be a real date in YYYY-MM-DD format'
		});
	}
	if (!record.abstract) {
		issues.push({
			code: 'INVALID_FIELD_VALUE', path: 'abstract',
			message: 'Zenodo requires an abstract or description'
		});
	}
	if (record.creators.length === 0) {
		issues.push({
			code: 'INVALID_FIELD_VALUE', path: 'creators',
			message: 'Zenodo requires at least one creator'
		});
	}
	if (record.language && !ZENODO_LANGUAGE_CODES.has(record.language.toLowerCase())) {
		issues.push({
			code: 'INVALID_FIELD_VALUE', path: 'language',
			message: 'Zenodo language must be an ISO 639-2 or ISO 639-3 three-letter code'
		});
	}
	if (record.license && !ZENODO_LICENSE_IDS.has(record.license.toLowerCase())) {
		issues.push({
			code: 'INVALID_FIELD_VALUE', path: 'license',
			message: `Zenodo license ${record.license} is not in the supported license vocabulary`
		});
	}
	return issues;
}

export function buildZenodoProviderMetadata(input: {
	readonly record: PublicationRecordSnapshot;
	readonly identifiers: PublicationIdentifiers;
	readonly identifierPolicy: ZenodoIdentifierPolicy;
}): PublicationProviderMetadata {
	const issues = validateZenodoPublicationRecord(input.record);
	if (issues.length > 0) throw new Error(`Zenodo validation failed: ${issues.map((issue) => issue.path).join(', ')}`);
	const { record } = input;
	const reusedDoi = zenodoReusedDoi(input.identifierPolicy, input.identifiers);
	return {
		itemType: record.itemType,
		title: record.title,
		publicationDate: record.publicationDate,
		...(record.abstract ? { abstract: record.abstract } : {}),
		...(record.language ? { language: record.language.toLowerCase() } : {}),
		...(record.publisher ? { publisher: record.publisher } : {}),
		...(record.institution ? { institution: record.institution } : {}),
		...(record.rights ? { rights: record.rights } : {}),
		...(record.license ? { license: record.license.toLowerCase() } : {}),
		creators: record.creators,
		tags: record.tags,
		...(reusedDoi ? { doi: reusedDoi } : {})
	};
}

function isRealIsoDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match?.[1] || !match[2] || !match[3]) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	return month >= 1
		&& month <= 12
		&& day >= 1
		&& day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
