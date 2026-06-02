import { describe, expect, it, vi } from 'vitest';
import { executeLiveSyncPlan as executeLiveSyncPlanRaw } from '../executor/live-executor.js';
import { ProviderHttpError } from '../resilience/errors.js';
import type { FileManifestEntry } from '../files.js';
import type { SyncPlan, DoiSyncRecord } from '../planner.js';
import type { SyncOperationResult } from '../settlement.js';
import type { CrossrefSubmissionJournalWriter, CrossrefReportPaperDepositor, ExecuteLiveSyncPlanInput, ProviderExecutionContext, ProviderExecutionCredentials, ZenodoPublishJournalWriter, ZenodoWriter, ZoteroWriter } from '../executor/live-executor.js';

const record: DoiSyncRecord = {
  id: 'rec-1',
  zoteroItemKey: 'ABC12345',
  crossrefDoi: '10.53832/opendeved.1205',
  doiActivated: true
};

const credentials: ProviderExecutionCredentials = {
  zoteroGroupId: '123',
  zoteroApiKey: 'zotero-redacted',
  zenodoToken: 'zenodo-redacted'
};

const file: FileManifestEntry = {
  zoteroAttachmentKey: 'PDF12345',
  zoteroVersion: 3,
  filename: 'report.pdf',
  contentType: 'application/pdf',
  linkMode: 'imported_file',
  source: 'zotero',
  supported: true
};

const providerStateEnvironment = {
  crossrefEnvironment: 'test',
  zenodoEnvironment: 'sandbox'
} as const;

function executeLiveSyncPlan(
  input: Omit<ExecuteLiveSyncPlanInput, 'providerStateEnvironment'> & Partial<Pick<ExecuteLiveSyncPlanInput, 'providerStateEnvironment'>>
): Promise<readonly SyncOperationResult[]> {
  return executeLiveSyncPlanRaw({
    providerStateEnvironment,
    ...input
  });
}

describe('executeLiveSyncPlan', () => {
  it('journals a preparing Zenodo draft if preparation fails after draft allocation', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(async (input: Parameters<ZenodoWriter['prepareCreateRecord']>[0]) => {
        await input.onPreparedDraft?.({
          depositionId: '502440',
          draftRecordId: '502440',
          parentId: '502439'
        });
        throw new Error('metadata update timeout');
      }),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
      applyManagedWriteback: vi.fn(),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([{
      type: 'zenodo_create',
      status: 'failed',
      failureClass: 'Error',
      failureSummary: 'metadata update timeout'
    }]);

    expect(zenodoJournal.recordZenodoPublishDraft).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'rec-1',
      operationType: 'zenodo_create',
      zenodoPayloadHash: 'zenodo-hash',
      fileManifestHash: 'file-hash',
      depositionId: '502440',
      draftRecordId: '502440',
      parentId: '502439',
      status: 'preparing'
    }));
    expect(zenodo.publishDraft).not.toHaveBeenCalled();
    expect(zenodoJournal.markZenodoPublishDraftPublished).not.toHaveBeenCalled();
  });

  it('adopts an exact Zenodo DOI search match when create fails because the DOI already exists', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(() => Promise.reject(new ProviderHttpError({
        provider: 'zenodo',
        status: 400,
        body: '{"errors":[{"field":"pids.doi","messages":["doi:10.53832/opendeved.1205 already exists"]}]}'
      }))),
      findRecordByDoi: vi.fn(() => Promise.resolve({
        status: 'found' as const,
        record: {
          kind: 'published_record' as const,
          identifiers: {
            latestRecordId: '505547',
            parentId: '505546',
            versionDoi: '10.53832/opendeved.1205',
            links: {
              selfHtml: 'https://sandbox.zenodo.org/records/505547'
            }
          }
        }
      })),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
      applyManagedWriteback: vi.fn(),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([{
      type: 'zenodo_create',
      status: 'succeeded',
      zenodoAdoptionOnly: true,
      zenodo: {
        latestRecordId: '505547',
        parentId: '505546',
        versionDoi: '10.53832/opendeved.1205'
      }
    }]);

    expect(zenodo.findRecordByDoi).toHaveBeenCalledWith({
      token: 'zenodo-redacted',
      doi: '10.53832/opendeved.1205'
    });
    expect(zenodo.publishDraft).not.toHaveBeenCalled();
    expect(zenodoJournal.recordZenodoPublishDraft).not.toHaveBeenCalled();
  });

  it('deletes the worker-created draft when a same-run Zenodo create publish collides and adopts an existing DOI', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const zenodoIdentifiers = {
      latestRecordId: '504607',
      parentId: '504606',
      versionDoi: '10.53832/opendeved.1205',
      links: {}
    } as const;
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(() => Promise.resolve({
        depositionId: '505638',
        draftRecordId: '505638',
        parentId: '505637'
      })),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({
        provider: 'zenodo',
        status: 400,
        body: '{"errors":[{"field":"pids.doi","messages":["doi:10.53832/opendeved.1205 already exists"]}]}'
      }))),
      deleteUnpublishedDraft: vi.fn(() => Promise.resolve()),
      findRecordByDoi: vi.fn(() => Promise.resolve({
        status: 'found' as const,
        record: {
          kind: 'published_record' as const,
          identifiers: zenodoIdentifiers
        }
      }))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref: {
          submitReportPaper: vi.fn(),
          verifyReportPaper: vi.fn()
        },
        zenodo,
        zotero: {
          downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
          applyManagedWriteback: vi.fn(),
          createLinkedUrlAttachment: vi.fn(),
          patchLinkedUrlAttachment: vi.fn(),
          deleteItem: vi.fn()
        }
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true,
      now: () => new Date('2026-05-21T00:00:00.000Z')
    })).resolves.toEqual([{
      type: 'zenodo_create',
      status: 'succeeded',
      zenodoAdoptionOnly: true,
      zenodo: {
        latestRecordId: '504607',
        parentId: '504606',
        versionDoi: '10.53832/opendeved.1205'
      },
      zenodoOrphanDraftCleanup: {
        status: 'deleted',
        depositionId: '505638'
      }
    }]);

    expect(zenodo.deleteUnpublishedDraft).toHaveBeenCalledWith({
      token: 'zenodo-redacted',
      depositionId: '505638'
    });
    expect(zenodoJournal.markZenodoPublishDraftPublished).toHaveBeenCalledWith({
      recordId: 'rec-1',
      environment: providerStateEnvironment,
      depositionId: '505638',
      publishedRecordId: '504607',
      identifiers: zenodoIdentifiers,
      observedAt: new Date('2026-05-21T00:00:00.000Z')
    });
  });

  it('returns a stable unresolved DOI-collision failure when Zenodo create collides and exact DOI lookup misses', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(() => Promise.reject(new ProviderHttpError({
        provider: 'zenodo',
        status: 400,
        body: '{"errors":[{"field":"pids.doi","messages":["doi:10.53832/opendeved.1205 already exists"]}]}'
      }))),
      findRecordByDoi: vi.fn(() => Promise.resolve({ status: 'not_found' as const })),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref: {
          submitReportPaper: vi.fn(),
          verifyReportPaper: vi.fn()
        },
        zenodo,
        zotero: {
          downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
          applyManagedWriteback: vi.fn(),
          createLinkedUrlAttachment: vi.fn(),
          patchLinkedUrlAttachment: vi.fn(),
          deleteItem: vi.fn()
        }
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal: {
        recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
        markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
      },
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([{
      type: 'zenodo_create',
      status: 'failed',
      failureClass: 'ZENODO_DOI_ALREADY_EXISTS_UNRESOLVED',
      failureSummary: 'Zenodo says DOI 10.53832/opendeved.1205 already exists, but exact DOI lookup found no published record'
    }]);
  });

  it('does not prepare publishable Zenodo drafts without journal storage', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
      applyManagedWriteback: vi.fn(),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([{
      type: 'zenodo_create',
      status: 'failed',
      failureClass: 'ZENODO_JOURNAL_REQUIRED',
      failureSummary: 'Cannot publish a Zenodo draft without journal storage'
    }]);

    expect(zotero.downloadAttachmentFile).not.toHaveBeenCalled();
    expect(zenodo.prepareCreateRecord).not.toHaveBeenCalled();
    expect(zenodo.publishDraft).not.toHaveBeenCalled();
  });

  it('executes independent provider operations and downloads Zenodo files from Zotero only', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        {
          type: 'crossref_redeposit',
          payloadHash: 'crossref-hash',
          relation: {
            type: 'isSupplementedBy',
            identifierType: 'doi',
            identifier: '10.5072/zenodo.502440',
            description: 'Archived file package'
          }
        },
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' },
        { type: 'zotero_writeback' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const successfulCrossrefSubmission = {
      status: 'succeeded',
      filename: 'crossref.xml',
      diagnostic: {
        status: 'success',
        recordCount: 1,
        successCount: 1,
        failureCount: 0
      }
    } as const;
    const acceptedCrossrefSubmissionWithPendingXml = {
      status: 'pending',
      filename: 'delete-relations.xml',
      diagnostic: {
        status: 'success',
        recordCount: 1,
        successCount: 1,
        failureCount: 0
      },
      xmlVerification: {
        status: 'pending',
        reason: 'Crossref XML API metadata has not caught up'
      }
    } as const;
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn()
        .mockResolvedValueOnce(acceptedCrossrefSubmissionWithPendingXml)
        .mockResolvedValue(successfulCrossrefSubmission),
      verifyReportPaper: vi.fn(() => Promise.resolve({ status: 'matched' } as const))
    };
    const zenodoIdentifiers = {
      latestRecordId: '502440',
      parentId: '502439',
      conceptDoi: '10.5072/zenodo.502439',
      versionDoi: '10.5072/zenodo.502440',
      links: {}
    } as const;
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(() => Promise.resolve({
        depositionId: '502440',
        draftRecordId: '502440',
        parentId: '502439'
      })),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn(() => Promise.resolve(zenodoIdentifiers))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };
    const crossrefJournal: CrossrefSubmissionJournalWriter = {
      recordCrossrefPendingDeposit: vi.fn(() => Promise.resolve())
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
      applyManagedWriteback: vi.fn(() => Promise.resolve()),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn(),
      addTagsToItem: vi.fn(() => Promise.resolve())
    };
    const dateMatcher: unknown = expect.any(Date);

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      crossrefJournal,
      zenodoJournal,
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([
      { type: 'crossref_redeposit', status: 'succeeded' },
      {
        type: 'zenodo_create',
        status: 'succeeded',
        zenodo: {
          latestRecordId: '502440',
          parentId: '502439',
          conceptDoi: '10.5072/zenodo.502439',
          versionDoi: '10.5072/zenodo.502440'
        }
      },
      { type: 'zotero_writeback', status: 'succeeded' }
    ]);

    expect(zotero.downloadAttachmentFile).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      attachmentKey: 'PDF12345'
    });
    const deleteRelationInput = vi.mocked(crossref.submitReportPaper).mock.calls[0]?.[0];
    if (!deleteRelationInput) throw new Error('Expected a Crossref relation delete submit call');
    expect(deleteRelationInput).toMatchObject({
      batchId: 'doi-sync-rec-1-crossref-hash-delete-relations',
      filename: 'doi-sync-rec-1-crossref-hash-delete-relations.xml',
      relation: 'delete-all'
    });
    const submitInput = vi.mocked(crossref.submitReportPaper).mock.calls[1]?.[0];
    if (!submitInput) throw new Error('Expected a Crossref submit call');
    expect(submitInput.batchId).toBe('doi-sync-rec-1-crossref-hash');
    expect(submitInput.filename).toBe('doi-sync-rec-1-crossref-hash.xml');
    expect(submitInput).toMatchObject({
      relation: {
        type: 'isSupplementedBy',
        identifierType: 'doi',
        identifier: '10.5072/zenodo.502440',
        description: 'Archived file package'
      }
    });
    await deleteRelationInput.onSubmitted?.();
    await submitInput.onSubmitted?.();
    expect(crossrefJournal.recordCrossrefPendingDeposit).toHaveBeenNthCalledWith(1, {
      recordId: 'rec-1',
      environment: providerStateEnvironment,
      payloadHash: 'crossref-hash',
      batchId: 'doi-sync-rec-1-crossref-hash-delete-relations',
      filename: 'doi-sync-rec-1-crossref-hash-delete-relations.xml',
      submittedAt: dateMatcher,
      pendingReason: 'Crossref submission doi-sync-rec-1-crossref-hash-delete-relations.xml accepted; verification pending'
    });
    expect(crossrefJournal.recordCrossrefPendingDeposit).toHaveBeenNthCalledWith(2, {
      recordId: 'rec-1',
      environment: providerStateEnvironment,
      payloadHash: 'crossref-hash',
      batchId: 'doi-sync-rec-1-crossref-hash',
      filename: 'doi-sync-rec-1-crossref-hash.xml',
      submittedAt: dateMatcher,
      pendingReason: 'Crossref submission doi-sync-rec-1-crossref-hash.xml accepted; verification pending'
    });
    expect(zenodo.prepareCreateRecord).toHaveBeenCalledWith(expect.objectContaining({
      token: 'zenodo-redacted',
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      files: [{
        key: 'PDF12345',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }]
    }));
    expect(zenodoJournal.recordZenodoPublishDraft).toHaveBeenCalledWith({
      recordId: 'rec-1',
      environment: providerStateEnvironment,
      operationType: 'zenodo_create',
      zenodoPayloadHash: 'zenodo-hash',
      fileManifestHash: 'file-hash',
      depositionId: '502440',
      draftRecordId: '502440',
      parentId: '502439',
      observedAt: dateMatcher
    });
    expect(zenodo.publishDraft).toHaveBeenCalledWith({
      token: 'zenodo-redacted',
      draft: {
        depositionId: '502440',
        draftRecordId: '502440',
        parentId: '502439'
      }
    });
    expect(zenodoJournal.markZenodoPublishDraftPublished).toHaveBeenCalledWith({
      recordId: 'rec-1',
      environment: providerStateEnvironment,
      depositionId: '502440',
      publishedRecordId: '502440',
      identifiers: zenodoIdentifiers,
      observedAt: dateMatcher
    });
    expect(zotero.applyManagedWriteback).toHaveBeenCalledWith(expect.objectContaining({
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '502440',
        zenodoParentId: '502439'
      }
    }));
    expect(zotero.createLinkedUrlAttachment).toHaveBeenCalledTimes(3);
    expect(zotero.createLinkedUrlAttachment).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      parentItemKey: 'ABC12345',
      title: '🔄View entry on Zenodo (deposit) [ABC12345]',
      url: 'https://sandbox.zenodo.org/deposit/502440',
      tags: ['_r:zenodoDeposit', '_r:zotzen']
    });
    expect(zotero.createLinkedUrlAttachment).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      parentItemKey: 'ABC12345',
      title: '🔄View entry on Zenodo (record) [ABC12345]',
      url: 'https://sandbox.zenodo.org/record/502440',
      tags: ['_r:zenodoRecord', '_r:zotzen']
    });
    expect(zotero.createLinkedUrlAttachment).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      parentItemKey: 'ABC12345',
      title: '🔄Look up this DOI (once activated) [ABC12345]',
      url: 'https://doi.org/10.53832/opendeved.1205',
      tags: ['_r:doi', '_r:crossref', '_r:zotzen']
    });
    expect(zotero.addTagsToItem).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      itemKey: 'ABC12345',
      tags: ['_DOILIVE', '_zenodo:submitted']
    });
    expect(zotero.addTagsToItem).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      itemKey: 'PDF12345',
      tags: ['_DOILIVE', '_zenodo:uploaded']
    });
  });

  it('preserves an existing Zenodo/DataCite DOI when live metadata update is configured for external Crossref', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials,
      syncState: {
        zenodoLatestRecordId: '20342806',
        zenodoParentId: '20342805',
        zenodoConceptDoi: '10.5281/zenodo.20342805',
        zenodoVersionDoi: '10.5281/zenodo.20342806'
      }
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zenodo_metadata_update', payloadHash: 'zenodo-hash' }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report corrected',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: { files: [], unsupported: [] },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const zenodoIdentifiers = {
      latestRecordId: '20342806',
      parentId: '20342805',
      conceptDoi: '10.5281/zenodo.20342805',
      versionDoi: '10.5281/zenodo.20342806',
      links: {}
    } as const;
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(() => Promise.resolve({
        depositionId: '20342806',
        draftRecordId: '20342806',
        parentId: '20342805'
      })),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn(() => Promise.resolve(zenodoIdentifiers))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };

    await executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref: {
          submitReportPaper: vi.fn(),
          verifyReportPaper: vi.fn()
        },
        zenodo,
        zotero: {
          downloadAttachmentFile: vi.fn(),
          applyManagedWriteback: vi.fn(),
          createLinkedUrlAttachment: vi.fn(),
          patchLinkedUrlAttachment: vi.fn(),
          deleteItem: vi.fn()
        }
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    });

    expect(zenodo.prepareUpdateRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
      latestRecordId: '20342806',
      doiPolicy: 'dual'
    }));
  });

  it('publishes a journaled Zenodo draft directly without preparing a second draft', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{
        type: 'zenodo_publish_journaled_draft',
        originalOperationType: 'zenodo_metadata_update',
        depositionId: '502440',
        draftRecordId: '502440',
        payloadHash: 'zenodo-hash'
      }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodoIdentifiers = {
      latestRecordId: '502440',
      parentId: '502439',
      conceptDoi: '10.5072/zenodo.502439',
      versionDoi: '10.5072/zenodo.502440',
      links: {}
    } as const;
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn(() => Promise.resolve(zenodoIdentifiers))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(),
      applyManagedWriteback: vi.fn(),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true,
      now: () => new Date('2026-05-21T00:00:00.000Z')
    })).resolves.toEqual([{
      type: 'zenodo_publish_journaled_draft',
      status: 'succeeded',
      zenodo: {
        latestRecordId: '502440',
        parentId: '502439',
        conceptDoi: '10.5072/zenodo.502439',
        versionDoi: '10.5072/zenodo.502440'
      }
    }]);

    expect(zenodo.prepareCreateRecord).not.toHaveBeenCalled();
    expect(zenodo.prepareAdoptLegacyDeposition).not.toHaveBeenCalled();
    expect(zenodo.prepareUpdateRecordMetadata).not.toHaveBeenCalled();
    expect(zenodo.prepareNewVersion).not.toHaveBeenCalled();
    expect(zenodoJournal.recordZenodoPublishDraft).not.toHaveBeenCalled();
    expect(zenodo.publishDraft).toHaveBeenCalledWith({
      token: 'zenodo-redacted',
      draft: {
        depositionId: '502440',
        draftRecordId: '502440'
      }
    });
    expect(zenodoJournal.markZenodoPublishDraftPublished).toHaveBeenCalledWith({
      recordId: 'rec-1',
      environment: providerStateEnvironment,
      depositionId: '502440',
      publishedRecordId: '502440',
      identifiers: zenodoIdentifiers,
      observedAt: new Date('2026-05-21T00:00:00.000Z')
    });
  });

  it('adopts an exact DOI match when publishing a journaled Zenodo draft collides with an existing DOI', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{
        type: 'zenodo_publish_journaled_draft',
        originalOperationType: 'zenodo_create',
        depositionId: '505638',
        draftRecordId: '505638',
        parentId: '505637',
        payloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const zenodoIdentifiers = {
      latestRecordId: '504607',
      parentId: '504606',
      versionDoi: '10.53832/opendeved.1205',
      links: {
        selfHtml: 'https://sandbox.zenodo.org/records/504607'
      }
    } as const;
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
	      publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({
	        provider: 'zenodo',
	        status: 400,
	        body: '{"errors":[{"field":"pids.doi","messages":["doi:10.53832/opendeved.1205 already exists"]}]}'
	      }))),
	      deleteUnpublishedDraft: vi.fn(() => Promise.resolve()),
	      findRecordByDoi: vi.fn(() => Promise.resolve({
	        status: 'found' as const,
	        record: {
          kind: 'published_record' as const,
          identifiers: zenodoIdentifiers
        }
      }))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref: {
          submitReportPaper: vi.fn(),
          verifyReportPaper: vi.fn()
        },
        zenodo,
        zotero: {
          downloadAttachmentFile: vi.fn(),
          applyManagedWriteback: vi.fn(),
          createLinkedUrlAttachment: vi.fn(),
          patchLinkedUrlAttachment: vi.fn(),
          deleteItem: vi.fn()
        }
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true,
      now: () => new Date('2026-05-21T00:00:00.000Z')
    })).resolves.toEqual([{
      type: 'zenodo_publish_journaled_draft',
      status: 'succeeded',
      zenodoAdoptionOnly: true,
	      zenodo: {
	        latestRecordId: '504607',
	        parentId: '504606',
	        versionDoi: '10.53832/opendeved.1205'
	      },
	      zenodoOrphanDraftCleanup: {
	        status: 'deleted',
	        depositionId: '505638'
	      }
	    }]);

	    expect(zenodo.findRecordByDoi).toHaveBeenCalledWith({
	      token: 'zenodo-redacted',
	      doi: '10.53832/opendeved.1205'
	    });
	    expect(zenodo.deleteUnpublishedDraft).toHaveBeenCalledWith({
	      token: 'zenodo-redacted',
	      depositionId: '505638'
	    });
	    expect(zenodoJournal.markZenodoPublishDraftPublished).toHaveBeenCalledWith({
	      recordId: 'rec-1',
	      environment: providerStateEnvironment,
      depositionId: '505638',
      publishedRecordId: '504607',
      identifiers: zenodoIdentifiers,
      observedAt: new Date('2026-05-21T00:00:00.000Z')
	    });
	  });

  it('still adopts an exact DOI match if orphan draft cleanup fails', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{
        type: 'zenodo_publish_journaled_draft',
        originalOperationType: 'zenodo_create',
        depositionId: '505638',
        draftRecordId: '505638',
        payloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const zenodoIdentifiers = {
      latestRecordId: '504607',
      parentId: '504606',
      versionDoi: '10.53832/opendeved.1205',
      links: {}
    } as const;
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({
        provider: 'zenodo',
        status: 400,
        body: '{"errors":[{"field":"pids.doi","messages":["doi:10.53832/opendeved.1205 already exists"]}]}'
      }))),
      deleteUnpublishedDraft: vi.fn(() => Promise.reject(new Error('delete failed'))),
      findRecordByDoi: vi.fn(() => Promise.resolve({
        status: 'found' as const,
        record: {
          kind: 'published_record' as const,
          identifiers: zenodoIdentifiers
        }
      }))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref: {
          submitReportPaper: vi.fn(),
          verifyReportPaper: vi.fn()
        },
        zenodo,
        zotero: {
          downloadAttachmentFile: vi.fn(),
          applyManagedWriteback: vi.fn(),
          createLinkedUrlAttachment: vi.fn(),
          patchLinkedUrlAttachment: vi.fn(),
          deleteItem: vi.fn()
        }
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true,
      now: () => new Date('2026-05-21T00:00:00.000Z')
    })).resolves.toEqual([{
      type: 'zenodo_publish_journaled_draft',
      status: 'succeeded',
      zenodoAdoptionOnly: true,
      zenodo: {
        latestRecordId: '504607',
        parentId: '504606',
        versionDoi: '10.53832/opendeved.1205'
      },
      zenodoOrphanDraftCleanup: {
        status: 'failed',
        depositionId: '505638',
        failureClass: 'Error',
        failureSummary: 'delete failed'
      }
    }]);

    expect(zenodoJournal.markZenodoPublishDraftPublished).toHaveBeenCalled();
  });

  it('skips all Zotero write operations when Zotero writeback is disabled', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        { type: 'zenodo_create', payloadHash: 'zenodo-hash', fileManifestHash: 'file-hash' },
        { type: 'zotero_writeback' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(() => Promise.resolve({
        depositionId: '502440',
        draftRecordId: '502440',
        parentId: '502439'
      })),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn(() => Promise.resolve({
        latestRecordId: '502440',
        parentId: '502439',
        conceptDoi: '10.5072/zenodo.502439',
        versionDoi: '10.5072/zenodo.502440',
        links: {}
      }))
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn(() => Promise.resolve())
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
      applyManagedWriteback: vi.fn(() => Promise.resolve()),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: false
    })).resolves.toEqual([
      {
        type: 'zenodo_create',
        status: 'succeeded',
        zenodo: {
          latestRecordId: '502440',
          parentId: '502439',
          conceptDoi: '10.5072/zenodo.502439',
          versionDoi: '10.5072/zenodo.502440'
        }
      },
      {
        type: 'zotero_writeback',
        status: 'skipped',
        reason: 'ZOTERO_WRITEBACK_DISABLED'
      }
    ]);

    expect(zotero.downloadAttachmentFile).toHaveBeenCalledTimes(1);
    expect(zenodo.prepareCreateRecord).toHaveBeenCalledTimes(1);
    expect(zenodo.publishDraft).toHaveBeenCalledTimes(1);
    expect(zotero.applyManagedWriteback).not.toHaveBeenCalled();
    expect(zotero.createLinkedUrlAttachment).not.toHaveBeenCalled();
  });

  it('reconciles stale managed Zotero identifier links by updating one and deleting duplicates', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zotero_writeback' }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(),
      markZenodoPublishDraftPublished: vi.fn()
    };
    const zotero = {
      downloadAttachmentFile: vi.fn(),
      applyManagedWriteback: vi.fn(() => Promise.resolve()),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(() => Promise.resolve()),
      deleteItem: vi.fn(() => Promise.resolve())
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [{
        key: 'STALEDOI',
        version: 11,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [OLDKEY12]',
          url: 'https://doi.org/10.53832/opendeved.9999',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'DUPDOI12',
        version: 12,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [OLDER999]',
          url: 'https://doi.org/10.53832/opendeved.9998',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: [
            'DOI: 10.53832/opendeved.1205',
            'ZenodoArchiveID: 502440',
            'ZenodoArchiveConcept: 502439'
          ].join('\n'),
          url: 'https://my.educationevidence.io/lib/record/ABC12345'
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([
      { type: 'zotero_writeback', status: 'succeeded' }
    ]);

    expect(zotero.createLinkedUrlAttachment).not.toHaveBeenCalledWith(expect.objectContaining({
      tags: ['_r:doi', '_r:crossref', '_r:zotzen']
    }));
    expect(zotero.patchLinkedUrlAttachment).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      attachmentKey: 'STALEDOI',
      ifUnmodifiedSinceVersion: 11,
      patch: {
        title: '🔄Look up this DOI (once activated) [ABC12345]',
        url: 'https://doi.org/10.53832/opendeved.1205',
        tags: [{ tag: '_r:doi' }, { tag: '_r:crossref' }, { tag: '_r:zotzen' }]
      }
    });
    expect(zotero.deleteItem).toHaveBeenCalledWith({
      groupId: '123',
      apiKey: 'zotero-redacted',
      itemKey: 'DUPDOI12',
      ifUnmodifiedSinceVersion: 12
    });
  });

  it('still writes back the Crossref DOI when a Zenodo adoption fails, without creating Zenodo links', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [
        {
          type: 'zenodo_legacy_deposition_adopt',
          depositionId: '502440',
          payloadHash: 'zenodo-hash',
          fileManifestHash: 'file-hash'
        },
        { type: 'zotero_writeback' }
      ],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [file],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(() => Promise.reject(new Error('sandbox Zenodo outage'))),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(),
      markZenodoPublishDraftPublished: vi.fn()
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(() => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]) })),
      applyManagedWriteback: vi.fn(() => Promise.resolve()),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: [
            'DOI: 10.53832/opendeved.1205',
            'ZenodoArchiveID: 502440',
            'ZenodoArchiveConcept: 502439'
          ].join('\n')
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'dual',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([
      {
        type: 'zenodo_legacy_deposition_adopt',
        status: 'failed',
        failureClass: 'Error',
        failureSummary: 'sandbox Zenodo outage'
      },
      {
        type: 'zotero_writeback',
        status: 'succeeded'
      }
    ]);

    // The failed Zenodo adoption must NOT block the independent Crossref-DOI writeback...
    expect(zotero.applyManagedWriteback).toHaveBeenCalledTimes(1);
    // ...including the Crossref DOI lookup link, which does not depend on Zenodo.
    expect(zotero.createLinkedUrlAttachment).toHaveBeenCalledTimes(1);
    expect(zotero.createLinkedUrlAttachment).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://doi.org/10.53832/opendeved.1205'
    }));
    // No managed Zenodo deposit/record links are created while there are no confirmed Zenodo identifiers.
    expect(zotero.patchLinkedUrlAttachment).not.toHaveBeenCalled();
    expect(zotero.deleteItem).not.toHaveBeenCalled();
  });

  it('creates and journals an unpublished Zenodo draft without publishing when no file is available', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zenodo_draft_create', payloadHash: 'zenodo-hash' }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'empty-files-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(() => Promise.resolve({
        depositionId: '504449',
        draftRecordId: '504449'
      })),
      prepareAdoptLegacyDeposition: vi.fn(),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn()
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(),
      applyManagedWriteback: vi.fn(),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([{ type: 'zenodo_draft_create', status: 'succeeded' }]);

    expect(zenodo.prepareCreateRecord).toHaveBeenCalledWith(expect.objectContaining({
      token: 'zenodo-redacted',
      doiPolicy: 'external-crossref',
      files: []
    }));
    expect(zenodo.publishDraft).not.toHaveBeenCalled();
    expect(zenodoJournal.recordZenodoPublishDraft).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'rec-1',
      operationType: 'zenodo_draft_create',
      zenodoPayloadHash: 'zenodo-hash',
      depositionId: '504449',
      draftRecordId: '504449'
    }));
    expect(zenodoJournal.markZenodoPublishDraftPublished).not.toHaveBeenCalled();
  });

  it('updates and journals an unpublished Zenodo draft without publishing while files are still missing', async () => {
    const context: ProviderExecutionContext = {
      record,
      credentials,
      syncState: {
        zenodoLegacyDepositionId: '504449',
        zenodoLegacyDepositionState: 'unsubmitted'
      }
    };
    const plan: SyncPlan = {
      status: 'write_required',
      operations: [{ type: 'zenodo_draft_update', depositionId: '504449', payloadHash: 'zenodo-hash-v2' }],
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report corrected',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      fileManifest: {
        files: [],
        unsupported: []
      },
      hashes: {
        crossrefPayloadHash: 'crossref-hash',
        zenodoPayloadHash: 'zenodo-hash-v2',
        fileManifestHash: 'empty-files-hash'
      }
    };
    const crossref: CrossrefReportPaperDepositor = {
      submitReportPaper: vi.fn(),
      verifyReportPaper: vi.fn()
    };
    const zenodo: ZenodoWriter = {
      prepareCreateRecord: vi.fn(),
      prepareAdoptLegacyDeposition: vi.fn(() => Promise.resolve({
        depositionId: '504449',
        draftRecordId: '504449'
      })),
      prepareUpdateRecordMetadata: vi.fn(),
      prepareNewVersion: vi.fn(),
      publishDraft: vi.fn()
    };
    const zenodoJournal: ZenodoPublishJournalWriter = {
      recordZenodoPublishDraft: vi.fn(() => Promise.resolve()),
      markZenodoPublishDraftPublished: vi.fn()
    };
    const zotero: ZoteroWriter = {
      downloadAttachmentFile: vi.fn(),
      applyManagedWriteback: vi.fn(),
      createLinkedUrlAttachment: vi.fn(),
      patchLinkedUrlAttachment: vi.fn(),
      deleteItem: vi.fn()
    };

    await expect(executeLiveSyncPlan({
      context,
      plan,
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zoteroChildren: [],
      zoteroParent: {
        key: 'ABC12345',
        version: 8,
        data: {
          itemType: 'report',
          DOI: '10.53832/opendeved.1205',
          extra: ''
        }
      },
      providers: {
        crossref,
        zenodo,
        zotero
      },
      crossref: {
        environment: 'test',
        loginId: 'depositor@example.org:odel',
        password: 'secret',
        depositorName: 'OpenDevEd',
        emailAddress: 'depositor@example.org',
        registrant: 'Open Development & Education'
      },
      zenodoJournal,
      doiPolicy: 'external-crossref',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroWritebackEnabled: true
    })).resolves.toEqual([{ type: 'zenodo_draft_update', status: 'succeeded' }]);

    expect(zenodo.prepareAdoptLegacyDeposition).toHaveBeenCalledWith(expect.objectContaining({
      token: 'zenodo-redacted',
      depositionId: '504449',
      doiPolicy: 'external-crossref',
      files: []
    }));
    expect(zenodo.publishDraft).not.toHaveBeenCalled();
    expect(zenodoJournal.recordZenodoPublishDraft).toHaveBeenCalledWith(expect.objectContaining({
      recordId: 'rec-1',
      operationType: 'zenodo_draft_update',
      zenodoPayloadHash: 'zenodo-hash-v2',
      depositionId: '504449',
      draftRecordId: '504449'
    }));
    expect(zenodoJournal.markZenodoPublishDraftPublished).not.toHaveBeenCalled();
  });
});
