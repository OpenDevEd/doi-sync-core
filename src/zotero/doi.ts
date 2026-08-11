import {
  analyzeDoiDrift,
  normalizeDoi,
  resolveDoiCandidates,
  type DoiCandidate
} from '../doi.js';

export type ZoteroDoiSource = 'record' | 'zotero.DOI' | 'zotero.doi' | 'extra' | 'callNumber';

export interface ZoteroDoiConflict {
  readonly source: ZoteroDoiSource;
  readonly doi: string;
}

export interface ZoteroDoiDriftInput {
  readonly recordDoi: string;
  readonly zoteroDoi?: string | null | undefined;
  readonly zoteroLowercaseDoi?: string | null | undefined;
  readonly extra?: string | null | undefined;
  readonly callNumber?: string | null | undefined;
  readonly callNumberDoiPrefix?: string | null | undefined;
}

export interface ZoteroDoiDriftResult {
  readonly drifted: boolean;
  readonly canonicalDoi: string | null;
  readonly conflicts: readonly ZoteroDoiConflict[];
}

export interface ResolvedZoteroCrossrefDoi {
  readonly doi: string | null;
  readonly source: ZoteroDoiSource | null;
}

export function extractDoisFromExtra(extra: string | null | undefined): readonly string[] {
  return [...extractDoisFromExtraInOrder(extra)].sort();
}

function extractDoisFromExtraInOrder(extra: string | null | undefined): readonly string[] {
  if (!extra) return [];

  const dois = new Set<string>();
  for (const rawLine of extra.split(/\r?\n/)) {
    const line = rawLine.trim();
    const prefixed = line.match(/^DOI:\s*(\S+)\s*$/i);
    const normalized = normalizeDoi(prefixed?.[1] ?? line);
    if (normalized) dois.add(normalized);
  }

  return [...dois];
}

export function deriveDoiFromCallNumber(
  callNumber: string | null | undefined,
  doiPrefix: string | null | undefined
): string | null {
  const suffix = callNumber?.trim();
  const prefix = doiPrefix?.trim();
  if (!suffix || !prefix) return null;
  return normalizeDoi(`${prefix}/${suffix}`);
}

export function resolveZoteroCrossrefDoi(input: ZoteroDoiDriftInput): ResolvedZoteroCrossrefDoi {
  const resolved = resolveDoiCandidates([
    { source: 'record', value: input.recordDoi },
    { source: 'zotero.DOI', value: input.zoteroDoi },
    { source: 'zotero.doi', value: input.zoteroLowercaseDoi },
    { source: 'extra', value: extractDoisFromExtraInOrder(input.extra)[0] },
    {
      source: 'callNumber',
      value: deriveDoiFromCallNumber(input.callNumber, input.callNumberDoiPrefix)
    }
  ]);
  return {
    doi: resolved.doi,
    source: resolved.source as ZoteroDoiSource | null
  };
}

export function analyzeZoteroDoiDrift(input: ZoteroDoiDriftInput): ZoteroDoiDriftResult {
  const canonicalDoi = normalizeDoi(input.recordDoi);
  if (!canonicalDoi) {
    return {
      drifted: true,
      canonicalDoi: null,
      conflicts: [{ source: 'record', doi: input.recordDoi }]
    };
  }

  const candidates = zoteroDoiDriftCandidates(input);
  const result = analyzeDoiDrift({ canonicalDoi, candidates });
  return {
    ...result,
    conflicts: result.conflicts.map((conflict) => ({
      source: conflict.source as ZoteroDoiSource,
      doi: conflict.doi
    }))
  };
}

function zoteroDoiDriftCandidates(input: ZoteroDoiDriftInput): readonly DoiCandidate[] {
  return [
    { source: 'zotero.DOI', value: input.zoteroDoi },
    { source: 'zotero.doi', value: input.zoteroLowercaseDoi },
    ...extractDoisFromExtra(input.extra).map((value) => ({ source: 'extra', value })),
    {
      source: 'callNumber',
      value: deriveDoiFromCallNumber(input.callNumber, input.callNumberDoiPrefix)
    }
  ];
}
