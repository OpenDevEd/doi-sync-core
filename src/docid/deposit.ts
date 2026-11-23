/**
 * A record as DOCiD's deposit takes it (`POST /api/v1/publications/publish`, multipart): the Africa PID Alliance's
 * registry, which gives each record a Handle under 20.500.14351. Field names are DOCiD's own, read from its source
 * (Africa-PID-Alliance/DOCiD `backend/app/routes/publications.py`).
 */

export interface DocidAffiliation {
  readonly name: string;
  readonly ror?: string | undefined;
  /** ISO 3166-1 alpha-2. */
  readonly country?: string | undefined;
}

export interface DocidCreator {
  readonly name: string;
  readonly givenName?: string | undefined;
  readonly familyName?: string | undefined;
  readonly orcid?: string | undefined;
  readonly affiliations?: readonly DocidAffiliation[] | undefined;
}

export interface DocidFunder {
  readonly funderName: string;
  readonly funderRor?: string | undefined;
}

export interface DocidRecordInput {
  readonly title: string;
  readonly abstract?: string | undefined;
  readonly doi?: string | undefined;
  readonly creators: readonly DocidCreator[];
  readonly funding?: readonly DocidFunder[] | undefined;
}

export interface DocidFile {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface DocidDepositOptions {
  /** The Handle minted for this record before the deposit (`DocidApiClient.mint`). */
  readonly docid: string;
  /** DOCiD's resource type id (`get-list-resource-types`), which the depositing account must be allowed. */
  readonly resourceTypeId: number;
  /** DOCiD's publication type id for the file (`get-list-publication-types`); needed with a file. */
  readonly publicationTypeId?: number | undefined;
  /** DOCiD's funder type id (`get-list-funder-types`), which every funder needs. */
  readonly funderTypeId?: number | undefined;
  readonly file?: DocidFile | undefined;
  readonly poster?: DocidFile | undefined;
}

export interface DocidDeposit {
  readonly fields: ReadonlyArray<readonly [string, string]>;
  readonly files: ReadonlyArray<readonly [string, DocidFile]>;
}

/** DOCiD's creator role id for an author (`get-list-creators-roles`). */
export const DOCID_AUTHOR_ROLE = '8';

/** Splits "Given Family" when a creator came with one name only. */
function nameParts(creator: DocidCreator): { readonly given: string; readonly family: string } {
  if (creator.familyName) return { given: creator.givenName ?? '', family: creator.familyName };
  const words = creator.name.trim().split(/\s+/);
  return { given: words.slice(0, -1).join(' '), family: words.at(-1) ?? creator.name };
}

export function buildDocidDeposit(record: DocidRecordInput, options: DocidDepositOptions): DocidDeposit {
  const title = record.title.trim();
  const fields: Array<readonly [string, string]> = [
    ['documentDocid', options.docid],
    ['documentTitle', title],
    // DOCiD refuses a deposit without a description.
    ['documentDescription', record.abstract?.trim() || title],
    ['resourceType', String(options.resourceTypeId)]
  ];
  if (record.doi) fields.push(['doi', record.doi]);

  const organizations = new Map<string, DocidAffiliation>();
  record.creators.forEach((creator, index) => {
    const { given, family } = nameParts(creator);
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
    fields.push([`${at}[name]`, affiliation.name]);
    if (affiliation.country) fields.push([`${at}[country]`, affiliation.country]);
    if (affiliation.ror) fields.push([`${at}[ror_id]`, affiliation.ror]);
  }

  const funding = record.funding ?? [];
  if (funding.length && options.funderTypeId === undefined) throw new Error('DOCiD needs a funder type for every funder: give funderTypeId.');
  funding.forEach((funder, index) => {
    const at = `funders[${index}]`;
    fields.push([`${at}[name]`, funder.funderName], [`${at}[type]`, String(options.funderTypeId)]);
    if (funder.funderRor) fields.push([`${at}[ror_id]`, funder.funderRor]);
  });

  const files: Array<readonly [string, DocidFile]> = [];
  if (options.file) {
    if (options.publicationTypeId === undefined) throw new Error('DOCiD needs a publication type for a file: give publicationTypeId.');
    fields.push(
      ['filesPublications[0][title]', title],
      ['filesPublications[0][description]', 'Full text'],
      ['filesPublications[0][publication_type]', String(options.publicationTypeId)],
      ['filesPublications[0][file_type]', options.file.contentType]
    );
    files.push(['filesPublications_0_file', options.file]);
  }
  if (options.poster) files.push(['publicationPoster', options.poster]);
  return { fields, files };
}
