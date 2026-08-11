import { z } from 'zod';

import type { CrossrefEnvironment } from '../crossref/deposit.js';
import type { ZenodoProviderEnvironment } from '../zenodo/journal.js';

export type CrossrefTargetPolicy =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly environment: CrossrefEnvironment };

export type ZenodoIdentifierPolicy = 'reuse-crossref' | 'mint-zenodo';

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
    identifierPolicy: z.enum(['reuse-crossref', 'mint-zenodo'])
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
