import { iso6393 } from 'iso-639-3';

const ZENODO_LANGUAGE_CODES: ReadonlySet<string> = new Set(
	iso6393.flatMap((language) => [
		language.iso6393,
		...(language.iso6392B ? [language.iso6392B] : []),
		...(language.iso6392T ? [language.iso6392T] : [])
	])
);

const ISO_639_1_TO_3 = new Map(
	iso6393.flatMap(language => language.iso6391 ? [[language.iso6391, language.iso6393] as const] : [])
);

export function normalizeZenodoLanguage(value: string): string | undefined {
	const code = value.trim().toLowerCase();
	return ZENODO_LANGUAGE_CODES.has(code) ? code : ISO_639_1_TO_3.get(code);
}
