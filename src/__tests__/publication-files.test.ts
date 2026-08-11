import { describe, expect, it } from 'vitest';

import {
  buildPublicationFileManifestHash,
  buildPublicationFileManifestSnapshot,
  parsePublicationFileManifest
} from '../publication/files.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('publication file contract', () => {
  it('normalizes and deterministically orders published files', () => {
    expect(parsePublicationFileManifest({
      files: [
        file('FILE0002', 'report.pdf', SHA_B),
        file('FILE0001', 'appendix.pdf', SHA_A)
      ]
    }).files.map((entry) => entry.fileKey)).toEqual(['FILE0001', 'FILE0002']);
  });

  it('hashes stable identity and bytes, not source revisions, MD5, or mtime', () => {
    const first = {
      files: [{
        ...file('FILE0001', 'report.pdf', SHA_A),
        publicationRevision: 1,
        sourceRevision: 7,
        sourceMd5: 'old-md5',
        sourceMtime: 1700000000000
      }]
    };
    const second = {
      files: [{
        ...file('FILE0001', 'report.pdf', SHA_A),
        publicationRevision: 99,
        sourceRevision: 800,
        sourceMd5: 'new-md5',
        sourceMtime: 1800000000000
      }]
    };

    expect(buildPublicationFileManifestSnapshot(first)).toEqual({
      files: [{
        fileKey: 'FILE0001',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        size: 1024,
        sha256: SHA_A
      }]
    });
    expect(buildPublicationFileManifestHash(first)).toBe(buildPublicationFileManifestHash(second));
  });

  it('changes the hash when file bytes change', () => {
    const before = { files: [file('FILE0001', 'report.pdf', SHA_A)] };
    const after = { files: [file('FILE0001', 'report.pdf', SHA_B)] };

    expect(buildPublicationFileManifestHash(before)).not.toBe(buildPublicationFileManifestHash(after));
  });

  it('rejects duplicate filenames and malformed SHA-256 values', () => {
    expect(() => parsePublicationFileManifest({
      files: [
        file('FILE0001', 'report.pdf', SHA_A),
        file('FILE0002', 'report.pdf', SHA_B)
      ]
    })).toThrow(/duplicate filename/i);
    expect(() => parsePublicationFileManifest({
      files: [file('FILE0001', 'report.pdf', 'not-a-sha')]
    })).toThrow();
  });
});

function file(fileKey: string, filename: string, sha256: string) {
  return {
    fileKey,
    publicationRevision: 3,
    filename,
    contentType: 'application/pdf',
    size: 1024,
    sha256
  };
}
