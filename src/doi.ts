export interface DoiCandidate {
  readonly source: string;
  readonly value?: string | null | undefined;
}

export interface DoiConflict {
  readonly source: string;
  readonly doi: string;
}

export interface DoiDriftInput {
  readonly canonicalDoi: string;
  readonly candidates: readonly DoiCandidate[];
}

export interface DoiDriftResult {
  readonly drifted: boolean;
  readonly canonicalDoi: string | null;
  readonly conflicts: readonly DoiConflict[];
}

export interface ResolvedDoi {
  readonly doi: string | null;
  readonly source: string | null;
}

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;

export function normalizeDoi(value: string | null | undefined): string | null {
  if (!value) return null;

  const trimmed = value.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/^<(.+)>$/, '$1');

  return DOI_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveDoiCandidates(candidates: readonly DoiCandidate[]): ResolvedDoi {
  for (const candidate of candidates) {
    const doi = normalizeDoi(candidate.value);
    if (doi) return { doi, source: candidate.source };
  }

  return { doi: null, source: null };
}

export function analyzeDoiDrift(input: DoiDriftInput): DoiDriftResult {
  const canonicalDoi = normalizeDoi(input.canonicalDoi);
  if (!canonicalDoi) {
    return {
      drifted: true,
      canonicalDoi: null,
      conflicts: [{ source: 'canonical', doi: input.canonicalDoi }]
    };
  }

  const conflicts: DoiConflict[] = [];
  for (const candidate of input.candidates) {
    const doi = normalizeDoi(candidate.value);
    if (doi && doi !== canonicalDoi) conflicts.push({ source: candidate.source, doi });
  }

  return {
    drifted: conflicts.length > 0,
    canonicalDoi,
    conflicts
  };
}
