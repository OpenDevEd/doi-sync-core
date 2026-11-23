/**
 * The identifier services a record can be registered with, and what each can do. Hosts choose services by these
 * facts rather than by name, so a new service is one more entry here and one more client.
 */
export const IDENTIFIER_SERVICES = {
  crossref: {
    name: 'Crossref',
    identifier: 'doi',
    /** Its DOI is chosen by the depositor, so it can be printed on the work before it is registered. */
    reservesBeforeReview: true,
    acceptsExistingDoi: false,
    archivesFile: false
  },
  zenodo: {
    name: 'Zenodo',
    identifier: 'doi',
    // A draft deposit reserves its DOI; a host decides whether to make the draft before review.
    reservesBeforeReview: true,
    acceptsExistingDoi: true,
    archivesFile: true
  },
  docid: {
    name: 'DOCiD',
    identifier: 'handle',
    // A mint is a real, permanent Handle at once: a host may mint before review only if it accepts retiring the
    // Handles of works it then declines.
    reservesBeforeReview: false,
    acceptsExistingDoi: true,
    archivesFile: true
  }
} as const satisfies Record<string, IdentifierService>;

export interface IdentifierService {
  readonly name: string;
  readonly identifier: 'doi' | 'handle';
  readonly reservesBeforeReview: boolean;
  readonly acceptsExistingDoi: boolean;
  readonly archivesFile: boolean;
}

export type IdentifierServiceId = keyof typeof IDENTIFIER_SERVICES;
export const IDENTIFIER_SERVICE_IDS = Object.keys(IDENTIFIER_SERVICES) as IdentifierServiceId[];
