import { z } from 'zod';

import type { CrossrefEnvironment } from '../crossref/deposit.js';
import type { ZenodoProviderEnvironment } from '../zenodo/journal.js';

export type CrossrefTargetPolicy =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly environment: CrossrefEnvironment };

/**
 * How Zenodo gets its DOI:
 * - `reuse-crossref`: the DOI this library registered with Crossref.
 * - `reuse-external`: the DOI the record already had from elsewhere; nothing is registered.
 * - `mint-zenodo`: Zenodo mints its own DOI.
 */
export type ZenodoIdentifierPolicy = 'reuse-crossref' | 'reuse-external' | 'mint-zenodo';

/** The DOI Zenodo must publish under for a reuse policy, or undefined when Zenodo mints. */
export function zenodoReusedDoi(
  identifierPolicy: ZenodoIdentifierPolicy,
  identifiers: { readonly managedCrossrefDoi?: string | undefined; readonly bibliographicDoi?: string | undefined }
): string | undefined {
  if (identifierPolicy === 'reuse-crossref') return identifiers.managedCrossrefDoi;
  if (identifierPolicy === 'reuse-external') return identifiers.bibliographicDoi;
  return undefined;
}

export type ZenodoTargetPolicy =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly environment: ZenodoProviderEnvironment;
      readonly identifierPolicy: ZenodoIdentifierPolicy;
    };

export interface PublicationTargetPolicy {
  readonly crossref: CrossrefTargetPolicy;
  readonly zenodo: ZenodoTargetPolicy;
}

const crossrefTargetPolicySchema: z.ZodType<CrossrefTargetPolicy> = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({ enabled: z.literal(true), environment: z.enum(['test', 'production']) }).strict()
]);

const zenodoTargetPolicySchema: z.ZodType<ZenodoTargetPolicy> = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    environment: z.enum(['sandbox', 'production']),
    identifierPolicy: z.enum(['reuse-crossref', 'reuse-external', 'mint-zenodo'])
  }).strict()
]);

export const publicationTargetPolicySchema: z.ZodType<PublicationTargetPolicy> = z.object({
  crossref: crossrefTargetPolicySchema,
  zenodo: zenodoTargetPolicySchema
}).strict().superRefine((policy, context) => {
  if (
    policy.zenodo.enabled
    && policy.zenodo.identifierPolicy === 'reuse-crossref'
    && !policy.crossref.enabled
  ) {
    context.addIssue({
      code: 'custom',
      path: ['zenodo', 'identifierPolicy'],
      message: 'Zenodo reuse-crossref requires Crossref to be enabled'
    });
  }
});

export function parsePublicationTargetPolicy(input: unknown): PublicationTargetPolicy {
  return publicationTargetPolicySchema.parse(input);
}
