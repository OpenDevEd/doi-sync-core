import { compareCodeUnits } from './sort.js';

/** Default Zotero attachment tags that mark PDFs as managed upload candidates for Zenodo. */
export const DEFAULT_ZOTERO_PDF_TAGS = ['_publish', 'publishPDF'] as const;

export interface ZoteroChildItem {
  readonly key: string;
  readonly version: number;
  readonly data: {
    readonly itemType: string;
    readonly linkMode?: string | null | undefined;
    readonly filename?: string | null | undefined;
    readonly title?: string | null | undefined;
    readonly contentType?: string | null | undefined;
    readonly md5?: string | null | undefined;
    readonly mtime?: number | null | undefined;
    readonly url?: string | null | undefined;
    readonly tags?: readonly { readonly tag: string }[] | null | undefined;
  };
}

export interface FileManifestEntry {
  readonly zoteroAttachmentKey: string;
  readonly zoteroVersion: number;
  readonly filename: string;
  readonly contentType: string;
  readonly linkMode: 'imported_file' | 'imported_url';
  readonly source: 'zotero';
  readonly zoteroMd5?: string;
  readonly zoteroMtime?: number;
  readonly supported: true;
}

export interface UnsupportedAttachment {
  readonly zoteroAttachmentKey: string;
  readonly linkMode: string;
  readonly reason: string;
  readonly blocksZenodoFiles?: true;
}

export interface FileManifest {
  readonly files: readonly FileManifestEntry[];
  readonly unsupported: readonly UnsupportedAttachment[];
}

export interface AttachmentSelection {
  readonly extensions?: readonly string[] | null | undefined;
  /** Upload attachments that have at least one of these tags. Matching is case-insensitive. */
  readonly allowedTags?: readonly string[] | null | undefined;
}

export interface FileManifestDiffInput {
  readonly previousAttachmentKeys: readonly string[];
  readonly current: FileManifest;
}

export interface FileManifestDiff {
  readonly removedAttachmentKeys: readonly string[];
}

/** Builds the uploadable Zenodo file manifest from Zotero child attachments. */
export function buildFileManifest(
  children: readonly ZoteroChildItem[],
  selection: AttachmentSelection = {}
): FileManifest {
  const files: FileManifestEntry[] = [];
  const unsupported: UnsupportedAttachment[] = [];
  const normalizedSelection = normalizeAttachmentSelection(selection);

  for (const child of children) {
    if (child.data.itemType !== 'attachment') continue;
    if (!attachmentMatchesSelection(child, normalizedSelection)) continue;

    const linkMode = child.data.linkMode ?? 'unknown';
    if (linkMode === 'imported_file' || linkMode === 'imported_url') {
      const filename = child.data.filename ?? child.data.title;
      const contentType = child.data.contentType;
      if (!filename || !contentType) {
        unsupported.push({
          zoteroAttachmentKey: child.key,
          linkMode,
          reason: 'downloadable attachment is missing filename or content type'
        });
        continue;
      }

      files.push(withOptionalFileMetadata({
        zoteroAttachmentKey: child.key,
        zoteroVersion: child.version,
        filename,
        contentType,
        linkMode,
        source: 'zotero',
        supported: true
      }, child));
      continue;
    }

    unsupported.push({
      zoteroAttachmentKey: child.key,
      linkMode,
      reason: unsupportedReason(linkMode)
    });
  }

  const deduplicated = blockConflictingDuplicateFilenames(deduplicateIdenticalFiles(files, unsupported), unsupported);

  return {
    files: deduplicated.sort((left, right) => compareCodeUnits(left.filename, right.filename) || compareCodeUnits(left.zoteroAttachmentKey, right.zoteroAttachmentKey)),
    unsupported
  };
}

interface NormalizedAttachmentSelection {
  readonly extensions: ReadonlySet<string>;
  readonly allowedTags: ReadonlySet<string>;
}

function normalizeAttachmentSelection(selection: AttachmentSelection): NormalizedAttachmentSelection {
  return {
    extensions: new Set((selection.extensions ?? []).map(normalizeExtension).filter(isNonEmptyString)),
    allowedTags: new Set((selection.allowedTags ?? []).map(normalizeTag).filter(isNonEmptyString))
  };
}

function attachmentMatchesSelection(child: ZoteroChildItem, selection: NormalizedAttachmentSelection): boolean {
  if (selection.extensions.size > 0) {
    const extension = filenameExtension(child.data.filename ?? child.data.title);
    if (!extension || !selection.extensions.has(extension)) return false;
  }

  if (selection.allowedTags.size > 0) {
    const tags = new Set(child.data.tags?.map((tag) => normalizeTag(tag.tag)) ?? []);
    if (!setsIntersect(tags, selection.allowedTags)) return false;
  }

  return true;
}

function normalizeExtension(extension: string): string {
  return extension.trim().replace(/^\./, '').toLowerCase();
}

function filenameExtension(filename: string | null | undefined): string | null {
  const trimmed = filename?.trim();
  if (!trimmed) return null;
  const index = trimmed.lastIndexOf('.');
  if (index < 0 || index === trimmed.length - 1) return null;
  return trimmed.slice(index + 1).toLowerCase();
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function setsIntersect(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

/** Compares a previous file state with the current manifest to detect removed attachments. */
export function diffFileManifest(input: FileManifestDiffInput): FileManifestDiff {
  const currentKeys = new Set(input.current.files.map((file) => file.zoteroAttachmentKey));
  return {
    removedAttachmentKeys: input.previousAttachmentKeys
      .filter((key) => !currentKeys.has(key))
      .sort(compareCodeUnits)
  };
}

function unsupportedReason(linkMode: string): string {
  if (linkMode === 'linked_url') return 'linked_url is metadata, not an uploadable binary';
  if (linkMode === 'linked_file') return 'linked_file is local-only unless Zotero cloud proves it is downloadable';
  return `unsupported Zotero attachment linkMode: ${linkMode}`;
}

function withOptionalFileMetadata(base: Omit<FileManifestEntry, 'zoteroMd5' | 'zoteroMtime'>, child: ZoteroChildItem): FileManifestEntry {
  return {
    ...base,
    ...(child.data.md5 ? { zoteroMd5: child.data.md5 } : {}),
    ...(typeof child.data.mtime === 'number' ? { zoteroMtime: child.data.mtime } : {})
  };
}

function deduplicateIdenticalFiles(files: readonly FileManifestEntry[], unsupported: UnsupportedAttachment[]): FileManifestEntry[] {
  const byMd5 = new Map<string, FileManifestEntry[]>();
  for (const file of files) {
    if (!file.zoteroMd5) continue;
    const key = file.zoteroMd5.toLowerCase();
    byMd5.set(key, [...(byMd5.get(key) ?? []), file]);
  }

  const skipped = new Set<string>();
  for (const group of byMd5.values()) {
    if (group.length < 2) continue;
    const winner = chooseDuplicateWinner(group);
    for (const file of group) {
      if (file.zoteroAttachmentKey === winner.zoteroAttachmentKey) continue;
      skipped.add(file.zoteroAttachmentKey);
      unsupported.push({
        zoteroAttachmentKey: file.zoteroAttachmentKey,
        linkMode: file.linkMode,
        reason: `duplicate Zotero attachment skipped; identical file content already represented by attachment ${winner.zoteroAttachmentKey}`
      });
    }
  }

  return files.filter((file) => !skipped.has(file.zoteroAttachmentKey));
}

function chooseDuplicateWinner(files: readonly FileManifestEntry[]): FileManifestEntry {
  const winner = [...files].sort((left, right) => (
    left.filename.length - right.filename.length
    || compareCodeUnits(left.filename, right.filename)
    || compareCodeUnits(left.zoteroAttachmentKey, right.zoteroAttachmentKey)
  ))[0];
  if (!winner) throw new Error('Cannot choose a duplicate winner from an empty file list');
  return winner;
}

function blockConflictingDuplicateFilenames(files: readonly FileManifestEntry[], unsupported: UnsupportedAttachment[]): FileManifestEntry[] {
  const byFilename = new Map<string, FileManifestEntry[]>();
  for (const file of files) {
    byFilename.set(file.filename, [...(byFilename.get(file.filename) ?? []), file]);
  }

  const blocked = new Set<string>();
  for (const group of byFilename.values()) {
    if (group.length < 2) continue;

    for (const file of group) {
      blocked.add(file.zoteroAttachmentKey);
      unsupported.push({
        zoteroAttachmentKey: file.zoteroAttachmentKey,
        linkMode: file.linkMode,
        reason: 'duplicate filename has different file content; clean up Zotero attachments before Zenodo file sync',
        blocksZenodoFiles: true
      });
    }
  }

  return files.filter((file) => !blocked.has(file.zoteroAttachmentKey));
}
