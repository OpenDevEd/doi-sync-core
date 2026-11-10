import type { JsonValue } from '../hash.js';
import type { JsonObject } from '../json.js';
import { normalizeDoi } from '../doi.js';
import type { PublicationCreator, PublicationProviderMetadata, PublicationRelation } from '../publication/record.js';
import { normalizeZenodoLanguage } from '../publication/languages.js';
import { validateZenodoPublicationRecord } from './publication-mapper.js';
import { ZENODO_LICENSE_IDS } from './licenses.js';
import { mapZenodoResourceType, type ZenodoResourceType } from './resource-mapper.js';

export type DoiPolicy = 'dual' | 'external-crossref';

/**
 * The part of a Zenodo record the package owns, in the InvenioRDM format Zenodo keeps records in
 * (inveniordm.docs.cern.ch/reference/metadata). Its legacy deposit API has no place for most of it.
 */
export interface ZenodoRecordPayload {
  readonly metadata: JsonObject;
  readonly custom_fields: JsonObject;
  /** The DOI Zenodo registers the record under, when it is one we gave it. */
  readonly pids?: JsonObject;
}

/** RORs Zenodo's vocabularies hold. One they lack is refused, so it goes by name. Left out, every ROR is taken as held. */
export interface ZenodoKnownRors {
  readonly affiliations: ReadonlySet<string>;
  readonly funders: ReadonlySet<string>;
}

export interface ZenodoRecordPayloadInput {
  readonly doiPolicy: DoiPolicy;
  readonly metadata: PublicationProviderMetadata;
  /** The record's own page, linked from the description and kept as an identifier. */
  readonly resourceUrl?: string;
  readonly known?: ZenodoKnownRors;
}

/** The metadata keys the package writes. Each is replaced, or removed when the record has nothing for it; the rest are Zenodo's. */
export const ZENODO_MANAGED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'resource_type', 'title', 'publication_date', 'creators', 'description', 'publisher', 'additional_titles',
  'additional_descriptions', 'rights', 'copyright', 'contributors', 'subjects', 'languages', 'dates', 'version',
  'identifiers', 'related_identifiers', 'sizes', 'formats', 'locations', 'funding', 'references'
]);

/** Creator types that make someone a contributor rather than a creator, with Zenodo's role for each. */
const CONTRIBUTOR_ROLES: Readonly<Record<string, string>> = {
  editor: 'editor',
  seriesEditor: 'editor',
  translator: 'other',
  contributor: 'other',
  reviewedAuthor: 'relatedperson',
  commenter: 'other',
  sponsor: 'sponsor',
  producer: 'producer'
};

/** Our relation types as DataCite's, which Zenodo keeps. Data, code and supplements all supplement the work. */
const RELATION_TYPES: Readonly<Record<PublicationRelation['type'], string>> = {
  isSupplementedBy: 'issupplementedby',
  references: 'references',
  hasVersion: 'hasversion',
  isRelatedMaterial: 'issupplementedby'
};

const IDENTIFIER_SCHEMES: Partial<Readonly<Record<PublicationRelation['identifierType'], string>>> = {
  doi: 'doi',
  uri: 'url',
  ark: 'ark',
  handle: 'handle'
};

export function buildZenodoRecordPayload(input: ZenodoRecordPayloadInput): ZenodoRecordPayload {
  const { metadata } = input;
  const resourceType = mapZenodoResourceType(metadata.itemType);
  if (!resourceType) throw new Error(`Zenodo cannot publish Evidence Library item type ${metadata.itemType}`);
  const issues = validateZenodoPublicationRecord(metadata);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('; '));
  const fields = metadata.fields ?? {};
  const field = (name: string) => text(fields[name]);
  const language = metadata.language ? normalizeZenodoLanguage(metadata.language) : undefined;
  const license = metadata.license?.toLowerCase();
  const people = splitCreators(metadata.creators);
  const contributors = [
    ...people.contributors.map(({ creator, role }) => ({ ...creatorEntry(creator, input.known), role: { id: role } })),
    ...(metadata.institution ? [{ person_or_org: { type: 'organizational', name: metadata.institution }, role: { id: 'hostinginstitution' } }] : [])
  ];
  const seriesTitle = field('seriesTitle') ?? field('series');
  const issn = field('ISSN');
  const itemNumber = field('reportNumber') ?? field('number');
  const subjects = unique([...metadata.tags, ...(metadata.subjects ?? [])]);

  const output: Record<string, JsonValue> = {
    resource_type: { id: resourceTypeId(resourceType) },
    title: metadata.title,
    publication_date: metadata.publicationDate,
    creators: people.creators.map((creator) => creatorEntry(creator, input.known)),
    description: withResourceUrlAppendix(metadata.abstract ?? '', input.resourceUrl),
    // DOI registration needs a publisher; the legacy API put Zenodo there itself.
    publisher: metadata.publisher ?? 'Zenodo'
  };
  const optional: Record<string, JsonValue | undefined> = {
    additional_titles: metadata.subtitle ? [{ title: metadata.subtitle, type: { id: 'subtitle' } }] : undefined,
    additional_descriptions: nonEmpty([
      ...(metadata.methods ? [{ description: metadata.methods, type: { id: 'methods' } }] : []),
      ...(seriesTitle ? [{ description: [seriesTitle, issn ? `ISSN ${issn}` : undefined, field('seriesNumber')].filter(Boolean).join(', '), type: { id: 'series-information' } }] : []),
      ...(metadata.rights ? [{ description: metadata.rights, type: { id: 'other' } }] : [])
    ]),
    rights: license && ZENODO_LICENSE_IDS.has(license) ? [{ id: license }] : undefined,
    copyright: metadata.copyright,
    contributors: nonEmpty(contributors),
    subjects: nonEmpty(subjects.map((subject) => ({ subject }))),
    languages: language ? [{ id: language }] : undefined,
    dates: metadata.withdrawnOn ? [{ date: metadata.withdrawnOn, type: { id: 'withdrawn' } }] : undefined,
    version: field('version'),
    identifiers: nonEmpty([
      ...(input.resourceUrl ? [{ identifier: input.resourceUrl, scheme: 'url' }] : []),
      ...(itemNumber ? [{ identifier: itemNumber, scheme: 'other' }] : [])
    ]),
    related_identifiers: nonEmpty([
      ...(metadata.relations ?? []).flatMap((relation) => {
        const scheme = IDENTIFIER_SCHEMES[relation.identifierType];
        const identifier = scheme === 'doi' ? normalizeDoi(relation.identifier) : relation.identifier;
        return scheme && identifier ? [{ identifier, scheme, relation_type: { id: RELATION_TYPES[relation.type] } }] : [];
      }),
      ...(issn && (seriesTitle || field('publicationTitle')) ? [{ identifier: issn, scheme: 'issn', relation_type: { id: 'ispartof' } }] : [])
    ]),
    sizes: metadata.pages ? [`${metadata.pages} ${metadata.pages === 1 ? 'page' : 'pages'}`] : undefined,
    formats: nonEmpty([...(metadata.formats ?? [])]),
    locations: metadata.locations?.length ? { features: metadata.locations.map((location) => ({ place: location.place })) } : undefined,
    funding: nonEmpty((metadata.funding ?? []).flatMap((funding) => {
      const funder = funding.funderRor && (input.known?.funders.has(funding.funderRor) ?? true) ? { id: funding.funderRor } : { name: funding.funderName };
      return funding.awards.length
        ? funding.awards.map((award) => ({ funder, award: { number: award, title: { en: award } } }))
        : [{ funder }];
    })),
    references: nonEmpty((metadata.references ?? []).map((reference) => {
      const doi = normalizeDoi(reference);
      return doi ? { reference: `https://doi.org/${doi}`, identifier: doi, scheme: 'doi' } : { reference };
    }))
  };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) output[key] = value;

  const customFields: Record<string, JsonValue> = {};
  const journal = compact({ title: field('publicationTitle'), issn, volume: field('volume'), issue: field('issue'), pages: field('pages') });
  if (journal && field('publicationTitle')) customFields['journal:journal'] = journal;
  const imprint = compact({
    title: field('bookTitle') ?? field('proceedingsTitle') ?? seriesTitle,
    place: field('place'),
    isbn: field('ISBN'),
    edition: field('edition'),
    pages: field('publicationTitle') ? undefined : field('pages')
  });
  if (imprint) customFields['imprint:imprint'] = imprint;
  if (metadata.itemType === 'ConferencePaper') {
    const meeting = compact({ title: field('conferenceName'), acronym: field('conferenceAcronym'), dates: field('conferenceDate'), place: field('place') });
    if (meeting) customFields['meeting:meeting'] = meeting;
  }
  if (metadata.itemType === 'Thesis') {
    const thesis = compact({ university: metadata.institution ?? metadata.publisher, type: field('thesisType') ?? field('degree') });
    if (thesis) customFields['thesis:thesis'] = thesis;
  }

  if (input.doiPolicy === 'external-crossref' && !metadata.doi) throw new Error('Zenodo external DOI policy requires a DOI');
  return {
    metadata: output,
    custom_fields: customFields,
    ...(input.doiPolicy === 'external-crossref' && metadata.doi ? { pids: { doi: { identifier: metadata.doi, provider: 'external' } } } : {})
  };
}

/** The resource type's ID in Zenodo's vocabulary: `publication-report`, `image-figure`, `dataset`. */
export function resourceTypeId(resourceType: ZenodoResourceType): string {
  if (resourceType.uploadType === 'publication') return `publication-${resourceType.publicationType}`;
  if (resourceType.uploadType === 'image') return `image-${resourceType.imageType}`;
  return resourceType.uploadType;
}

/** Authors are the creators. Editors and the rest are contributors with their role, unless nobody is an author. */
function splitCreators(creators: readonly PublicationCreator[]) {
  const roleOf = (creator: PublicationCreator) => (creator.creatorType ? CONTRIBUTOR_ROLES[creator.creatorType] : undefined);
  const authors = creators.filter((creator) => !roleOf(creator));
  if (authors.length === 0) return { creators, contributors: [] };
  return {
    creators: authors,
    contributors: creators.flatMap((creator) => {
      const role = roleOf(creator);
      return role ? [{ creator, role }] : [];
    })
  };
}

function creatorEntry(creator: PublicationCreator, known: ZenodoKnownRors | undefined): JsonObject {
  const orcid = creator.orcid?.replace(/^https?:\/\/orcid\.org\//iu, '').toUpperCase();
  const person = creator.type === 'personal'
    ? {
        type: 'personal',
        family_name: creator.familyName ?? creator.name,
        ...(creator.givenName ? { given_name: creator.givenName } : {}),
        ...(orcid ? { identifiers: [{ scheme: 'orcid', identifier: orcid }] } : {})
      }
    : { type: 'organizational', name: creator.name, ...(creator.ror ? { identifiers: [{ scheme: 'ror', identifier: creator.ror }] } : {}) };
  const affiliations = (creator.affiliations ?? []).map((affiliation) => (
    // An ID Zenodo knows brings its own name, which replaces any given with it.
    affiliation.ror && (known?.affiliations.has(affiliation.ror) ?? true) ? { id: affiliation.ror } : { name: affiliation.name }
  ));
  return {
    person_or_org: person,
    ...(affiliations.length ? { affiliations } : {}),
    // The person who answers for the work.
    ...(creator.corresponding ? { role: { id: 'contactperson' } } : {})
  };
}

function withResourceUrlAppendix(description: string, resourceUrl: string | undefined): string {
  if (!resourceUrl) return description;
  const escaped = escapeHtml(resourceUrl);
  const appendix = `<p>Available from <a href="${escaped}">${escaped}</a></p>`;
  if (description.includes(appendix)) return description;
  return description ? `${description}\n\n${appendix}` : appendix;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function text(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compact(object: Record<string, string | undefined>): JsonObject | undefined {
  const entries = Object.entries(object).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function nonEmpty<T extends JsonValue>(values: T[]): T[] | undefined {
  return values.length ? values : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
