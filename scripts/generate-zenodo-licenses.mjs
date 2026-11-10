import { writeFileSync } from 'node:fs';

const endpoint = 'https://zenodo.org/api/vocabularies/licenses?size=1000&sort=title';
const response = await fetch(endpoint, {
	headers: { Accept: 'application/vnd.inveniordm.v1+json', 'User-Agent': 'doi-sync-core license generator (+https://github.com/OpenDevEd/doi-sync-core)' }
});
if (!response.ok) throw new Error(`Zenodo license vocabulary request failed with HTTP ${response.status}`);
const body = await response.json();
const hits = body?.hits?.hits;
const total = body?.hits?.total;
if (!Array.isArray(hits) || !Number.isSafeInteger(total) || hits.length !== total) {
	throw new Error('Zenodo license vocabulary response is incomplete');
}
const ids = hits.map((entry) => entry?.id);
if (ids.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
	throw new Error('Zenodo license vocabulary contains an invalid identifier');
}
const sortedIds = [...new Set(ids)].sort();
if (sortedIds.length !== total) throw new Error('Zenodo license vocabulary contains duplicate identifiers');
// Each licence's own address, where the vocabulary gives one: Crossref's license_ref is that address.
const urls = Object.fromEntries(hits
	.map((entry) => [entry.id, entry?.props?.url])
	.filter(([, url]) => typeof url === 'string' && /^https?:\/\//.test(url))
	.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const output = [
	'// Generated from https://zenodo.org/api/vocabularies/licenses. Do not edit.',
	`export const ZENODO_LICENSE_IDS: ReadonlySet<string> = new Set(${JSON.stringify(sortedIds)});`,
	`/** Each licence's address, by its Zenodo ID, where the vocabulary gives one. */`,
	`export const ZENODO_LICENSE_URLS: Readonly<Record<string, string>> = ${JSON.stringify(urls)};`,
	''
].join('\n');
writeFileSync(new URL('../src/zenodo/licenses.ts', import.meta.url), output);
