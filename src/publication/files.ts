import { z } from 'zod';

import type { JsonValue } from '../hash.js';
import { sha256Hex } from '../hash.js';
import { toJsonValue } from '../json.js';
import { compareCodeUnits } from '../sort.js';

const nonEmptyString = z.string().trim().min(1);

export interface PublicationFile {
  readonly fileKey: string;
  readonly publicationRevision: number;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PublicationFileManifest {
  readonly files: readonly PublicationFile[];
}

export const publicationFileSchema: z.ZodType<PublicationFile> = z.object({
  fileKey: nonEmptyString,
  publicationRevision: z.number().int().positive().safe(),
  filename: nonEmptyString,
  contentType: nonEmptyString,
  size: z.number().int().nonnegative().safe(),
  sha256: z.string().trim().toLowerCase().pipe(z.hash('sha256'))
}).strict();

export const publicationFileManifestSchema: z.ZodType<PublicationFileManifest> = z.object({
  files: z.array(publicationFileSchema)
}).strict();

export function parsePublicationFileManifest(input: unknown): PublicationFileManifest {
  const parsed = publicationFileManifestSchema.parse(input);
  assertUniqueFileKeys(parsed.files);
  assertUniqueFilenames(parsed.files);
  return {
    files: [...parsed.files].sort(comparePublicationFiles)
  };
}

export function buildPublicationFileManifestSnapshot(manifest: PublicationFileManifest): JsonValue {
  return toJsonValue({
    files: manifest.files
      .map((file) => ({
        fileKey: file.fileKey,
        filename: file.filename,
        contentType: file.contentType,
        size: file.size,
        sha256: file.sha256.toLowerCase()
      }))
      .sort(comparePublicationFiles)
  });
}

export function buildPublicationFileManifestHash(manifest: PublicationFileManifest): string {
  return sha256Hex(buildPublicationFileManifestSnapshot(manifest));
}

function assertUniqueFileKeys(files: readonly PublicationFile[]): void {
  assertUnique(files, (file) => file.fileKey, 'file key');
}

function assertUniqueFilenames(files: readonly PublicationFile[]): void {
  assertUnique(files, (file) => file.filename, 'filename');
}

function assertUnique(
  files: readonly PublicationFile[],
  keyFor: (file: PublicationFile) => string,
  label: string
): void {
  const seen = new Set<string>();
  for (const file of files) {
    const key = keyFor(file);
    if (seen.has(key)) throw new Error(`Publication file manifest contains duplicate ${label}: ${key}`);
    seen.add(key);
  }
}

function comparePublicationFiles(
  left: Pick<PublicationFile, 'filename' | 'fileKey'>,
  right: Pick<PublicationFile, 'filename' | 'fileKey'>
): number {
  return compareCodeUnits(left.filename, right.filename) || compareCodeUnits(left.fileKey, right.fileKey);
}
