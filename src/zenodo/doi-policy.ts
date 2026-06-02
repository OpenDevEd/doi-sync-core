import { normalizeDoi } from '../doi.js';
import type { DoiPolicy } from './records.js';

export interface EffectiveZenodoDoiPolicyInput {
  readonly configuredPolicy: DoiPolicy;
  readonly crossrefDoi: string;
  readonly existingVersionDoi?: string | null | undefined;
}

/** Selects the write policy that preserves an already-published Zenodo DOI identity. */
export function effectiveZenodoDoiPolicy(input: EffectiveZenodoDoiPolicyInput): DoiPolicy {
  if (input.configuredPolicy === 'dual') return 'dual';

  const existingVersionDoi = normalizeDoi(input.existingVersionDoi);
  const crossrefDoi = normalizeDoi(input.crossrefDoi);
  if (existingVersionDoi && crossrefDoi && existingVersionDoi !== crossrefDoi) return 'dual';

  return 'external-crossref';
}
