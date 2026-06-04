import type { ZoteroChildItem } from './files.js';
import { stableJson, type JsonValue } from './hash.js';
import type { ZoteroParentItem } from './metadata.js';
import { isCrossrefOperation, isZenodoOperation } from './operations.js';
import { crossrefRelationFromPlan, type DoiSyncRecord, type ExternalSyncState, type SyncAttention, type SyncPlan } from './planner.js';
import { compareCodeUnits } from './sort.js';
import { buildSyncPayloadSnapshots, type SyncPayloadSnapshots } from './snapshots.js';
import { planZoteroIdentifierLinkReconciliation } from './zotero/identifier-links.js';
import { buildZoteroWritebackData, buildZoteroWritebackIdentifiers, planZoteroWriteback, type ZoteroWritebackIdentifiers } from './zotero/writeback.js';
import type { DoiPolicy } from './zenodo/records.js';

export type IntendedDiffProvider = 'crossref' | 'zenodo' | 'zotero' | 'mee';
export type IntendedDiffLineKind = 'add' | 'remove' | 'update' | 'info';

export interface IntendedDiffLine {
  readonly kind: IntendedDiffLineKind;
  readonly target?: string;
  readonly text: string;
  readonly before?: string | null;
  readonly after?: string | null;
  readonly url?: string;
}

export interface IntendedDiffSection {
  readonly provider: IntendedDiffProvider;
  readonly title: string;
  readonly lines: readonly IntendedDiffLine[];
}

export interface IntendedDiff {
  readonly sections: readonly IntendedDiffSection[];
}

export interface BuildIntendedDiffInput {
  readonly plan: SyncPlan;
  readonly state?: ExternalSyncState;
  readonly record: DoiSyncRecord;
  readonly resourceUrl: string;
  readonly zoteroParent: ZoteroParentItem;
  readonly zoteroChildren: readonly ZoteroChildItem[];
  readonly doiPolicy: DoiPolicy;
  readonly zenodoBaseUrl: string;
  /** Zotero `zotero://select/...` URL emitted into the legacy Zenodo deposition `related_identifiers` write payload. */
  readonly zoteroSelectUrl?: string;
}

/** Builds provider-by-provider intended diffs for a prepared sync plan. */
export function buildIntendedDiff(input: BuildIntendedDiffInput): IntendedDiff {
  if (!('operations' in input.plan) || input.plan.operations.length === 0) {
    return { sections: [] };
  }

  return {
    sections: [
      // Attention first so the blocked-part disclosure is never the section that gets truncated
      // off a budget-limited notification.
      ...buildAttentionSections(input),
      ...buildCrossrefSections(input),
      ...buildZenodoSections(input),
      ...buildZoteroSections(input)
    ]
  };
}

function buildAttentionSections(input: BuildIntendedDiffInput): readonly IntendedDiffSection[] {
  const attention = 'attention' in input.plan ? input.plan.attention : undefined;
  if (!attention) return [];

  return [{
    provider: 'zenodo',
    title: 'Action needed',
    lines: [{
      kind: 'info',
      target: 'zenodo.files',
      text: attentionMessage(attention.reason)
    }]
  }];
}

function attentionMessage(reason: SyncAttention['reason']): string {
  switch (reason) {
    case 'ZOTERO_FILE_CONFLICT':
      return 'file change could not be applied: two Zotero attachments share a filename with different content; clean up the duplicate Zotero attachments. Crossref and Zenodo metadata were still synced';
  }
}

function buildCrossrefSections(input: BuildIntendedDiffInput): readonly IntendedDiffSection[] {
  const plan = input.plan;
  if (!('operations' in plan) || !('metadata' in plan)) return [];
  const operation = plan.operations.find(isCrossrefOperation);
  if (!operation) return [];
  const snapshots = currentPayloadSnapshots(input);
  const isPendingVerification = operation.type === 'crossref_verify_pending';

  return [{
    provider: 'crossref',
    title: isPendingVerification ? 'Crossref pending deposit' : 'Crossref deposit',
    lines: [
      {
        kind: isPendingVerification ? 'info' : 'add',
        text: isPendingVerification ? `verify pending DOI ${plan.metadata.doi}` : `submit/update DOI ${plan.metadata.doi}`,
        url: doiUrl(plan.metadata.doi)
      },
      ...payloadDiffLines({
        targetPrefix: 'crossref',
        before: input.state?.crossrefPayloadSnapshot ?? null,
        after: snapshots.crossrefPayload,
        hashLine: {
          kind: 'update',
          target: 'crossref.payloadHash',
          text: `payload hash: ${formatNullable(input.state?.crossrefPayloadHash)} -> ${operation.payloadHash}`
        }
      }),
      {
        kind: 'info',
        text: `resource URL: ${input.resourceUrl}`,
        url: input.resourceUrl
      }
    ]
  }];
}

function buildZenodoSections(input: BuildIntendedDiffInput): readonly IntendedDiffSection[] {
  const plan = input.plan;
  if (!('operations' in plan) || !('metadata' in plan) || !('fileManifest' in plan)) return [];

  const sections: IntendedDiffSection[] = [];
  const snapshots = currentPayloadSnapshots(input);
  for (const operation of plan.operations) {
    if (!isZenodoOperation(operation)) continue;

    const lines: IntendedDiffLine[] = [];
    if (operation.type === 'zenodo_create') {
      lines.push({ kind: 'add', text: 'create and publish a Zenodo record' });
      lines.push(...uploadFileLines(plan.fileManifest.files));
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
      lines.push(...zenodoFileManifestDiffLines(input, snapshots, operation.fileManifestHash));
    }

    if (operation.type === 'zenodo_draft_create') {
      lines.push({ kind: 'add', text: 'create an unpublished Zenodo draft' });
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
    }

    if (operation.type === 'zenodo_draft_update') {
      lines.push({ kind: 'update', text: `update unpublished Zenodo draft ${operation.depositionId}` });
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
    }

    if (operation.type === 'zenodo_legacy_deposition_adopt') {
      lines.push({ kind: 'update', text: `adopt legacy deposition ${operation.depositionId}` });
      lines.push(...uploadFileLines(plan.fileManifest.files));
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
      lines.push(...zenodoFileManifestDiffLines(input, snapshots, operation.fileManifestHash));
    }

    if (operation.type === 'zenodo_metadata_update') {
      lines.push({ kind: 'update', text: 'update published Zenodo metadata' });
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
    }

    if (operation.type === 'zenodo_file_update') {
      lines.push({ kind: 'update', text: `update files on published Zenodo record ${formatNullable(input.state?.zenodoLatestRecordId)}` });
      lines.push(...uploadFileLines(plan.fileManifest.files));
      lines.push(...removedFileLines(operation.removedAttachmentKeys, input.state?.previousFiles ?? []));
      lines.push(...changedFileLines(plan.fileManifest.files, input.state?.previousFiles ?? []));
      lines.push(...zenodoFileManifestDiffLines(input, snapshots, operation.fileManifestHash));
    }

    if (operation.type === 'zenodo_new_version') {
      lines.push({ kind: 'add', text: `create a new Zenodo version from record ${formatNullable(input.state?.zenodoLatestRecordId)}` });
      lines.push(...uploadFileLines(plan.fileManifest.files));
      lines.push(...removedFileLines(operation.removedAttachmentKeys, input.state?.previousFiles ?? []));
      lines.push(...changedFileLines(plan.fileManifest.files, input.state?.previousFiles ?? []));
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
      lines.push(...zenodoFileManifestDiffLines(input, snapshots, operation.fileManifestHash));
    }

    if (operation.type === 'zenodo_publish_journaled_draft') {
      lines.push({ kind: 'update', text: `publish journaled Zenodo draft ${operation.depositionId}` });
      lines.push(...zenodoMetadataDiffLines(input, snapshots, operation.payloadHash));
      if (operation.fileManifestHash) {
        lines.push(...zenodoFileManifestDiffLines(input, snapshots, operation.fileManifestHash));
      }
    }

    sections.push({
      provider: 'zenodo',
      title: 'Zenodo legacy deposition payload',
      lines
    });
  }

  return sections;
}

function zenodoMetadataDiffLines(
  input: BuildIntendedDiffInput,
  snapshots: SyncPayloadSnapshots,
  payloadHash: string
): readonly IntendedDiffLine[] {
  return payloadDiffLines({
    targetPrefix: 'zenodo',
    before: input.state?.zenodoPayloadSnapshot ?? null,
    after: snapshots.zenodoPayload,
    hashLine: {
      kind: 'update',
      target: 'zenodo.metadataHash',
      text: `metadata hash: ${formatNullable(input.state?.zenodoPayloadHash)} -> ${payloadHash}`
    }
  });
}

function zenodoFileManifestDiffLines(
  input: BuildIntendedDiffInput,
  snapshots: SyncPayloadSnapshots,
  fileManifestHash: string
): readonly IntendedDiffLine[] {
  return payloadDiffLines({
    targetPrefix: 'zenodo.fileManifest',
    before: input.state?.fileManifestSnapshot ?? null,
    after: snapshots.fileManifest,
    hashLine: {
      kind: 'update',
      target: 'zenodo.fileManifestHash',
      text: `file hash: ${formatNullable(input.state?.fileManifestHash)} -> ${fileManifestHash}`
    }
  });
}

function currentPayloadSnapshots(input: BuildIntendedDiffInput): SyncPayloadSnapshots {
  const plan = input.plan;
  if (!('metadata' in plan) || !('fileManifest' in plan)) {
    throw new Error('Cannot build payload snapshots without a provider sync plan');
  }
  const crossrefRelation = crossrefRelationFromPlan(plan);

  return buildSyncPayloadSnapshots({
    metadata: plan.metadata,
    fileManifest: plan.fileManifest,
    doiPolicy: input.doiPolicy,
    existingZenodoVersionDoi: input.state?.zenodoVersionDoi,
    resourceUrl: input.resourceUrl,
    ...(crossrefRelation ? { crossrefRelation } : {}),
    ...(input.zoteroSelectUrl ? { zoteroSelectUrl: input.zoteroSelectUrl } : {})
  });
}

function payloadDiffLines(input: {
  readonly targetPrefix: string;
  readonly before: JsonValue | null | undefined;
  readonly after: JsonValue;
  readonly hashLine: IntendedDiffLine;
}): readonly IntendedDiffLine[] {
  if (input.before === null || input.before === undefined) {
    return [...jsonCreateLines({ targetPrefix: input.targetPrefix, value: input.after }), input.hashLine];
  }

  const diff = jsonDiffLines({
    targetPrefix: input.targetPrefix,
    before: input.before,
    after: input.after
  });

  return diff.length > 0 ? diff : [input.hashLine];
}

function jsonCreateLines(input: {
  readonly targetPrefix: string;
  readonly value: JsonValue;
}): readonly IntendedDiffLine[] {
  const flat = flattenJson(input.value);
  const keys = [...flat.keys()].sort(compareCodeUnits);
  const lines = keys.map((key): IntendedDiffLine => ({
    kind: 'add',
    target: key ? `${input.targetPrefix}.${key}` : input.targetPrefix,
    text: key || input.targetPrefix,
    before: null,
    after: formatJsonValue(flat.get(key) ?? null)
  }));

  if (lines.length <= 20) return lines;
  return [
    ...lines.slice(0, 20),
    {
      kind: 'info',
      target: input.targetPrefix,
      text: `${lines.length - 20} more field(s) omitted from notification`
    }
  ];
}

function jsonDiffLines(input: {
  readonly targetPrefix: string;
  readonly before: JsonValue;
  readonly after: JsonValue;
}): readonly IntendedDiffLine[] {
  const beforeFlat = flattenJson(input.before);
  const afterFlat = flattenJson(input.after);
  const keys = [...new Set([...beforeFlat.keys(), ...afterFlat.keys()])]
    .sort(compareCodeUnits);
  const lines: IntendedDiffLine[] = [];

  for (const key of keys) {
    const before = beforeFlat.get(key);
    const after = afterFlat.get(key);
    if (before !== undefined && after !== undefined && stableJson(before) === stableJson(after)) continue;

    lines.push({
      kind: before === undefined ? 'add' : after === undefined ? 'remove' : 'update',
      target: key ? `${input.targetPrefix}.${key}` : input.targetPrefix,
      text: key || input.targetPrefix,
      before: before === undefined ? null : formatJsonValue(before),
      after: after === undefined ? null : formatJsonValue(after)
    });
  }

  if (lines.length <= 20) return lines;
  return [
    ...lines.slice(0, 20),
    {
      kind: 'info',
      target: input.targetPrefix,
      text: `${lines.length - 20} more field diff(s) omitted from notification`
    }
  ];
}

function flattenJson(value: JsonValue, prefix = ''): Map<string, JsonValue> {
  if (isPlainJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return new Map([[prefix, value]]);

    const flattened = new Map<string, JsonValue>();
    for (const [key, entry] of entries) {
      for (const [childKey, childValue] of flattenJson(entry, prefix ? `${prefix}.${key}` : key)) {
        flattened.set(childKey, childValue);
      }
    }
    return flattened;
  }

  return new Map([[prefix, value]]);
}

function isPlainJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatJsonValue(value: JsonValue): string {
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return stableJson(value);
}

function buildZoteroSections(input: BuildIntendedDiffInput): readonly IntendedDiffSection[] {
  const plan = input.plan;
  if (!('operations' in plan)) return [];

  const lines: IntendedDiffLine[] = [];
  for (const operation of plan.operations) {
    if (operation.type === 'zotero_writeback') {
      lines.push(...zoteroWritebackLines(input));
    }
  }

  return lines.length > 0
    ? [{
        provider: 'zotero',
        title: 'Zotero writeback',
        lines: dedupeLines(lines)
      }]
    : [];
}

function zoteroWritebackLines(input: BuildIntendedDiffInput): readonly IntendedDiffLine[] {
  const identifiers = zoteroWritebackIdentifiers(input);
  if (!identifiers.zenodoLatestRecordId && hasPendingZenodoProviderResult(input.plan)) {
    return [
      { kind: 'info', text: 'Zenodo identifiers are pending provider success' },
      { kind: 'info', text: 'parent DOI/Extra/url and managed child links will be planned after Zenodo succeeds' }
    ];
  }

  const writebackPlan = planZoteroWriteback({
    itemVersion: input.zoteroParent.version,
    publicResourceUrl: input.resourceUrl,
    data: buildZoteroWritebackData(input.zoteroParent),
    identifiers
  });

  const lines: IntendedDiffLine[] = [];
  if (writebackPlan.type === 'conflict') {
    return [{ kind: 'info', text: `writeback conflict: ${writebackPlan.reason}` }];
  }

  if (writebackPlan.type === 'patch') {
    if (writebackPlan.patch.DOI) {
      lines.push({
        kind: 'update',
        target: 'zotero.DOI',
        text: `parent DOI: ${formatNullable(input.zoteroParent.data.DOI)} -> ${writebackPlan.patch.DOI}`,
        before: input.zoteroParent.data.DOI ?? null,
        after: writebackPlan.patch.DOI,
        url: doiUrl(writebackPlan.patch.DOI)
      });
    }

    if (writebackPlan.patch.url) {
      lines.push({
        kind: 'update',
        target: 'zotero.url',
        text: `parent URL: ${formatNullable(input.zoteroParent.data.url)} -> ${writebackPlan.patch.url}`,
        before: input.zoteroParent.data.url ?? null,
        after: writebackPlan.patch.url,
        url: writebackPlan.patch.url
      });
    }

    if ((input.zoteroParent.data.extra ?? '') !== writebackPlan.patch.extra) {
      lines.push(...lineDiff({
        target: 'zotero.extra',
        before: input.zoteroParent.data.extra ?? '',
        after: writebackPlan.patch.extra
      }));
    }
  }

  if (!identifiers.zenodoLatestRecordId) {
    lines.push({ kind: 'info', text: 'Zenodo identifiers are pending provider success' });
    lines.push({ kind: 'info', text: 'managed child links will be planned after Zenodo identifiers exist' });
    return lines;
  }

  for (const action of planZoteroIdentifierLinkReconciliation({
    parentItemKey: input.record.zoteroItemKey,
    children: input.zoteroChildren,
    identifiers,
    zenodoBaseUrl: input.zenodoBaseUrl
  })) {
    if (action.type === 'create') {
      lines.push({
        kind: 'add',
        text: `child link: ${managedLinkLabel(action.url)}`,
        url: action.url
      });
    }
    if (action.type === 'update') {
      lines.push({
        kind: 'update',
        target: `zotero.child.${action.attachmentKey}`,
        text: `child link: ${managedLinkLabel(action.url)}`,
        before: action.previousUrl ?? action.previousTitle ?? null,
        after: action.url,
        url: action.url
      });
      lines.push(...tagDeltaLines({
        target: `zotero.child.${action.attachmentKey}.tags`,
        before: action.previousTags ?? [],
        after: action.tags
      }));
    }
    if (action.type === 'delete') {
      lines.push({
        kind: 'remove',
        target: `zotero.child.${action.attachmentKey}`,
        text: `stale managed child link: ${managedLinkLabel(action.previousUrl ?? action.previousTitle ?? '')}`,
        before: action.previousUrl ?? action.previousTitle ?? null,
        after: null
      });
    }
  }

  if (lines.length === 0) return [{ kind: 'info', text: 'Zotero managed writeback is already current' }];
  return lines;
}

function tagDeltaLines(input: {
  readonly target: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}): readonly IntendedDiffLine[] {
  const before = new Set(input.before);
  const after = new Set(input.after);
  const added = [...after].filter((tag) => !before.has(tag));
  const removed = [...before].filter((tag) => !after.has(tag));
  return [
    ...added.map((tag): IntendedDiffLine => ({ kind: 'add', target: input.target, text: `tag: ${tag}` })),
    ...removed.map((tag): IntendedDiffLine => ({ kind: 'remove', target: input.target, text: `tag: ${tag}` }))
  ];
}

function hasPendingZenodoProviderResult(plan: SyncPlan): boolean {
  if (!('operations' in plan)) return false;
  return plan.operations.some((operation) => (
    operation.type === 'zenodo_create'
    || operation.type === 'zenodo_draft_create'
    || operation.type === 'zenodo_draft_update'
    || operation.type === 'zenodo_legacy_deposition_adopt'
    || operation.type === 'zenodo_file_update'
    || operation.type === 'zenodo_new_version'
    || operation.type === 'zenodo_publish_journaled_draft'
  ));
}

function zoteroWritebackIdentifiers(input: BuildIntendedDiffInput): ZoteroWritebackIdentifiers {
  return buildZoteroWritebackIdentifiers({
    crossrefDoi: input.record.crossrefDoi,
    ...(input.state ? { zenodo: input.state } : {})
  });
}

function uploadFileLines(files: readonly { readonly filename: string; readonly contentType: string }[]): readonly IntendedDiffLine[] {
  if (files.length === 0) return [{ kind: 'info', target: 'zenodo.files', text: 'no uploadable Zotero files' }];
  if (files.length === 1) {
    const file = files[0];
    if (!file) return [];
    return [{ kind: 'add', target: 'zenodo.files', text: `upload 1 file: ${file.filename} (${file.contentType})` }];
  }
  const lines: IntendedDiffLine[] = [{ kind: 'add', target: 'zenodo.files', text: `upload ${files.length} files` }];
  for (const file of files.slice(0, 5)) {
    lines.push({ kind: 'add', target: 'zenodo.files', text: `file: ${file.filename} (${file.contentType})` });
  }
  return lines;
}

function removedFileLines(
  removedAttachmentKeys: readonly string[],
  previousFiles: readonly NonNullable<ExternalSyncState['previousFiles']>[number][]
): readonly IntendedDiffLine[] {
  return removedAttachmentKeys.map((key) => {
    const previous = previousFiles.find((file) => file.zoteroAttachmentKey === key);
    return {
      kind: 'remove',
      target: 'zenodo.files',
      text: previous
        ? `remove ${previous.filename} (${previous.contentType}) [${key}]`
        : `remove Zotero attachment ${key}`,
      before: previous ? fileFingerprint(previous) : key,
      after: null
    };
  });
}

function changedFileLines(
  currentFiles: readonly {
    readonly zoteroAttachmentKey: string;
    readonly filename: string;
    readonly contentType: string;
    readonly zoteroMd5?: string;
    readonly zoteroMtime?: number;
  }[],
  previousFiles: readonly NonNullable<ExternalSyncState['previousFiles']>[number][]
): readonly IntendedDiffLine[] {
  const lines: IntendedDiffLine[] = [];
  for (const current of currentFiles) {
    const previous = previousFiles.find((file) => file.zoteroAttachmentKey === current.zoteroAttachmentKey);
    if (!previous) continue;
    const before = fileFingerprint(previous);
    const after = fileFingerprint(current);
    if (before === after) continue;
    lines.push({
      kind: 'update',
      target: 'zenodo.files',
      text: `file changed: ${current.filename} [${current.zoteroAttachmentKey}]`,
      before,
      after
    });
  }
  return lines;
}

function fileFingerprint(file: {
  readonly filename: string;
  readonly contentType: string;
  readonly zoteroMd5?: string | null;
  readonly zoteroMtime?: number | null;
}): string {
  return [
    file.filename,
    file.contentType,
    `md5=${file.zoteroMd5 ?? 'none'}`,
    `mtime=${file.zoteroMtime ?? 'none'}`
  ].join(' | ');
}

function lineDiff(input: {
  readonly target: string;
  readonly before: string;
  readonly after: string;
}): readonly IntendedDiffLine[] {
  const beforeLines = normalizeDiffLines(input.before);
  const afterLines = normalizeDiffLines(input.after);
  const beforeCounts = countLines(beforeLines);
  const afterCounts = countLines(afterLines);
  const lines: IntendedDiffLine[] = [];

  for (const line of beforeLines) {
    const remainingAfter = afterCounts.get(line) ?? 0;
    if (remainingAfter > 0) {
      afterCounts.set(line, remainingAfter - 1);
      continue;
    }
    const remainingBefore = beforeCounts.get(line) ?? 0;
    if (remainingBefore <= 0) continue;
    beforeCounts.set(line, remainingBefore - 1);
    lines.push({
      kind: 'remove',
      target: input.target,
      text: line,
      before: line,
      after: null
    });
  }

  const consumedAdded = new Map<string, number>();
  for (const line of afterLines) {
    const additions = afterCounts.get(line) ?? 0;
    const consumed = consumedAdded.get(line) ?? 0;
    if (consumed >= additions) continue;
    consumedAdded.set(line, consumed + 1);
    lines.push({
      kind: 'add',
      target: input.target,
      text: line,
      before: null,
      after: line
    });
  }

  return lines.length > 0 ? lines : [{ kind: 'info', target: input.target, text: 'no line changes' }];
}

function normalizeDiffLines(value: string): readonly string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function countLines(lines: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function managedLinkLabel(url: string): string {
  if (url.includes('/deposit/')) return 'Zenodo deposit';
  if (url.includes('/record/')) return 'Zenodo record';
  if (url.startsWith('https://doi.org/')) return 'DOI lookup';
  return url;
}

function dedupeLines(lines: readonly IntendedDiffLine[]): readonly IntendedDiffLine[] {
  const seen = new Set<string>();
  const deduped: IntendedDiffLine[] = [];
  for (const line of lines) {
    const key = `${line.kind}:${line.text}:${line.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped;
}

function formatNullable(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'none';
}

function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}
