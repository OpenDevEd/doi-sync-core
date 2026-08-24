import { describe, expect, it } from 'vitest';

import { planPublicationSync } from './plan-fixture.js';
import {
  buildPublicationFileManifestHash,
  parsePublicationFileManifest
} from '../publication/files.js';
import { parsePublicationRecordSnapshot } from '../publication/record.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('provider-neutral publication planner', () => {
  it('plans Crossref without enabling Zenodo', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: {
        crossref: { enabled: true, environment: 'test' },
        zenodo: { enabled: false }
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations.map(({ type }) => type) : []).toEqual([
      'crossref_redeposit'
    ]);
  });

  it('explicitly clears a previously deposited Crossref relation when it is removed', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: { crossref: { enabled: true, environment: 'test' }, zenodo: { enabled: false } },
      state: {
        crossref: {
          environment: 'test',
          lastSuccess: {
            payloadHash: 'old-payload',
            payloadSnapshot: {
              relation: {
                type: 'isSupplementedBy', identifierType: 'doi', identifier: '10.5281/zenodo.42'
              }
            }
          }
        }
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations : []).toEqual([
      expect.objectContaining({ type: 'crossref_redeposit', clearRelations: true })
    ]);
  });

  it('resumes a pending Crossref relation clear before depositing the desired payload', () => {
    const input = {
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: {
        crossref: { enabled: true as const, environment: 'test' as const },
        zenodo: { enabled: false as const }
      }
    };
    const initial = planPublicationSync(input);
    if (
      initial.status !== 'write_required'
      || !initial.hashes.crossrefPayloadHash
      || !initial.snapshots.crossrefPayload
    ) {
      throw new Error('expected Crossref plan');
    }

    const resumed = planPublicationSync({
      ...input,
      state: {
        crossref: {
          environment: 'test',
          pending: {
            stage: 'relation_clear',
            payloadHash: initial.hashes.crossrefPayloadHash,
            payloadSnapshot: initial.snapshots.crossrefPayload,
            batchId: 'clear-1', filename: 'clear-1.xml',
            submittedAt: new Date('2026-05-20T00:00:00.000Z')
          }
        }
      }
    });

    expect(resumed.status).toBe('write_required');
    expect('operations' in resumed ? resumed.operations : []).toEqual([
      expect.objectContaining({
        type: 'crossref_verify_pending', stage: 'relation_clear',
        payloadHash: initial.hashes.crossrefPayloadHash
      })
    ]);
  });

  it('plans Zenodo minting without Crossref or a DOI', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: {},
      targets: {
        crossref: { enabled: false },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations.map(({ type }) => type) : []).toEqual([
      'zenodo_create'
    ]);
  });

  it('returns a structured Zenodo validation error for child item records', () => {
    const plan = planPublicationSync({
      record: publicationRecord({ itemType: 'Attachment' }),
      files: fileManifest(),
      identifiers: {},
      targets: {
        crossref: { enabled: false },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
      }
    });

    expect(plan).toEqual({
      status: 'needs_attention',
      provider: 'zenodo',
      reason: 'ZENODO_VALIDATION_FAILED',
      issues: [{
        code: 'UNSUPPORTED_ITEM_TYPE',
        path: 'itemType',
        message: 'Zenodo does not support Evidence Library item type Attachment'
      }],
      operations: []
    });
  });

  it('archives under the DOI the record already has without touching Crossref', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: { bibliographicDoi: '10.1080/09500693.2021.1887' },
      targets: {
        crossref: { enabled: false },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-external' }
      }
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map(({ type }) => type)).toEqual(['zenodo_create']);
    const payload = JSON.stringify(plan.snapshots.zenodoPayload);
    expect(payload).toContain('"doi":"10.1080/09500693.2021.1887"');
    expect(payload).not.toContain('prereserve_doi');
  });

  it('needs attention when reuse-external is asked for without a record DOI', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: {},
      targets: {
        crossref: { enabled: false },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-external' }
      }
    });

    expect(plan).toEqual({
      status: 'needs_attention', provider: 'zenodo', reason: 'MISSING_EXTERNAL_DOI', operations: []
    });
  });

  it('waits locally for a published file instead of planning an empty Zenodo draft', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([]),
      identifiers: {},
      targets: {
        crossref: { enabled: false },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
      }
    });

    expect(plan).toMatchObject({
      status: 'waiting_for_file',
      provider: 'zenodo',
      operations: []
    });
  });

  it('still plans Crossref while Zenodo waits locally for a file', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: {
        crossref: { enabled: true, environment: 'test' },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-crossref' }
      }
    });

    expect(plan.status).toBe('write_required');
    if (plan.status !== 'write_required') throw new Error('expected write-required plan');
    expect(plan.operations.map(({ type }) => type)).toEqual(['crossref_redeposit']);
    expect(plan.waitingForFile).toBe(true);
  });

  it('resumes a journaled Zenodo publish even when the current file manifest is empty', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([]),
      identifiers: {},
      targets: zenodoMintTarget(),
      state: {
        zenodo: {
          environment: 'sandbox',
          identifierPolicy: 'mint-zenodo',
          journal: {
            operationType: 'zenodo_create',
            depositionId: '42',
            draftRecordId: '42',
            parentId: '41',
            payloadHash: 'prepared-payload',
            fileManifestHash: 'prepared-files',
            status: 'ready_to_publish'
          }
        }
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations : []).toEqual([{
      type: 'zenodo_publish_journaled_draft',
      originalOperationType: 'zenodo_create',
      depositionId: '42',
      draftRecordId: '42',
      parentId: '41',
      payloadHash: 'prepared-payload',
      fileManifestHash: 'prepared-files'
    }]);
  });

  it('discards a draft whose preparation did not reach ready-to-publish', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: {},
      targets: zenodoMintTarget(),
      state: {
        zenodo: {
          environment: 'sandbox',
          identifierPolicy: 'mint-zenodo',
          journal: {
            operationType: 'zenodo_create', depositionId: '42', draftRecordId: '42',
            payloadHash: 'prepared-payload', fileManifestHash: 'prepared-files',
            status: 'preparing'
          }
        }
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations : []).toEqual([{
      type: 'zenodo_discard_preparing_draft',
      originalOperationType: 'zenodo_create',
      depositionId: '42',
      draftRecordId: '42'
    }]);
  });

  it('does not let state from another provider environment suppress delivery', () => {
    const baseline = planPublicationSync({
      record: publicationRecord(), files: fileManifest(),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: {
        crossref: { enabled: true, environment: 'test' }, zenodo: { enabled: false }
      }
    });
    if (baseline.status !== 'write_required' || !baseline.hashes.crossrefPayloadHash) {
      throw new Error('expected Crossref baseline');
    }
    const plan = planPublicationSync({
      record: baseline.record, files: baseline.files, identifiers: baseline.identifiers,
      targets: baseline.targets,
      state: {
        crossref: {
          environment: 'production',
          lastSuccess: { payloadHash: baseline.hashes.crossrefPayloadHash }
        }
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations.map(({ type }) => type) : []).toEqual([
      'crossref_redeposit'
    ]);
  });

  it('blocks changes to an established Zenodo identifier policy', () => {
    const plan = planPublicationSync({
      record: publicationRecord(), files: fileManifest(),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: {
        crossref: { enabled: true, environment: 'test' },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-crossref' }
      },
      state: {
        zenodo: {
          environment: 'sandbox', identifierPolicy: 'mint-zenodo',
          identifiers: { latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42' }
        }
      }
    });

    expect(plan).toEqual({
      status: 'needs_attention', provider: 'zenodo', reason: 'ZENODO_IDENTIFIER_POLICY_IMMUTABLE', operations: []
    });
  });

  it('does not create a duplicate when a Zenodo DOI exists without provider record state', () => {
    const plan = planPublicationSync({
      record: publicationRecord(), files: fileManifest(),
      identifiers: { zenodoVersionDoi: '10.5281/zenodo.42' },
      targets: zenodoMintTarget()
    });

    expect(plan).toEqual({
      status: 'needs_attention', provider: 'zenodo', reason: 'MISSING_ZENODO_PROVIDER_RECORD_ID', operations: []
    });
  });

  it('ignores publication revisions when stable file identity and SHA-256 are unchanged', () => {
    const initial = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([file({ publicationRevision: 1 })]),
      identifiers: {},
      targets: zenodoMintTarget()
    });
    if (initial.status !== 'write_required') throw new Error('expected write-required plan');
    if (!initial.hashes.zenodoPayloadHash) throw new Error('expected Zenodo payload hash');

    const current = planPublicationSync({
      record: publicationRecord({ canonicalRevision: 99 }),
      files: fileManifest([file({ publicationRevision: 500 })]),
      identifiers: {
        zenodoVersionDoi: '10.5281/zenodo.1206',
        zenodoConceptDoi: '10.5281/zenodo.1205'
      },
      targets: zenodoMintTarget(),
      state: {
        zenodo: {
          environment: 'sandbox',
          identifierPolicy: 'mint-zenodo',
          lastSuccess: {
            payloadHash: initial.hashes.zenodoPayloadHash,
            fileManifestHash: initial.hashes.fileManifestHash
          },
          identifiers: {
            latestRecordId: '1206',
            parentId: '1205',
            versionDoi: '10.5281/zenodo.1206',
            conceptDoi: '10.5281/zenodo.1205'
          }
        }
      }
    });

    expect(current.status).toBe('noop');
    expect('operations' in current ? current.operations : []).toEqual([]);
  });

  it('plans a new Zenodo version when SHA-256 changes under mint-zenodo', () => {
    const initial = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([file({ sha256: SHA_A })]),
      identifiers: {},
      targets: zenodoMintTarget()
    });
    if (initial.status !== 'write_required') throw new Error('expected write-required plan');
    if (!initial.hashes.zenodoPayloadHash) throw new Error('expected Zenodo payload hash');

    const current = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([file({ sha256: SHA_B })]),
      identifiers: {
        zenodoVersionDoi: '10.5281/zenodo.1206',
        zenodoConceptDoi: '10.5281/zenodo.1205'
      },
      targets: zenodoMintTarget(),
      state: {
        zenodo: {
          environment: 'sandbox',
          identifierPolicy: 'mint-zenodo',
          lastSuccess: {
            payloadHash: initial.hashes.zenodoPayloadHash,
            fileManifestHash: initial.hashes.fileManifestHash
          },
          identifiers: {
            latestRecordId: '1206',
            parentId: '1205',
            versionDoi: '10.5281/zenodo.1206',
            conceptDoi: '10.5281/zenodo.1205'
          }
        }
      }
    });

    expect(current.status).toBe('write_required');
    expect('operations' in current ? current.operations : []).toEqual([
      expect.objectContaining({ type: 'zenodo_new_version', latestRecordId: '1206' })
    ]);
  });

  it('requires exact approval before replacing files on a Crossref-backed Zenodo record', () => {
    const baseline = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([file({ sha256: SHA_A })]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget()
    });
    if (baseline.status !== 'write_required' || !baseline.hashes.zenodoPayloadHash) {
      throw new Error('expected Zenodo baseline');
    }
    const nextFiles = fileManifest([file({ sha256: SHA_B })]);
    const state = {
      zenodo: {
        environment: 'sandbox' as const,
        identifierPolicy: 'reuse-crossref' as const,
        firstPublishedAt: new Date('2026-04-20T00:00:00.000Z'),
        lastSuccess: {
          payloadHash: baseline.hashes.zenodoPayloadHash,
          fileManifestHash: baseline.hashes.fileManifestHash
        },
        identifiers: {
          latestRecordId: '1205',
          parentId: '1205',
          versionDoi: '10.53832/opendeved.1205'
        }
      }
    };

    expect(planPublicationSync({
      record: publicationRecord(), files: nextFiles,
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(), state
    })).toEqual({
      status: 'needs_attention', provider: 'zenodo',
      reason: 'ZENODO_FILE_CORRECTION_APPROVAL_REQUIRED', operations: []
    });

    const approval = {
      id: 'approval-1', kind: 'minor_correction' as const, recordKey: 'REPORT01',
      doi: '10.53832/opendeved.1205',
      fileManifestHash: buildPublicationFileManifestHash(nextFiles),
      approvedAt: new Date('2026-05-20T00:00:00.000Z')
    };
    const stateWithoutPublicationTime = {
      environment: state.zenodo.environment,
      identifierPolicy: state.zenodo.identifierPolicy,
      lastSuccess: state.zenodo.lastSuccess,
      identifiers: state.zenodo.identifiers
    };
    expect(planPublicationSync({
      record: publicationRecord(), files: nextFiles,
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(),
      state: { zenodo: stateWithoutPublicationTime },
      zenodoFileChangeApproval: approval
    })).toEqual({
      status: 'needs_attention', provider: 'zenodo',
      reason: 'ZENODO_FIRST_PUBLICATION_TIME_REQUIRED', operations: []
    });
    const approved = planPublicationSync({
      observedAt: new Date('2026-05-20T00:00:00.000Z'),
      record: publicationRecord(), files: nextFiles,
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(), state,
      zenodoFileChangeApproval: approval
    });

    expect(approved.status).toBe('write_required');
    expect('operations' in approved ? approved.operations : []).toEqual([{
      type: 'zenodo_file_update',
      latestRecordId: '1205',
      payloadHash: baseline.hashes.zenodoPayloadHash,
      fileManifestHash: approval.fileManifestHash,
      removedFileKeys: [],
      approval,
      publishBy: new Date('2026-06-04T00:00:00.000Z')
    }]);

    expect(planPublicationSync({
      record: publicationRecord(), files: nextFiles,
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(),
      state: {
        zenodo: {
          ...state.zenodo,
          consumedFileCorrectionApprovalIds: ['approval-older', approval.id]
        }
      },
      zenodoFileChangeApproval: approval
    })).toEqual({
      status: 'needs_attention', provider: 'zenodo',
      reason: 'ZENODO_FILE_CORRECTION_APPROVAL_REQUIRED', operations: []
    });
  });

  it('accepts exact approval before replacing files on an external-DOI Zenodo record', () => {
    const identifiers = { bibliographicDoi: '10.1080/09500693.2021.1887' };
    const targets = {
      crossref: { enabled: false as const },
      zenodo: {
        enabled: true as const,
        environment: 'sandbox' as const,
        identifierPolicy: 'reuse-external' as const
      }
    };
    const baseline = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest([file({ sha256: SHA_A })]),
      identifiers,
      targets
    });
    if (baseline.status !== 'write_required' || !baseline.hashes.zenodoPayloadHash) {
      throw new Error('expected Zenodo baseline');
    }
    const nextFiles = fileManifest([file({ sha256: SHA_B })]);
    const approval = {
      id: 'approval-external',
      kind: 'minor_correction' as const,
      recordKey: 'REPORT01',
      doi: identifiers.bibliographicDoi,
      fileManifestHash: buildPublicationFileManifestHash(nextFiles),
      approvedAt: new Date('2026-05-20T00:00:00.000Z')
    };

    const plan = planPublicationSync({
      observedAt: approval.approvedAt,
      record: publicationRecord(),
      files: nextFiles,
      identifiers,
      targets,
      state: {
        zenodo: {
          environment: 'sandbox',
          identifierPolicy: 'reuse-external',
          firstPublishedAt: new Date('2026-04-20T00:00:00.000Z'),
          lastSuccess: {
            payloadHash: baseline.hashes.zenodoPayloadHash,
            fileManifestHash: baseline.hashes.fileManifestHash
          },
          identifiers: {
            latestRecordId: '1205',
            parentId: '1205',
            versionDoi: identifiers.bibliographicDoi
          }
        }
      },
      zenodoFileChangeApproval: approval
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations : []).toEqual([
      expect.objectContaining({
        type: 'zenodo_file_update',
        approval
      })
    ]);
  });

  it('closes the Crossref-backed correction window after day 30', () => {
    const baseline = planPublicationSync({
      record: publicationRecord(), files: fileManifest([file({ sha256: SHA_A })]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget()
    });
    if (baseline.status !== 'write_required' || !baseline.hashes.zenodoPayloadHash) {
      throw new Error('expected Zenodo baseline');
    }
    const nextFiles = fileManifest([file({ sha256: SHA_B })]);
    const plan = planPublicationSync({
      observedAt: new Date('2026-05-20T00:00:00.001Z'),
      record: publicationRecord(), files: nextFiles,
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(),
      state: {
        zenodo: {
          environment: 'sandbox', identifierPolicy: 'reuse-crossref',
          firstPublishedAt: new Date('2026-04-20T00:00:00.000Z'),
          lastSuccess: {
            payloadHash: baseline.hashes.zenodoPayloadHash,
            fileManifestHash: baseline.hashes.fileManifestHash
          },
          identifiers: { latestRecordId: '1205', parentId: '1205' }
        }
      },
      zenodoFileChangeApproval: {
        id: 'approval-late', kind: 'minor_correction', recordKey: 'REPORT01',
        doi: '10.53832/opendeved.1205',
        fileManifestHash: buildPublicationFileManifestHash(nextFiles),
        approvedAt: new Date('2026-05-20T00:00:00.001Z')
      }
    });

    expect(plan).toEqual({
      status: 'needs_attention', provider: 'zenodo',
      reason: 'ZENODO_FILE_CORRECTION_WINDOW_CLOSED', operations: []
    });
  });

  it('finishes an on-time approval after day 30 but before day 45', () => {
    const initial = planPublicationSync({
      record: publicationRecord(), files: fileManifest([file({ sha256: SHA_A })]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget()
    });
    if (initial.status !== 'write_required' || !initial.hashes.zenodoPayloadHash) {
      throw new Error('expected Zenodo baseline');
    }
    const nextFiles = fileManifest([file({ sha256: SHA_B })]);
    const plan = planPublicationSync({
      observedAt: new Date('2026-05-21T00:00:00.000Z'),
      record: publicationRecord(), files: nextFiles,
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(),
      state: {
        zenodo: {
          environment: 'sandbox', identifierPolicy: 'reuse-crossref',
          firstPublishedAt: new Date('2026-04-20T00:00:00.000Z'),
          lastSuccess: {
            payloadHash: initial.hashes.zenodoPayloadHash,
            fileManifestHash: initial.hashes.fileManifestHash
          },
          identifiers: { latestRecordId: '1205', parentId: '1205' }
        }
      },
      zenodoFileChangeApproval: {
        id: 'approval-on-time', kind: 'minor_correction', recordKey: 'REPORT01',
        doi: '10.53832/opendeved.1205',
        fileManifestHash: buildPublicationFileManifestHash(nextFiles),
        approvedAt: new Date('2026-05-20T00:00:00.000Z')
      }
    });

    expect(plan.status).toBe('write_required');
    expect('operations' in plan ? plan.operations : []).toEqual([
      expect.objectContaining({ type: 'zenodo_file_update' })
    ]);
  });

  it('discards an unfinished file-correction draft after day 45', () => {
    const approval = {
      id: 'approval-1', kind: 'minor_correction' as const, recordKey: 'REPORT01',
      doi: '10.53832/opendeved.1205', fileManifestHash: 'prepared-files',
      approvedAt: new Date('2026-05-01T00:00:00.000Z')
    };
    const state = {
      zenodo: {
        environment: 'sandbox' as const, identifierPolicy: 'reuse-crossref' as const,
        firstPublishedAt: new Date('2026-04-20T00:00:00.000Z'),
        journal: {
          operationType: 'zenodo_file_update' as const, depositionId: '42', draftRecordId: '42',
          payloadHash: 'prepared-payload', fileManifestHash: 'prepared-files',
          fileCorrectionApproval: approval, status: 'ready_to_publish' as const
        }
      }
    };
    const atDeadline = planPublicationSync({
      observedAt: new Date('2026-06-04T00:00:00.000Z'),
      record: publicationRecord(), files: fileManifest([]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(), state
    });
    expect('operations' in atDeadline ? atDeadline.operations : []).toEqual([{
      type: 'zenodo_publish_journaled_draft',
      originalOperationType: 'zenodo_file_update', depositionId: '42', draftRecordId: '42',
      payloadHash: 'prepared-payload', fileManifestHash: 'prepared-files',
      fileCorrectionApproval: approval,
      publishBy: new Date('2026-06-04T00:00:00.000Z')
    }]);

    const plan = planPublicationSync({
      observedAt: new Date('2026-06-04T00:00:00.001Z'),
      record: publicationRecord(), files: fileManifest([]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(), state
    });

    expect('operations' in plan ? plan.operations : []).toEqual([{
      type: 'zenodo_discard_expired_file_correction',
      originalOperationType: 'zenodo_file_update',
      depositionId: '42', draftRecordId: '42', reason: 'deadline_expired'
    }]);
  });

  it('uses the environment-matched settled Zenodo DOI instead of stale canonical input', () => {
    const zenodoBaseline = planPublicationSync({
      record: publicationRecord(), files: fileManifest(), identifiers: {},
      targets: zenodoMintTarget()
    });
    if (zenodoBaseline.status !== 'write_required' || !zenodoBaseline.hashes.zenodoPayloadHash) {
      throw new Error('expected Zenodo baseline');
    }
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: {
        managedCrossrefDoi: '10.53832/opendeved.1205',
        zenodoVersionDoi: '10.5281/zenodo.1206',
        zenodoConceptDoi: '10.5281/zenodo.1205'
      },
      targets: {
        crossref: { enabled: true, environment: 'test' },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
      },
      state: {
        zenodo: {
          environment: 'sandbox', identifierPolicy: 'mint-zenodo',
          lastSuccess: {
            payloadHash: zenodoBaseline.hashes.zenodoPayloadHash,
            fileManifestHash: zenodoBaseline.hashes.fileManifestHash
          },
          identifiers: {
            latestRecordId: '1207', parentId: '1205',
            versionDoi: '10.5281/zenodo.1207', conceptDoi: '10.5281/zenodo.1205'
          }
        }
      }
    });

    expect(plan.status).toBe('write_required');
    const crossrefOperation = 'operations' in plan
      ? plan.operations.find(({ type }) => type === 'crossref_redeposit')
      : undefined;
    expect(crossrefOperation).toMatchObject({
      relation: { identifier: '10.5281/zenodo.1207' }
    });
  });

  it('never exposes a Zotero writeback operation', () => {
    const plan = planPublicationSync({
      record: publicationRecord(),
      files: fileManifest(),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: {
        crossref: { enabled: true, environment: 'test' },
        zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-crossref' }
      }
    });

    expect('operations' in plan ? plan.operations.map(({ type }) => type) : []).not.toContain(
      'zotero_writeback'
    );
  });

  it('prioritizes durable orphaned-draft cleanup before any further Zenodo write', () => {
	const plan = planPublicationSync({
		record: publicationRecord(),
		files: fileManifest([]),
		identifiers: {},
		targets: zenodoMintTarget(),
		state: {
			zenodo: {
				environment: 'sandbox', identifierPolicy: 'mint-zenodo',
				orphanDraftCleanup: { depositionId: 'orphan-42' }
			}
		}
	});

	expect(plan.status).toBe('write_required');
	expect('operations' in plan ? plan.operations : []).toEqual([
		{ type: 'zenodo_cleanup_orphan_draft', depositionId: 'orphan-42' }
	]);
  });

  it('does not let file-correction approval rules block orphan cleanup', () => {
    const plan = planPublicationSync({
      record: publicationRecord(), files: fileManifest([file({ sha256: SHA_B })]),
      identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
      targets: zenodoReuseCrossrefTarget(),
      state: {
        zenodo: {
          environment: 'sandbox', identifierPolicy: 'reuse-crossref',
          lastSuccess: { payloadHash: 'old-payload', fileManifestHash: 'old-files' },
          identifiers: { latestRecordId: '42', parentId: '41' },
          orphanDraftCleanup: { depositionId: 'orphan-42' }
        }
      }
    });

    expect('operations' in plan ? plan.operations : []).toEqual([
      { type: 'zenodo_cleanup_orphan_draft', depositionId: 'orphan-42' }
    ]);
  });
});

function publicationRecord(overrides: Record<string, unknown> = {}) {
  return parsePublicationRecordSnapshot({
    recordKey: 'REPORT01',
    canonicalRevision: 4,
    itemType: 'Report',
    title: 'Evidence synthesis',
    publicationDate: '2026-08-11',
    abstract: 'A synthesis of the available evidence.',
    creators: [{ type: 'organizational', name: 'OpenDevEd' }],
    publisher: 'OpenDevEd',
    institution: 'OpenDevEd',
    tags: ['evidence'],
    landingUrl: 'https://example.org/items/REPORT01',
    fields: { reportNumber: '12', reportType: 'Research report' },
    ...overrides
  });
}

function fileManifest(files = [file()]) {
  return parsePublicationFileManifest({ files });
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    fileKey: 'FILE0001',
    publicationRevision: 1,
    filename: 'report.pdf',
    contentType: 'application/pdf',
    size: 1024,
    sha256: SHA_A,
    ...overrides
  };
}

function zenodoMintTarget() {
  return {
    crossref: { enabled: false as const },
    zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
  };
}

function zenodoReuseCrossrefTarget() {
  return {
    crossref: { enabled: false as const },
    zenodo: {
      enabled: true as const,
      environment: 'sandbox' as const,
      identifierPolicy: 'reuse-crossref' as const
    }
  };
}
