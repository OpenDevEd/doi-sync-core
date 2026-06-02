import { describe, expect, it } from 'vitest';
import { buildFileManifest, diffFileManifest } from '../files.js';

describe('file manifest', () => {
  it('uses Zotero children as canonical file inventory and tombstones missing attachments', () => {
    const manifest = buildFileManifest([
      {
        key: 'PDF12345',
        version: 7,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          title: 'report.pdf',
          contentType: 'application/pdf',
          md5: 'abc',
          mtime: 1700000000000
        }
      },
      {
        key: 'LINK1234',
        version: 8,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: 'DOI',
          url: 'https://doi.org/10.53832/opendeved.1205'
        }
      }
    ]);

    expect(manifest.files).toEqual([
      {
        zoteroAttachmentKey: 'PDF12345',
        zoteroVersion: 7,
        filename: 'report.pdf',
        contentType: 'application/pdf',
        linkMode: 'imported_file',
        source: 'zotero',
        zoteroMd5: 'abc',
        zoteroMtime: 1700000000000,
        supported: true
      }
    ]);
    expect(manifest.unsupported).toEqual([
      {
        zoteroAttachmentKey: 'LINK1234',
        linkMode: 'linked_url',
        reason: 'linked_url is metadata, not an uploadable binary'
      }
    ]);
    expect(diffFileManifest({
      previousAttachmentKeys: ['PDF12345', 'OLD99999'],
      current: manifest
    }).removedAttachmentKeys).toEqual(['OLD99999']);
  });

  it('deduplicates identical Zotero attachments before Zenodo planning', () => {
    const manifest = buildFileManifest([
      importedPdf('PDF12345', {
        filename: 'report.pdf',
        md5: 'abc123',
        mtime: 1700000000000
      }),
      importedPdf('PDF67890', {
        filename: 'report.pdf',
        md5: 'abc123',
        mtime: 1700000000100
      })
    ]);

    expect(manifest.files.map((file) => file.zoteroAttachmentKey)).toEqual(['PDF12345']);
    expect(manifest.unsupported).toEqual([{
      zoteroAttachmentKey: 'PDF67890',
      linkMode: 'imported_file',
      reason: 'duplicate Zotero attachment skipped; identical file content already represented by attachment PDF12345'
    }]);
  });

  it('deduplicates same-content attachments with different filenames using a deterministic winner', () => {
    const manifest = buildFileManifest([
      importedPdf('PDFLONG1', {
        filename: 'Long report title - final publication copy.pdf',
        md5: 'abc123'
      }),
      importedPdf('PDFSHORT', {
        filename: 'report.pdf',
        md5: 'abc123'
      })
    ]);

    expect(manifest.files).toMatchObject([{
      zoteroAttachmentKey: 'PDFSHORT',
      filename: 'report.pdf'
    }]);
    expect(manifest.unsupported).toEqual([{
      zoteroAttachmentKey: 'PDFLONG1',
      linkMode: 'imported_file',
      reason: 'duplicate Zotero attachment skipped; identical file content already represented by attachment PDFSHORT'
    }]);
  });

  it('blocks same-filename attachments with different content from Zenodo file sync', () => {
    const manifest = buildFileManifest([
      importedPdf('PDF12345', {
        filename: 'report.pdf',
        md5: 'abc123'
      }),
      importedPdf('PDF67890', {
        filename: 'report.pdf',
        md5: 'def456'
      })
    ]);

    expect(manifest.files).toEqual([]);
    expect(manifest.unsupported).toEqual([
      {
        zoteroAttachmentKey: 'PDF12345',
        linkMode: 'imported_file',
        reason: 'duplicate filename has different file content; clean up Zotero attachments before Zenodo file sync',
        blocksZenodoFiles: true
      },
      {
        zoteroAttachmentKey: 'PDF67890',
        linkMode: 'imported_file',
        reason: 'duplicate filename has different file content; clean up Zotero attachments before Zenodo file sync',
        blocksZenodoFiles: true
      }
    ]);
  });

  it('keeps distinct files with different filenames and different content', () => {
    const manifest = buildFileManifest([
      importedPdf('PDF12345', {
        filename: 'report.pdf',
        md5: 'abc123'
      }),
      importedPdf('PDF67890', {
        filename: 'appendix.pdf',
        md5: 'def456'
      })
    ]);

    expect(manifest.files.map((file) => file.filename)).toEqual(['appendix.pdf', 'report.pdf']);
    expect(manifest.unsupported).toEqual([]);
  });

  it('orders files by JavaScript code units rather than process locale', () => {
    const manifest = buildFileManifest([
      importedPdf('PDFBLOWR', { filename: 'b.pdf', md5: 'md5-b' }),
      importedPdf('PDFUPPER', { filename: 'B.pdf', md5: 'md5-upper' }),
      importedPdf('PDFAA123', { filename: 'aa.pdf', md5: 'md5-aa' }),
      importedPdf('PDFA1234', { filename: 'a.pdf', md5: 'md5-a' })
    ]);

    expect(manifest.files.map((file) => file.filename)).toEqual(['B.pdf', 'a.pdf', 'aa.pdf', 'b.pdf']);
  });

  it('can select attachments by extension and any matching tag without filtering anything by default', () => {
    const unfiltered = buildFileManifest([
      importedPdf('PDF12345', {
        filename: 'report.pdf',
        md5: 'abc123',
        tags: ['final']
      }),
      importedPdf('DOC12345', {
        filename: 'draft.docx',
        md5: 'def456',
        tags: ['draft']
      })
    ]);
    const filtered = buildFileManifest([
      importedPdf('PDF12345', {
        filename: 'report.pdf',
        md5: 'abc123',
        tags: ['final']
      }),
      importedPdf('DOC12345', {
        filename: 'draft.docx',
        md5: 'def456',
        tags: ['draft']
      })
    ], {
      extensions: ['pdf'],
      allowedTags: ['final', 'published']
    });

    expect(unfiltered.files.map((file) => file.zoteroAttachmentKey)).toEqual(['DOC12345', 'PDF12345']);
    expect(filtered.files.map((file) => file.zoteroAttachmentKey)).toEqual(['PDF12345']);
    expect(filtered.unsupported).toEqual([]);
  });

  it('matches selected attachment tags case-insensitively', () => {
    const manifest = buildFileManifest([
      importedPdf('PDF12345', {
        filename: 'report.pdf',
        md5: 'abc123',
        tags: ['PublishPDF']
      }),
      importedPdf('OLD12345', {
        filename: 'old-report.pdf',
        md5: 'def456',
        tags: ['_Obsolete']
      })
    ], {
      extensions: ['pdf'],
      allowedTags: ['publishpdf']
    });

    expect(manifest.files.map((file) => file.zoteroAttachmentKey)).toEqual(['PDF12345']);
    expect(manifest.unsupported).toEqual([]);
  });
});

function importedPdf(
  key: string,
  input: {
    readonly filename: string;
    readonly md5?: string;
    readonly mtime?: number;
    readonly tags?: readonly string[];
  }
) {
  return {
    key,
    version: 1,
    data: {
      itemType: 'attachment',
      linkMode: 'imported_file',
      filename: input.filename,
      title: input.filename,
      contentType: 'application/pdf',
      tags: input.tags?.map((tag) => ({ tag })) ?? [],
      ...(input.md5 ? { md5: input.md5 } : {}),
      ...(input.mtime ? { mtime: input.mtime } : {})
    }
  } as const;
}
