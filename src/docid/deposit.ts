/**
 * A record as DOCiD's deposit takes it (`POST /api/v1/publications/publish`, multipart): the Africa PID Alliance's
 * registry, which gives each record a Handle under 20.500.14351. It is made from the same record Crossref and Zenodo
 * are sent. Field names are DOCiD's own, read from its source (Africa-PID-Alliance/DOCiD `backend/app/routes/publications.py`).
 */
import type { FunderType, PublicationAffiliation, PublicationProviderMetadata } from '../publication/record.js';

// Also its own entry point (`@opendeved/doi-sync-core/docid`), for code that can't load the package root's Node modules: a
// browser, or a server runtime without Node.
export { FUNDER_TYPES, type FunderType } from '../publication/record.js';

/** One entry of a DOCiD list: its id, and its name as DOCiD shows it. */
export interface DocidOption {
  readonly id: number;
  readonly name: string;
}

/**
 * DOCiD's lists as the depositing account reads them (`get-list-resource-types`, `-publication-types`,
 * `-funder-types`). Its ids differ between its environments, so every type is found by its name, as DOCiD's own
 * migrations do. The resource types are only the ones the account may use.
 */
export interface DocidLists {
  readonly resourceTypes: readonly DocidOption[];
  readonly publicationTypes: readonly DocidOption[];
  readonly funderTypes: readonly DocidOption[];
}

export interface DocidFile {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface DocidDepositOptions {
  /** The Handle minted for this record before the deposit (`DocidApiClient.mint`). */
  readonly docid: string;
  readonly lists: DocidLists;
  /** ROR's type of each organisation the record names ("education", "funder"…), by ROR ID. DOCiD keeps it. */
  readonly organizationTypes?: Readonly<Record<string, string>> | undefined;
  readonly file?: DocidFile | undefined;
  readonly poster?: DocidFile | undefined;
}

export interface DocidDeposit {
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly files: ReadonlyArray<readonly [string, DocidFile]>;
}

/** DOCiD's creator role id for an author (`get-list-creators-roles`). */
export const DOCID_AUTHOR_ROLE = '8';

const named = (options: readonly DocidOption[], name: string) => options.find((option) => option.name.trim().toLowerCase() === name.toLowerCase());

/**
 * The resource type DOCiD files a record of this kind under, among the ones the account may use: a book as a Book, and
 * everything else, or a book where Book isn't allowed, as Manuscripts. These are the two DOCiD allows its Publisher
 * accounts; none of its others (patents, projects, theses, heritage) is a kind of publication.
 */
export function docidResourceType(itemType: string, resourceTypes: readonly DocidOption[]): DocidOption | undefined {
  return (itemType === 'Book' ? named(resourceTypes, 'Book') : undefined) ?? named(resourceTypes, 'Manuscripts');
}

/** DOCiD's publication type for the file, by the record's kind. Kinds it has no type for are monographs: a work of its own. */
const PUBLICATION_TYPE: Readonly<Record<string, string>> = {
  JournalArticle: 'Article',
  BookSection: 'Book Chapter',
  ConferencePaper: 'Proceeding',
  Preprint: 'Preprint',
  Book: 'Book'
};

const FUNDER_TYPE: Readonly<Record<FunderType, string>> = { grantor: 'Grantor', investor: 'Investor', corporation: 'Corporation' };

/** Splits "Given Family" when a person came with one name only. */
function nameParts(name: string): { readonly given: string; readonly family: string } {
  const words = name.trim().split(/\s+/);
  return { given: words.slice(0, -1).join(' '), family: words.at(-1) ?? name };
}

/**
 * The deposit of a record under its Handle. Its authors are its creators, as DOCiD has no role for anyone else who
 * worked on it; a body that wrote it goes under its name whole. Its file is described by the record's kind, and each
 * funder by its own type, a grantor where it has none.
 */
export function buildDocidDeposit(record: PublicationProviderMetadata, options: DocidDepositOptions): DocidDeposit {
  const title = record.title.trim();
  const resourceType = docidResourceType(record.itemType, options.lists.resourceTypes);
  if (!resourceType) throw new Error('This DOCiD account may not file records as Manuscripts or Book.');
  const fields: Array<readonly [string, string]> = [
    ['documentDocid', options.docid],
    ['documentTitle', title],
    // DOCiD refuses a deposit without a description.
    ['documentDescription', record.abstract?.trim() || title],
    ['resourceType', String(resourceType.id)]
  ];
  if (record.doi) fields.push(['doi', record.doi]);

  const organizations = new Map<string, PublicationAffiliation>();
  const authors = record.creators.filter((creator) => (creator.creatorType ?? 'author') === 'author');
  authors.forEach((creator, index) => {
    const { given, family } =
      creator.type === 'organizational'
        ? { given: '', family: creator.name.trim() }
        : creator.familyName
          ? { given: creator.givenName ?? '', family: creator.familyName }
          : nameParts(creator.name);
    const at = `creators[${index}]`;
    // DOCiD reads creators until the first without a family name.
    fields.push([`${at}[family_name]`, family], [`${at}[given_name]`, given], [`${at}[role]`, DOCID_AUTHOR_ROLE]);
    if (creator.orcid) fields.push([`${at}[identifier]`, 'orcid'], [`${at}[orcid]`, creator.orcid]);
    const first = creator.affiliations?.[0];
    if (first) fields.push([`${at}[affiliation]`, first.name]);
    for (const affiliation of creator.affiliations ?? []) {
      const key = affiliation.ror ?? affiliation.name;
      if (!organizations.has(key)) organizations.set(key, affiliation);
    }
  });

  // DOCiD reads each list of organizations from index 0 until a gap, so each prefix counts on its own.
  const counts = { organization: 0, organizationRor: 0 };
  for (const affiliation of organizations.values()) {
    const prefix = affiliation.ror ? 'organizationRor' : 'organization';
    const at = `${prefix}[${counts[prefix]++}]`;
    // DOCiD stores every organisation's type in a column that can't be null: empty when ROR gives none, as its own form sends.
    const type = (affiliation.ror && options.organizationTypes?.[affiliation.ror]) || '';
    fields.push([`${at}[name]`, affiliation.name], [`${at}[type]`, type]);
    if (affiliation.country) fields.push([`${at}[country]`, affiliation.country]);
    if (affiliation.ror) fields.push([`${at}[ror_id]`, affiliation.ror]);
  }

  (record.funding ?? []).forEach((funder, index) => {
    const name = FUNDER_TYPE[funder.funderType ?? 'grantor'];
    const type = named(options.lists.funderTypes, name);
    if (!type) throw new Error(`DOCiD has no funder type named ${name}.`);
    const at = `funders[${index}]`;
    fields.push([`${at}[name]`, funder.funderName], [`${at}[type]`, String(type.id)]);
    if (funder.funderRor) fields.push([`${at}[ror_id]`, funder.funderRor]);
  });

  const files: Array<readonly [string, DocidFile]> = [];
  if (options.file) {
    const name = PUBLICATION_TYPE[record.itemType] ?? 'Monograph';
    const type = named(options.lists.publicationTypes, name);
    if (!type) throw new Error(`DOCiD has no publication type named ${name}.`);
    fields.push(
      ['filesPublications[0][title]', title],
      ['filesPublications[0][description]', 'Full text'],
      ['filesPublications[0][publication_type]', String(type.id)],
      ['filesPublications[0][file_type]', options.file.contentType]
    );
    files.push(['filesPublications_0_file', options.file]);
  }
  if (options.poster) files.push(['publicationPoster', options.poster]);
  return { fields, files };
}
