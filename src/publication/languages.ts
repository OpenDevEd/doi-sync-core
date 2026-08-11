import { iso6393 } from 'iso-639-3';

export const ZENODO_LANGUAGE_CODES: ReadonlySet<string> = new Set(
	iso6393.flatMap((language) => [
		language.iso6393,
		...(language.iso6392B ? [language.iso6392B] : []),
		...(language.iso6392T ? [language.iso6392T] : [])
	])
);
