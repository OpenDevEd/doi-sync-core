import { describe, expect, it } from 'vitest';

import {
  resolveCanonicalZoteroRecord,
  resolveZenodoSyncState,
  type DoiSyncRecord,
  type ZoteroChildItem,
  type ZoteroParentItem
} from '../index.js';

const originalRecord: DoiSyncRecord = {
  id: 'record-1',
  zoteroItemKey: 'OLDITEM1',
  crossrefDoi: '10.53832/opendeved.1205',
  doiActivated: true,
  knownZenodoRecordId: null
};

const originalParent: ZoteroParentItem = {
  key: 'OLDITEM1',
  version: 1,
  data: {
    itemType: 'report',
    title: 'Original',
    DOI: '10.53832/opendeved.1205',
    deleted: true
  }
};

const replacementParent: ZoteroParentItem = {
  key: 'NEWITEM1',
  version: 2,
  data: {
    itemType: 'report',
    title: 'Replacement',
    DOI: '10.53832/opendeved.1205',
    relations: {
      'dc:replaces': 'https://api.zotero.org/groups/123/items/OLDITEM1'
    }
  }
};

const children: readonly ZoteroChildItem[] = [];

describe('recovery helpers', () => {
  it('resolves a deleted Zotero item to a valid canonical replacement', async () => {
    const resolved = await resolveCanonicalZoteroRecord({
      record: originalRecord,
      original: { parent: originalParent, children },
      originalPublicItemUrl: 'https://docs.opendeved.net/lib/OLDITEM1',
      resolver: {
        resolveCanonicalItemKey: () => Promise.resolve({
          itemKey: 'NEWITEM1',
          publicItemUrl: 'https://docs.opendeved.net/lib/NEWITEM1'
        })
      },
      readReplacement: () => Promise.resolve({ parent: replacementParent, children })
    });

    expect(resolved.record.zoteroItemKey).toBe('NEWITEM1');
    expect(resolved.parent.data.url).toBe('https://docs.opendeved.net/lib/NEWITEM1');
    expect(resolved.resolution).toEqual({
      originalItemKey: 'OLDITEM1',
      resolvedItemKey: 'NEWITEM1',
      originalPublicItemUrl: 'https://docs.opendeved.net/lib/OLDITEM1',
      resolvedPublicItemUrl: 'https://docs.opendeved.net/lib/NEWITEM1'
    });
  });

  it('does not carry a stale MEE Zenodo id across a canonical Zotero redirect', async () => {
    const resolved = await resolveCanonicalZoteroRecord({
      record: {
        ...originalRecord,
        knownZenodoRecordId: 17233144
      },
      original: { parent: originalParent, children },
      originalPublicItemUrl: 'https://docs.opendeved.net/lib/OLDITEM1',
      resolver: {
        resolveCanonicalItemKey: () => Promise.resolve({
          itemKey: 'NEWITEM1',
          publicItemUrl: 'https://docs.opendeved.net/lib/NEWITEM1'
        })
      },
      readReplacement: () => Promise.resolve({ parent: replacementParent, children })
    });

    expect(resolved.record).toMatchObject({
      zoteroItemKey: 'NEWITEM1',
      knownZenodoRecordId: null
    });
  });

  it('recovers published Zenodo identifiers from an existing MEE Zenodo record id', async () => {
    const resolved = await resolveZenodoSyncState({
      record: {
        ...originalRecord,
        knownZenodoRecordId: 504607
      },
      verifyZenodoRecord: (recordId) => Promise.resolve({
        kind: 'published_record',
        identifiers: {
          latestRecordId: recordId,
          parentId: '504606',
          versionDoi: '10.53832/opendeved.1205',
          links: {}
        }
      })
    });

    expect(resolved.record.knownZenodoRecordId).toBe(504607);
    expect(resolved.syncState).toMatchObject({
      zenodoLatestRecordId: '504607',
      zenodoParentId: '504606',
      zenodoVersionDoi: '10.53832/opendeved.1205'
    });
  });

  it('recovers published Zenodo identifiers by exact DOI when stored Zenodo ids are missing or invalid', async () => {
    const verifiedIds: string[] = [];
    const lookedUpDois: string[] = [];
    const resolved = await resolveZenodoSyncState({
      record: {
        ...originalRecord,
        knownZenodoRecordId: 15043088
      },
      verifyZenodoRecord: (recordId) => {
        verifiedIds.push(recordId);
        return Promise.resolve(null);
      },
      findZenodoRecordByDoi: (doi) => {
        lookedUpDois.push(doi);
        return Promise.resolve({
          status: 'found',
          record: {
            kind: 'published_record',
            identifiers: {
              latestRecordId: '505547',
              parentId: '505546',
              versionDoi: doi,
              links: {
                selfHtml: 'https://sandbox.zenodo.org/records/505547'
              }
            }
          }
        });
      }
    });

    expect(verifiedIds).toEqual(['15043088']);
    expect(lookedUpDois).toEqual(['10.53832/opendeved.1205']);
    expect(resolved.record.knownZenodoRecordId).toBeNull();
    expect(resolved.syncState).toMatchObject({
      zenodoLatestRecordId: '505547',
      zenodoParentId: '505546',
      zenodoVersionDoi: '10.53832/opendeved.1205'
    });
  });

  it('verifies existing Zenodo state before trusting it while preserving Crossref pending state', async () => {
    const verifiedIds: string[] = [];
    const resolved = await resolveZenodoSyncState({
      record: originalRecord,
      existingState: {
        crossrefPendingPayloadHash: 'crossref-pending-hash',
        crossrefPendingBatchId: 'pending-batch',
        zenodoLatestRecordId: 'stale-record',
        zenodoParentId: 'stale-parent',
        zenodoPayloadHash: 'stale-zenodo-hash',
        fileManifestHash: 'stale-files-hash'
      },
      verifyZenodoRecord: (recordId) => {
        verifiedIds.push(recordId);
        return Promise.resolve(null);
      },
      findZenodoRecordByDoi: (doi) => Promise.resolve({
        status: 'found',
        record: {
          kind: 'published_record',
          identifiers: {
            latestRecordId: '14944686',
            parentId: '14944685',
            versionDoi: doi,
            links: {
              selfHtml: 'https://zenodo.org/records/14944686'
            }
          }
        }
      })
    });

    expect(verifiedIds).toEqual(['stale-record']);
    expect(resolved.syncState).toMatchObject({
      crossrefPendingPayloadHash: 'crossref-pending-hash',
      crossrefPendingBatchId: 'pending-batch',
      zenodoLatestRecordId: '14944686',
      zenodoParentId: '14944685',
      zenodoVersionDoi: '10.53832/opendeved.1205'
    });
    expect(resolved.syncState).not.toMatchObject({
      zenodoPayloadHash: 'stale-zenodo-hash',
      fileManifestHash: 'stale-files-hash'
    });
  });

  it('marks an ambiguous exact DOI lookup unsafe instead of falling through to a create', async () => {
    const resolved = await resolveZenodoSyncState({
      record: originalRecord,
      verifyZenodoRecord: () => Promise.resolve(null),
      findZenodoRecordByDoi: (doi) => Promise.resolve({
        status: 'ambiguous',
        recordIds: [`${doi}:record-a`, `${doi}:record-b`]
      })
    });

    expect(resolved.syncState).toMatchObject({
      lastFailureClass: 'ZENODO_DOI_LOOKUP_AMBIGUOUS',
      lastFailureSummary: 'Zenodo exact DOI lookup for 10.53832/opendeved.1205 found multiple published records: 10.53832/opendeved.1205:record-a, 10.53832/opendeved.1205:record-b'
    });
  });

  it('recovers an unpublished Zenodo draft from the latest publish journal entry', async () => {
    const resolved = await resolveZenodoSyncState({
      record: originalRecord,
      latestJournal: {
        id: 'journal-1',
        recordId: originalRecord.id,
        operationType: 'zenodo_draft_create',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: null,
        depositionId: '504629',
        draftRecordId: '504629',
        parentId: null,
        status: 'ready_to_publish',
        publishedRecordId: null,
        identifiers: null
      },
      verifyZenodoRecord: (recordId) => Promise.resolve({
        kind: 'legacy_unsubmitted_deposition',
        deposition: {
          depositionId: recordId,
          recordId,
          submitted: false,
          state: 'unsubmitted',
          fileCount: 0,
          links: {}
        }
      })
    });

    expect(resolved.syncState).toMatchObject({
      zenodoLegacyDepositionId: '504629',
      zenodoLegacyDepositionState: 'unsubmitted',
      zenodoJournaledDraftOperationType: 'zenodo_draft_create',
      zenodoRecoveredZenodoPayloadHash: 'zenodo-hash'
    });
  });

  it('recovers a preparing Zenodo draft as an unsubmitted deposition without marking it publish-ready', async () => {
    const resolved = await resolveZenodoSyncState({
      record: originalRecord,
      latestJournal: {
        id: 'journal-preparing',
        recordId: originalRecord.id,
        operationType: 'zenodo_create',
        zenodoPayloadHash: 'zenodo-hash',
        fileManifestHash: 'file-hash',
        depositionId: '504630',
        draftRecordId: '504630',
        parentId: null,
        status: 'preparing',
        publishedRecordId: null,
        identifiers: null
      },
      verifyZenodoRecord: (recordId) => Promise.resolve({
        kind: 'legacy_unsubmitted_deposition',
        deposition: {
          depositionId: recordId,
          recordId,
          submitted: false,
          state: 'unsubmitted',
          fileCount: 1,
          links: {}
        }
      })
    });

    expect(resolved.syncState).toMatchObject({
      zenodoLegacyDepositionId: '504630',
      zenodoLegacyDepositionState: 'unsubmitted'
    });
    expect(resolved.syncState).not.toMatchObject({
      zenodoJournaledDraftOperationType: 'zenodo_create',
      zenodoRecoveredZenodoPayloadHash: 'zenodo-hash',
      zenodoRecoveredFileManifestHash: 'file-hash'
    });
  });

  it('prefers the publish journal over Zotero Extra so recovered state keeps exact payload hashes', async () => {
    const resolved = await resolveZenodoSyncState({
      record: originalRecord,
      existingState: {
        zenodoLatestRecordId: '504607',
        zenodoParentId: '504606',
        zenodoPayloadHash: 'old-zenodo-hash',
        fileManifestHash: 'old-file-hash'
      },
      zoteroExtra: [
        'DOI: 10.53832/opendeved.1205',
        'ZenodoArchiveID: 504630',
        'ZenodoArchiveConcept: 504606'
      ].join('\n'),
      latestJournal: {
        id: 'journal-2',
        recordId: originalRecord.id,
        operationType: 'zenodo_new_version',
        zenodoPayloadHash: 'new-zenodo-hash',
        fileManifestHash: 'new-file-hash',
        depositionId: '504630',
        draftRecordId: '504630',
        parentId: '504606',
        status: 'published',
        publishedRecordId: '504630',
        identifiers: null
      },
      verifyZenodoRecord: (recordId) => Promise.resolve({
        kind: 'published_record',
        identifiers: {
          latestRecordId: recordId,
          parentId: '504606',
          versionDoi: '10.5072/zenodo.504630',
          conceptDoi: '10.5072/zenodo.504606',
          links: {}
        }
      })
    });

    expect(resolved.syncState).toMatchObject({
      zenodoLatestRecordId: '504630',
      zenodoParentId: '504606',
      zenodoRecoveredFromPrePublishJournal: true,
      zenodoRecoveredZenodoPayloadHash: 'new-zenodo-hash',
      zenodoRecoveredFileManifestHash: 'new-file-hash'
    });
    expect(resolved.syncState).not.toMatchObject({
      zenodoRecoveredFromZoteroWriteback: true
    });
  });

  it('recovers an unpublished Zenodo draft from canonical Zotero Extra', async () => {
    const resolved = await resolveZenodoSyncState({
      record: {
        ...originalRecord,
        zoteroItemKey: 'NEWITEM1',
        knownZenodoRecordId: null
      },
      zoteroExtra: [
        'DOI: 10.53832/opendeved.1205',
        'ZenodoArchiveID: 14944686',
        'ZenodoArchiveConcept: 14944685'
      ].join('\n'),
      verifyZenodoRecord: (recordId) => Promise.resolve({
        kind: 'legacy_unsubmitted_deposition',
        deposition: {
          depositionId: recordId,
          recordId,
          conceptRecordId: '14944685',
          submitted: false,
          state: 'unsubmitted',
          fileCount: 0,
          links: {}
        }
      })
    });

    expect(resolved.syncState).toMatchObject({
      zenodoLegacyDepositionId: '14944686',
      zenodoLegacyDepositionState: 'unsubmitted',
      zenodoRecoveredFromZoteroWriteback: true
    });
  });

  it('does not recover a Zotero Extra draft when its concept id does not match the verified draft', async () => {
    const resolved = await resolveZenodoSyncState({
      record: {
        ...originalRecord,
        zoteroItemKey: 'NEWITEM1',
        knownZenodoRecordId: null
      },
      zoteroExtra: [
        'DOI: 10.53832/opendeved.1205',
        'ZenodoArchiveID: 14944686',
        'ZenodoArchiveConcept: 14944685'
      ].join('\n'),
      verifyZenodoRecord: (recordId) => Promise.resolve({
        kind: 'legacy_unsubmitted_deposition',
        deposition: {
          depositionId: recordId,
          recordId,
          conceptRecordId: '99999999',
          submitted: false,
          state: 'unsubmitted',
          fileCount: 0,
          links: {}
        }
      })
    });

    expect(resolved.syncState).toBeUndefined();
  });
});
