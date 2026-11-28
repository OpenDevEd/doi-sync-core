/**
 * What kind of body funds a work, as DOCiD records it: one that gives grants, one that invests, or a company.
 * Its own module, importing nothing, so the `docid` entry point stays free of zod: a Convex app puts it in its
 * schema, which every function loads on every call.
 */
export const FUNDER_TYPES = ['grantor', 'investor', 'corporation'] as const;
export type FunderType = (typeof FUNDER_TYPES)[number];
