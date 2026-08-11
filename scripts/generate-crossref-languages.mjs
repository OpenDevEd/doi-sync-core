import { readFileSync, writeFileSync } from 'node:fs';

const schemaPath = new URL('../src/__tests__/fixtures/crossref-schema-5.5.0/languages5.5.0.xsd', import.meta.url);
const outputPath = new URL('../src/crossref/languages.ts', import.meta.url);
const schema = readFileSync(schemaPath, 'utf8');
const codes = [...schema.matchAll(/<xsd:enumeration value="([^"]+)"\/>/gu)].map((match) => match[1]);
if (codes.some((code) => !code)) throw new Error('Crossref language schema contains an empty code');
const output = [
	'// Generated from the vendored official Crossref 5.5 language schema. Do not edit.',
	`export const CROSSREF_LANGUAGE_CODES: ReadonlySet<string> = new Set(${JSON.stringify(codes)});`,
	''
].join('\n');

if (process.argv.includes('--check')) {
	if (readFileSync(outputPath, 'utf8') !== output) {
		throw new Error('src/crossref/languages.ts is stale; run npm run crossref:languages:generate');
	}
} else {
	writeFileSync(outputPath, output);
}
