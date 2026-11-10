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

/** CRediT's contributor roles (credit.niso.org), as Crossref's `credit` vocabulary names them. */
export const CREDIT_ROLES = [
  'conceptualization', 'data-curation', 'formal-analysis', 'funding-acquisition', 'investigation', 'methodology',
  'project-administration', 'resources', 'software', 'supervision', 'validation', 'visualization',
  'writing-original-draft', 'writing-review-editing'
] as const;
export type CreditRole = (typeof CREDIT_ROLES)[number];

/** An organisation a person works at: its name, its ROR ID (the bare 9 characters) and its country (ISO 3166-1 alpha-2). */
export interface PublicationAffiliation {
  readonly name: string;
  readonly ror?: string | undefined;
  readonly country?: string | undefined;
}

export interface PublicationCreator {
  readonly type: 'personal' | 'organizational';
  readonly name: string;
  readonly creatorType?: string | undefined;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
  readonly affiliations?: readonly PublicationAffiliation[] | undefined;
  readonly orcid?: string | undefined;
  /** An organisation's own ROR ID. */
  readonly ror?: string | undefined;
  readonly roles?: readonly CreditRole[] | undefined;
  readonly corresponding?: boolean | undefined;
}

/** A place the work is about: its name, and its country (ISO 3166-1 alpha-2) when it is one. */
export interface PublicationLocation {
  readonly place: string;
  readonly country?: string | undefined;
}

export const PUBLICATION_RELATION_TYPES = ['isSupplementedBy', 'references', 'hasVersion', 'isRelatedMaterial'] as const;
export type PublicationRelationType = (typeof PUBLICATION_RELATION_TYPES)[number];
export const PUBLICATION_IDENTIFIER_TYPES = ['doi', 'uri', 'ark', 'handle', 'uuid', 'other'] as const;
export type PublicationIdentifierType = (typeof PUBLICATION_IDENTIFIER_TYPES)[number];

/** Another work this one points at: its data, code, another version, a supplement. */
export interface PublicationRelation {
  readonly type: PublicationRelationType;
  readonly identifierType: PublicationIdentifierType;
  readonly identifier: string;
  readonly description?: string | undefined;
}

/** One funder of the work, with its identifier in the Crossref Funder Registry (`https://doi.org/10.13039/…`) when known. */
export interface PublicationFunding {
  readonly funderName: string;
  readonly funderIdentifier?: string | undefined;
  /** The funder's ROR ID (the bare 9 characters). */
  readonly funderRor?: string | undefined;
  readonly awards: readonly string[];
}

export interface PublicationMetadata {
  readonly itemType: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly publicationDate: string;
  readonly abstract?: string | undefined;
  readonly language?: string | undefined;
  readonly publisher?: string | undefined;
  readonly institution?: string | undefined;
  readonly rights?: string | undefined;
  readonly license?: string | undefined;
  readonly creators: readonly PublicationCreator[];
  readonly tags: readonly string[];
  readonly funding?: readonly PublicationFunding[] | undefined;
  /** DOIs the work cites. */
  readonly references?: readonly string[] | undefined;
  readonly relations?: readonly PublicationRelation[] | undefined;
  /** Controlled or descriptive subjects beside the free keywords in `tags`: topics, goals. */
  readonly subjects?: readonly string[] | undefined;
  /** How the work was done, in words: its study design. */
  readonly methods?: string | undefined;
  readonly locations?: readonly PublicationLocation[] | undefined;
  /** How many pages the work runs to. */
  readonly pages?: number | undefined;
  /** The media types of its files. */
  readonly formats?: readonly string[] | undefined;
  /** Where its full text can be read, for indexing and similarity checks. */
  readonly fullTextUrl?: string | undefined;
  readonly copyright?: string | undefined;
  /** The day the work was withdrawn (YYYY-MM-DD). */
  readonly withdrawnOn?: string | undefined;
}

/** Provider-ready metadata. Zenodo minting does not have a DOI before publication. */
export interface PublicationProviderMetadata extends PublicationMetadata {
	readonly doi?: string;
	/** The record's type-specific fields, by their Zotero names (journal, book, conference, thesis, series). */
	readonly fields?: JsonObject;
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

const rorSchema = z.string().trim().regex(/^0[a-hj-km-np-tv-z0-9]{6}\d{2}$/u, 'Expected a ROR ID');
const countrySchema = z.string().trim().regex(/^[A-Z]{2}$/u, 'Expected an ISO 3166-1 alpha-2 country code');

const publicationAffiliationSchema: z.ZodType<PublicationAffiliation> = z.object({
  name: nonEmptyString,
  ror: rorSchema.optional(),
  country: countrySchema.optional()
}).strict();

export const publicationCreatorSchema: z.ZodType<PublicationCreator> = z.object({
  type: z.enum(['personal', 'organizational']),
  name: nonEmptyString,
  creatorType: nonEmptyString.optional(),
  givenName: nonEmptyString.optional(),
  familyName: nonEmptyString.optional(),
  affiliations: z.array(publicationAffiliationSchema).optional(),
  orcid: nonEmptyString.optional(),
  ror: rorSchema.optional(),
  roles: z.array(z.enum(CREDIT_ROLES)).optional(),
  corresponding: z.boolean().optional()
}).strict();

const publicationFundingSchema: z.ZodType<PublicationFunding> = z.object({
  funderName: nonEmptyString,
  funderIdentifier: nonEmptyString.optional(),
  funderRor: rorSchema.optional(),
  awards: z.array(nonEmptyString)
}).strict();

const publicationLocationSchema: z.ZodType<PublicationLocation> = z.object({
  place: nonEmptyString,
  country: countrySchema.optional()
}).strict();

const publicationRelationSchema: z.ZodType<PublicationRelation> = z.object({
  type: z.enum(PUBLICATION_RELATION_TYPES),
  identifierType: z.enum(PUBLICATION_IDENTIFIER_TYPES),
  identifier: nonEmptyString,
  description: nonEmptyString.optional()
}).strict();

const publicationMetadataShape = {
  itemType: nonEmptyString,
  title: nonEmptyString,
  subtitle: nonEmptyString.optional(),
  publicationDate: nonEmptyString,
  abstract: nonEmptyString.optional(),
  language: nonEmptyString.optional(),
  publisher: nonEmptyString.optional(),
  institution: nonEmptyString.optional(),
  rights: nonEmptyString.optional(),
  license: nonEmptyString.optional(),
  creators: z.array(publicationCreatorSchema),
  tags: z.array(nonEmptyString),
  funding: z.array(publicationFundingSchema).optional(),
  references: z.array(nonEmptyString).optional(),
  relations: z.array(publicationRelationSchema).optional(),
  subjects: z.array(nonEmptyString).optional(),
  methods: nonEmptyString.optional(),
  locations: z.array(publicationLocationSchema).optional(),
  pages: z.number().int().positive().safe().optional(),
  formats: z.array(nonEmptyString).optional(),
  fullTextUrl: httpUrl.optional(),
  copyright: nonEmptyString.optional(),
  withdrawnOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected YYYY-MM-DD').optional()
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
