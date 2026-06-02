export type DoiSource = 'record' | 'zotero.DOI' | 'zotero.doi' | 'extra' | 'callNumber';

export interface DoiConflict {
  readonly source: DoiSource;
  readonly doi: string;
}

export interface DoiDriftInput {
  readonly recordDoi: string;
  readonly zoteroDoi?: string | null | undefined;
  readonly zoteroLowercaseDoi?: string | null | undefined;
  readonly extra?: string | null | undefined;
  readonly callNumber?: string | null | undefined;
  readonly callNumberDoiPrefix?: string | null | undefined;
}

export interface DoiDriftResult {
  readonly drifted: boolean;
  readonly canonicalDoi: string | null;
  readonly conflicts: readonly DoiConflict[];
}

export type ResolveCrossrefDoiInput = DoiDriftInput;

export interface ResolvedCrossrefDoi {
  readonly doi: string | null;
  readonly source: DoiSource | null;
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

export function extractDoisFromExtra(extra: string | null | undefined): readonly string[] {
  if (!extra) return [];

  const dois = new Set<string>();
  for (const rawLine of extra.split(/\r?\n/)) {
    const line = rawLine.trim();
    const prefixed = line.match(/^DOI:\s*(\S+)\s*$/i);
    const normalized = normalizeDoi(prefixed?.[1] ?? line);
    if (normalized) dois.add(normalized);
  }

  return [...dois].sort();
}

export function extractFirstDoiFromExtra(extra: string | null | undefined): string | null {
  if (!extra) return null;

  for (const rawLine of extra.split(/\r?\n/)) {
    const line = rawLine.trim();
    const prefixed = line.match(/^DOI:\s*(\S+)\s*$/i);
    const normalized = normalizeDoi(prefixed?.[1] ?? line);
    if (normalized) return normalized;
  }

  return null;
}

export function deriveDoiFromCallNumber(callNumber: string | null | undefined, doiPrefix: string | null | undefined): string | null {
  const suffix = callNumber?.trim();
  const prefix = doiPrefix?.trim();
  if (!suffix || !prefix) return null;
  return normalizeDoi(`${prefix}/${suffix}`);
}

export function resolveCrossrefDoi(input: ResolveCrossrefDoiInput): ResolvedCrossrefDoi {
  const candidates: readonly DoiConflict[] = [
    { source: 'record', doi: normalizeDoi(input.recordDoi) ?? '' },
    { source: 'zotero.DOI', doi: normalizeDoi(input.zoteroDoi) ?? '' },
    { source: 'zotero.doi', doi: normalizeDoi(input.zoteroLowercaseDoi) ?? '' },
    { source: 'extra', doi: extractFirstDoiFromExtra(input.extra) ?? '' },
    { source: 'callNumber', doi: deriveDoiFromCallNumber(input.callNumber, input.callNumberDoiPrefix) ?? '' }
  ];

  const resolved = candidates.find((candidate) => candidate.doi.length > 0);
  return {
    doi: resolved?.doi ?? null,
    source: resolved?.source ?? null
  };
}

export function analyzeDoiDrift(input: DoiDriftInput): DoiDriftResult {
  const canonicalDoi = normalizeDoi(input.recordDoi);
  if (!canonicalDoi) {
    return {
      drifted: true,
      canonicalDoi: null,
      conflicts: [{ source: 'record', doi: input.recordDoi }]
    };
  }

  const candidates: DoiConflict[] = [];
  addCandidate(candidates, 'zotero.DOI', normalizeDoi(input.zoteroDoi));
  addCandidate(candidates, 'zotero.doi', normalizeDoi(input.zoteroLowercaseDoi));

  for (const doi of extractDoisFromExtra(input.extra)) {
    addCandidate(candidates, 'extra', doi);
  }

  addCandidate(candidates, 'callNumber', deriveDoiFromCallNumber(input.callNumber, input.callNumberDoiPrefix));

  const conflicts = candidates.filter((candidate) => candidate.doi !== canonicalDoi);
  return {
    drifted: conflicts.length > 0,
    canonicalDoi,
    conflicts
  };
}

function addCandidate(candidates: DoiConflict[], source: DoiSource, doi: string | null): void {
  if (doi) candidates.push({ source, doi });
}
