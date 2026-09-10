// Browser-safe metadata projection and validation. Provider clients stay in the root export.
export * from './publication/record.js';
export { jsonValueSchema, type JsonObject } from './json.js';
export { validateCrossrefPublicationRecord } from './crossref/record-mapper.js';
export { validateZenodoPublicationRecord } from './zenodo/publication-mapper.js';
