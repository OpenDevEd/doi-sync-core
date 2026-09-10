import { z } from 'zod';

import { normalizeDoi } from '../doi.js';
import { jsonValueSchema } from '../json.js';
import type { JsonObject } from '../json.js';
import { compareCodeUnits } from '../sort.js';

const nonEmptyString = z.string().trim().min(1);
const httpUrl = z.url().refine(
  (value) => value.startsWith('https://') || value.startsWith('http://'),
  { message: 'Expected an HTTP or HTTPS URL' }
);

export interface PublicationCreator {
  readonly type: 'personal' | 'organizational';
  readonly name: string;
  readonly creatorType?: string | undefined;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
  readonly affiliation?: string | undefined;
  readonly orcid?: string | undefined;
}

export interface PublicationMetadata {
  readonly itemType: string;
  readonly title: string;
  readonly publicationDate: string;
  readonly abstract?: string | undefined;
  readonly language?: string | undefined;
  readonly publisher?: string | undefined;
  readonly institution?: string | undefined;
  readonly rights?: string | undefined;
  readonly license?: string | undefined;
  readonly creators: readonly PublicationCreator[];
  readonly tags: readonly string[];
}

/** Provider-ready metadata. Zenodo minting does not have a DOI before publication. */
export interface PublicationProviderMetadata extends PublicationMetadata {
	readonly doi?: string;
}

/** Crossref requires the managed DOI before deposit construction. */
export interface CrossrefDepositMetadata extends PublicationProviderMetadata {
	readonly doi: string;
}

export interface PublicationRecordSnapshot extends PublicationMetadata {
  readonly recordKey: string;
  readonly canonicalRevision: number;
  readonly landingUrl: string;
  readonly fields: JsonObject;
}

export interface PublicationIdentifiers {
  readonly bibliographicDoi?: string | undefined;
  readonly managedCrossrefDoi?: string | undefined;
  readonly zenodoVersionDoi?: string | undefined;
  readonly zenodoConceptDoi?: string | undefined;
}

export const publicationCreatorSchema: z.ZodType<PublicationCreator> = z.object({
  type: z.enum(['personal', 'organizational']),
  name: nonEmptyString,
  creatorType: nonEmptyString.optional(),
  givenName: nonEmptyString.optional(),
  familyName: nonEmptyString.optional(),
  affiliation: nonEmptyString.optional(),
  orcid: nonEmptyString.optional()
}).strict();

const publicationMetadataShape = {
  itemType: nonEmptyString,
  title: nonEmptyString,
  publicationDate: nonEmptyString,
  abstract: nonEmptyString.optional(),
  language: nonEmptyString.optional(),
  publisher: nonEmptyString.optional(),
  institution: nonEmptyString.optional(),
  rights: nonEmptyString.optional(),
  license: nonEmptyString.optional(),
  creators: z.array(publicationCreatorSchema),
  tags: z.array(nonEmptyString)
};

export const publicationMetadataSchema = z.object(publicationMetadataShape).strict() satisfies z.ZodType<PublicationMetadata>;

export const publicationRecordSnapshotSchema = z.object({
  ...publicationMetadataShape,
	recordKey: nonEmptyString,
	canonicalRevision: z.number().int().positive().safe(),
	landingUrl: httpUrl,
	fields: z.record(z.string(), jsonValueSchema)
}).strict() satisfies z.ZodType<PublicationRecordSnapshot>;

const doiSchema = z.string().transform((value, context) => {
  const doi = normalizeDoi(value);
  if (doi) return doi;
  context.addIssue({ code: 'custom', message: 'Expected a valid DOI' });
  return z.NEVER;
});

export const publicationIdentifiersSchema: z.ZodType<PublicationIdentifiers> = z.object({
  bibliographicDoi: doiSchema.optional(),
  managedCrossrefDoi: doiSchema.optional(),
  zenodoVersionDoi: doiSchema.optional(),
  zenodoConceptDoi: doiSchema.optional()
}).strict();

export function parsePublicationRecordSnapshot(input: unknown): PublicationRecordSnapshot {
  const parsed = publicationRecordSnapshotSchema.parse(input);
  return {
    ...parsed,
    tags: [...new Set(parsed.tags)].sort(compareCodeUnits)
  };
}

export function parsePublicationIdentifiers(input: unknown): PublicationIdentifiers {
  return publicationIdentifiersSchema.parse(input);
}
