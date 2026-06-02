import { normalizeDoi } from '../doi.js';
import type { ZoteroParentItem } from '../metadata.js';
import type { ZenodoSettlementIdentifiers } from '../settlement.js';

export interface ZoteroWritebackIdentifiers {
  readonly crossrefDoi: string;
  readonly zenodoLatestRecordId?: string | null;
  readonly zenodoParentId?: string | null;
}

export interface ZoteroWritebackInput {
  readonly itemVersion: number;
  readonly publicResourceUrl?: string;
  readonly data: {
    readonly DOI?: string | null;
    readonly extra?: string | null;
    readonly url?: string | null;
  };
  readonly identifiers: ZoteroWritebackIdentifiers;
}

export interface BuildZoteroWritebackIdentifiersInput {
  readonly crossrefDoi: string;
  readonly zenodo?: {
    readonly latestRecordId?: string | null;
    readonly parentId?: string | null;
    readonly zenodoLatestRecordId?: string | null;
    readonly zenodoParentId?: string | null;
  } | ZenodoSettlementIdentifiers | null;
}

export type ZoteroWritebackPlan =
  | {
      readonly type: 'patch';
      readonly ifUnmodifiedSinceVersion: number;
      readonly patch: {
      readonly DOI?: string;
      readonly extra: string;
      readonly url?: string;
    };
    }
  | {
      readonly type: 'noop';
    }
  | {
      readonly type: 'conflict';
      readonly reason: string;
    };

export type ZoteroDoiDriftAutofixInput = ZoteroWritebackInput;

const MANAGED_EXTRA_KEYS = new Set([
  'doi',
  'previousdoi',
  'kerkocite.itemalsoknownas',
  'archive',
  'zenodoarchiveid',
  'previouszenodoarchiveid',
  'zenodoarchiveconcept'
]);

/** Plans the managed parent DOI, Extra, and URL patch for a Zotero item. */
export function planZoteroWriteback(input: ZoteroWritebackInput): ZoteroWritebackPlan {
  const crossrefDoi = normalizeDoi(input.identifiers.crossrefDoi);
  if (!crossrefDoi) return { type: 'conflict', reason: 'Invalid Crossref DOI for Zotero writeback' };

  const existingDoi = normalizeDoi(input.data.DOI);
  if (existingDoi && existingDoi !== crossrefDoi) {
    return { type: 'conflict', reason: `Zotero DOI ${existingDoi} does not match managed DOI ${crossrefDoi}` };
  }

  const extra = mergeManagedExtraLines(input.data.extra, input.identifiers, crossrefDoi);
  const patch: { DOI?: string; extra: string; url?: string } = { extra };
  if (!existingDoi) patch.DOI = crossrefDoi;
  const publicResourceUrl = normalizeUrl(input.publicResourceUrl);
  if (publicResourceUrl && normalizeUrl(input.data.url) !== publicResourceUrl) {
    patch.url = publicResourceUrl;
  }

  const currentExtra = input.data.extra ?? '';
  if (existingDoi === crossrefDoi && currentExtra === extra && patch.url === undefined) return { type: 'noop' };

  return {
    type: 'patch',
    ifUnmodifiedSinceVersion: input.itemVersion,
    patch
  };
}

/** Plans an explicit Zotero DOI correction for records where MEE is canonical and Zotero drifted. */
export function planZoteroDoiDriftAutofix(input: ZoteroDoiDriftAutofixInput): ZoteroWritebackPlan {
  const crossrefDoi = normalizeDoi(input.identifiers.crossrefDoi);
  if (!crossrefDoi) return { type: 'conflict', reason: 'Invalid Crossref DOI for Zotero DOI drift autofix' };

  const extra = mergeManagedExtraLines(input.data.extra, input.identifiers, crossrefDoi);
  const patch: { DOI?: string; extra: string; url?: string } = { extra };
  if (normalizeDoi(input.data.DOI) !== crossrefDoi) patch.DOI = crossrefDoi;
  const publicResourceUrl = normalizeUrl(input.publicResourceUrl);
  if (publicResourceUrl && normalizeUrl(input.data.url) !== publicResourceUrl) {
    patch.url = publicResourceUrl;
  }

  const currentExtra = input.data.extra ?? '';
  if (patch.DOI === undefined && currentExtra === extra && patch.url === undefined) return { type: 'noop' };

  return {
    type: 'patch',
    ifUnmodifiedSinceVersion: input.itemVersion,
    patch
  };
}

/** Extracts only the Zotero parent fields controlled by managed DOI sync writeback. */
export function buildZoteroWritebackData(parent: ZoteroParentItem): ZoteroWritebackInput['data'] {
  return {
    ...(parent.data.DOI === undefined ? {} : { DOI: parent.data.DOI }),
    ...(parent.data.extra === undefined ? {} : { extra: parent.data.extra }),
    ...(parent.data.url === undefined ? {} : { url: parent.data.url })
  };
}

/** Builds Zotero writeback identifiers from Crossref and Zenodo settlement state. */
export function buildZoteroWritebackIdentifiers(input: BuildZoteroWritebackIdentifiersInput): ZoteroWritebackIdentifiers {
  const identifiers: {
    crossrefDoi: string;
    zenodoLatestRecordId?: string;
    zenodoParentId?: string;
  } = {
    crossrefDoi: input.crossrefDoi
  };

  const latestRecordId = latestZenodoRecordId(input.zenodo)?.trim();
  if (latestRecordId) identifiers.zenodoLatestRecordId = latestRecordId;

  const parentId = zenodoParentId(input.zenodo)?.trim();
  if (parentId) identifiers.zenodoParentId = parentId;

  return identifiers;
}

/** Rewrites only managed DOI/Zenodo/Kerko Extra lines while preserving unmanaged lines. */
export function mergeManagedExtraLines(
  existingExtra: string | null | undefined,
  identifiers: ZoteroWritebackIdentifiers,
  normalizedCrossrefDoi = normalizeDoi(identifiers.crossrefDoi)
): string {
  if (!normalizedCrossrefDoi) throw new Error('Invalid Crossref DOI');

  const lines = (existingExtra ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const unmanaged = lines.filter((line) => !MANAGED_EXTRA_KEYS.has(extraKey(line)));
  const doiHistory = extraDoiHistory(lines, normalizedCrossrefDoi);
  const archiveHistory = extraZenodoArchiveHistory(lines, identifiers.zenodoLatestRecordId);

  return [
    ...unmanaged,
    `DOI: ${normalizedCrossrefDoi}`,
    ...doiHistory.previousDois.map((doi) => `previousDOI: ${doi}`),
    optionalLine('ZenodoArchiveID', identifiers.zenodoLatestRecordId),
    ...archiveHistory.previousArchiveIds.map((id) => `previousZenodoArchiveID: ${id}`),
    optionalLine('ZenodoArchiveConcept', identifiers.zenodoParentId),
    doiHistory.kerkoLine
  ].filter((line): line is string => Boolean(line)).join('\n');
}

/** Parses managed Zenodo identifiers from a Zotero Extra field.
 *
 * Falls back to legacy patterns (`Archive: https://[sandbox.]zenodo.org/record(s)/<N>` and
 * Zenodo DOIs `10.5281/zenodo.<N>` / `10.5072/zenodo.<N>` in `DOI:` or `previousDOI:` lines)
 * so records authored by the old zotzen-lib / zenodo-lib still resolve. Explicit
 * `ZenodoArchiveID:` always wins; otherwise the maximum legacy id is selected to match the
 * old "newest version wins" behaviour. */
export function parseManagedExtraIdentifiers(extra: string | null | undefined): {
  readonly zenodoLatestRecordId?: string;
  readonly zenodoParentId?: string;
} {
  let managedRecordId: string | undefined;
  let parentId: string | undefined;
  const legacyRecordIds: string[] = [];

  for (const rawLine of (extra ?? '').split(/\r?\n/)) {
    const separator = rawLine.indexOf(':');
    if (separator < 0) continue;
    const key = rawLine.slice(0, separator).trim().toLowerCase();
    const value = rawLine.slice(separator + 1).trim();
    if (!value) continue;

    if (key === 'zenodoarchiveid') {
      if (isValidZenodoRecordId(value)) managedRecordId = value;
      continue;
    }
    if (key === 'zenodoarchiveconcept') {
      if (isValidZenodoRecordId(value)) parentId = value;
      continue;
    }
    if (key === 'archive') {
      const fromUrl = legacyArchiveUrlZenodoId(value);
      if (fromUrl && isValidZenodoRecordId(fromUrl)) legacyRecordIds.push(fromUrl);
      continue;
    }
    if (key === 'doi' || key === 'previousdoi') {
      const fromDoi = legacyZenodoDoiId(value);
      if (fromDoi && isValidZenodoRecordId(fromDoi)) legacyRecordIds.push(fromDoi);
    }
  }

  const latestRecordId = managedRecordId ?? selectMaxNumericId(legacyRecordIds);

  return {
    ...(latestRecordId ? { zenodoLatestRecordId: latestRecordId } : {}),
    ...(parentId ? { zenodoParentId: parentId } : {})
  };
}

const LEGACY_ARCHIVE_URL_PATTERN = /^https?:\/\/(?:sandbox\.)?zenodo\.org\/records?\/(\d+)\b/i;
const LEGACY_ZENODO_DOI_PATTERN = /\b10\.(?:5281|5072)\/zenodo\.(\d+)\b/i;
const VALID_ZENODO_RECORD_ID = /^[1-9]\d*$/;

/** Zenodo record/parent IDs are positive integers. Reject "0", "-1", non-numeric, empty —
 * these appear in legacy Zotero Extra fields when an earlier import failed mid-flight. */
function isValidZenodoRecordId(value: string): boolean {
  return VALID_ZENODO_RECORD_ID.test(value);
}

function legacyArchiveUrlZenodoId(value: string): string | null {
  return LEGACY_ARCHIVE_URL_PATTERN.exec(value)?.[1] ?? null;
}

function legacyZenodoDoiId(value: string): string | null {
  return LEGACY_ZENODO_DOI_PATTERN.exec(value)?.[1] ?? null;
}

function selectMaxNumericId(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined;
  return ids.reduce((max, current) => (BigInt(current) > BigInt(max) ? current : max));
}

function extraKey(line: string): string {
  return line.split(':', 1)[0]?.trim().toLowerCase() ?? '';
}

interface ExtraDoiHistory {
  readonly previousDois: readonly string[];
  readonly kerkoLine: string;
}

function extraDoiHistory(lines: readonly string[], currentDoi: string): ExtraDoiHistory {
  const previousDois = uniqueDois(lines.flatMap(extraLinePreviousDois))
    .filter((doi) => doi !== currentDoi);

  const existingKerkoTokens = lines.flatMap(extraLineKerkoTokens);
  const existingKerkoDois = existingKerkoTokens.filter(isDoiToken).map(normalizeDoiToken);
  const existingKerkoNonDoiTokens = existingKerkoTokens.filter((token) => !isDoiToken(token));

  const kerkoDois = uniqueDois([currentDoi, ...previousDois, ...existingKerkoDois]);
  const kerkoTokens = [...kerkoDois, ...uniqueStrings(existingKerkoNonDoiTokens)];

  return {
    previousDois,
    kerkoLine: `KerkoCite.ItemAlsoKnownAs: ${kerkoTokens.join(' ')}`
  };
}

function extraLinePreviousDois(line: string): readonly string[] {
  const key = extraKey(line);
  if (key === 'doi' || key === 'previousdoi') {
    return line.slice(line.indexOf(':') + 1)
      .split(/\s+/)
      .flatMap(optionalDoi);
  }
  return [];
}

function extraLineKerkoTokens(line: string): readonly string[] {
  const key = extraKey(line);
  if (key !== 'kerkocite.itemalsoknownas') return [];
  return line.slice(line.indexOf(':') + 1)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function isDoiToken(token: string): boolean {
  return normalizeDoi(token) !== null;
}

function normalizeDoiToken(token: string): string {
  return normalizeDoi(token) ?? token;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

interface ZenodoArchiveHistory {
  readonly previousArchiveIds: readonly string[];
}

function extraZenodoArchiveHistory(
  lines: readonly string[],
  newLatestRecordId: string | null | undefined
): ZenodoArchiveHistory {
  const latest = newLatestRecordId?.trim();
  const priorIds = lines.flatMap(extraLineZenodoArchiveIds);
  const previousArchiveIds = uniqueStrings(priorIds)
    .filter((id) => id !== latest && isValidZenodoRecordId(id));
  return { previousArchiveIds };
}

function extraLineZenodoArchiveIds(line: string): readonly string[] {
  const key = extraKey(line);
  const value = line.slice(line.indexOf(':') + 1).trim();
  if (key === 'archive') {
    const fromUrl = legacyArchiveUrlZenodoId(value);
    return fromUrl ? [fromUrl] : [];
  }
  if (key !== 'zenodoarchiveid' && key !== 'previouszenodoarchiveid') return [];
  return value ? [value] : [];
}

function optionalDoi(value: string): readonly string[] {
  const doi = normalizeDoi(value);
  return doi ? [doi] : [];
}

function uniqueDois(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function optionalLine(key: string, value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? `${key}: ${trimmed}` : null;
}

function latestZenodoRecordId(input: BuildZoteroWritebackIdentifiersInput['zenodo']): string | null | undefined {
  if (!input) return undefined;
  if ('latestRecordId' in input) return input.latestRecordId;
  return input.zenodoLatestRecordId;
}

function zenodoParentId(input: BuildZoteroWritebackIdentifiersInput['zenodo']): string | null | undefined {
  if (!input) return undefined;
  if ('parentId' in input) return input.parentId;
  return input.zenodoParentId;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
