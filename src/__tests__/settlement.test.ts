import { describe, expect, it } from 'vitest';

import { planPublicationSync } from '../planner.js';
import { settleProviderSyncFailure, settlePublicationSyncState } from '../settlement.js';

const observedAt = new Date('2026-05-20T00:00:00.000Z');

function publicationPlan() {
	return planPublicationSync({
		record: {
			recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report',
			title: 'Evidence report', publicationDate: '2026-05-20', abstract: 'Evidence summary',
			creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
			publisher: 'OpenDevEd',
			landingUrl: 'https://example.org/items/ABC12345', fields: {}
		},
		files: {
			files: [{
				fileKey: 'FILE1234', publicationRevision: 1, filename: 'report.pdf',
				contentType: 'application/pdf', size: 3,
				sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
			}]
		},
		identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
		targets: {
			crossref: { enabled: true, environment: 'test' },
			zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-crossref' }
		}
	});
}

describe('provider-neutral settlement', () => {
	it('records host failures with the same consecutive counter used for provider failures', () => {
		expect(settleProviderSyncFailure({
			previousState: {
				failure: {
					provider: 'source',
					failureClass: 'ZOTERO_UNAVAILABLE',
					summary: 'Zotero could not be read',
					consecutiveCount: 2
				}
			},
			provider: 'worker',
			failureClass: 'STATE_WRITE_FAILED',
			failureSummary: 'The worker state could not be saved'
		})).toEqual({
			failure: {
				provider: 'worker',
				failureClass: 'STATE_WRITE_FAILED',
				summary: 'The worker state could not be saved',
				consecutiveCount: 3
			}
		});
	});

	it('attributes Zenodo planning failures to Zenodo', () => {
		const plan = planPublicationSync({
			record: {
				recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report', title: 'Report',
				publicationDate: '2026-05-20', abstract: 'Evidence summary',
				creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
				publisher: 'OpenDevEd',
				landingUrl: 'https://example.org/items/ABC12345', fields: {}
			},
			files: { files: [] },
			identifiers: { zenodoVersionDoi: '10.5281/zenodo.42' },
			targets: {
				crossref: { enabled: false },
				zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
			}
		});

		expect(settlePublicationSyncState({ plan, observedAt }).statePatch.failure).toMatchObject({
			provider: 'zenodo',
			failureClass: 'MISSING_ZENODO_PROVIDER_RECORD_ID'
		});
	});

	it('advances only operations that succeeded', () => {
		const plan = publicationPlan();
		expect(plan.status).toBe('write_required');
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			operationResults: [
				{ type: 'crossref_redeposit', status: 'succeeded' },
				{ type: 'zenodo_create', status: 'failed', failureClass: 'TimeoutError', failureSummary: 'timed out' }
			]
		});

		expect(settlement.statePatch.crossref?.lastSuccess?.payloadHash).toBe(
			plan.status === 'write_required' ? plan.hashes.crossrefPayloadHash : undefined
		);
		expect(settlement.statePatch.zenodo).toBeUndefined();
		expect(settlement.statePatch.failure).toMatchObject({
			provider: 'zenodo', failureClass: 'TimeoutError', consecutiveCount: 1
		});
	});

	it('stores Zenodo hashes, exact snapshots, and identifiers after success', () => {
		const plan = publicationPlan();
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			operationResults: [{
				type: 'zenodo_create', status: 'succeeded',
				zenodo: { latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42' }
			}]
		});

		expect(settlement.statePatch.zenodo).toMatchObject({
			lastSuccess: {
				payloadHash: plan.status === 'write_required' ? plan.hashes.zenodoPayloadHash : undefined,
				fileManifestHash: plan.status === 'write_required' ? plan.hashes.fileManifestHash : undefined
			},
			identifiers: { latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42' }
		});
	});

	it('records accepted Crossref deposits as pending without advancing last-success', () => {
		const plan = publicationPlan();
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			operationResults: [{
				type: 'crossref_redeposit', status: 'pending', pendingClass: 'CROSSREF_PENDING',
				pendingSummary: 'still indexing',
				crossref: { stage: 'deposit', batchId: 'batch-1', filename: 'batch-1.xml', submittedAt: observedAt }
			}]
		});

		expect(settlement.statePatch.crossref).toMatchObject({
			pending: { batchId: 'batch-1', filename: 'batch-1.xml', reason: 'still indexing' }
		});
		expect(settlement.statePatch.crossref?.lastSuccess).toBeUndefined();
	});

	it('preserves the original Crossref pending timestamp while verification remains pending', () => {
		const initialSubmittedAt = new Date('2026-05-19T00:00:00.000Z');
		const initial = publicationPlan();
		if (initial.status !== 'write_required') throw new Error('expected write-required plan');
		const payloadHash = initial.hashes.crossrefPayloadHash;
		if (!payloadHash) throw new Error('expected Crossref payload hash');
		const plan = planPublicationSync({
			record: initial.record,
			files: initial.files,
			identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
			targets: { crossref: { enabled: true, environment: 'test' }, zenodo: { enabled: false } },
			state: {
				crossref: {
					environment: 'test',
					pending: {
						stage: 'deposit',
						payloadHash, batchId: 'batch-1', filename: 'batch-1.xml',
						submittedAt: initialSubmittedAt, reason: 'still indexing'
					}
				}
			}
		});
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			crossrefPendingMaxAgeMs: 1_000,
			previousState: {
				crossref: {
					environment: 'test',
					pending: {
						stage: 'deposit',
						payloadHash, batchId: 'batch-1', filename: 'batch-1.xml',
						submittedAt: initialSubmittedAt, reason: 'still indexing'
					}
				}
			},
			operationResults: [{
				type: 'crossref_verify_pending', status: 'pending',
				pendingClass: 'CROSSREF_PENDING', pendingSummary: 'still indexing',
				crossref: { stage: 'deposit' }
			}]
		});

		expect(settlement.statePatch.crossref?.pending).toMatchObject({
			batchId: 'batch-1', filename: 'batch-1.xml', submittedAt: initialSubmittedAt
		});
		expect(settlement.statePatch.failure).toMatchObject({
			failureClass: 'CROSSREF_PENDING_STALE'
		});
	});

	it('does not settle failed Zenodo metadata when a sibling file update succeeds', () => {
		const baseline = publicationPlan();
		if (baseline.status !== 'write_required' || !baseline.hashes.zenodoPayloadHash) {
			throw new Error('expected Zenodo baseline');
		}
		const baselineFile = baseline.files.files[0];
		const baselinePayloadSnapshot = baseline.snapshots.zenodoPayload;
		if (!baselineFile || !baselinePayloadSnapshot) throw new Error('expected Zenodo snapshots');
		const previousState = {
			zenodo: {
				environment: 'sandbox' as const,
				identifierPolicy: 'reuse-crossref' as const,
				lastSuccess: {
					payloadHash: baseline.hashes.zenodoPayloadHash,
					payloadSnapshot: baselinePayloadSnapshot,
					fileManifestHash: baseline.hashes.fileManifestHash,
					fileManifestSnapshot: baseline.snapshots.fileManifest
				},
				identifiers: { latestRecordId: '42', parentId: '41', versionDoi: '10.53832/opendeved.1205' }
			}
		};
		const nextFile = {
			...baselineFile,
			sha256: 'b'.repeat(64)
		};
		const plan = planPublicationSync({
			record: { ...baseline.record, title: 'Updated metadata' },
			files: { files: [nextFile] },
			identifiers: baseline.identifiers,
			targets: baseline.targets,
			state: previousState
		});
		if (plan.status !== 'write_required') throw new Error('expected update plan');

		const settlement = settlePublicationSyncState({
			plan,
			previousState,
			observedAt,
			operationResults: [
				{ type: 'zenodo_metadata_update', status: 'failed', failureClass: 'TimeoutError', failureSummary: 'timed out' },
				{ type: 'zenodo_file_update', status: 'succeeded', zenodo: previousState.zenodo.identifiers }
			]
		});

		expect(settlement.statePatch.zenodo?.lastSuccess).toMatchObject({
			payloadHash: baseline.hashes.zenodoPayloadHash,
			fileManifestHash: plan.hashes.fileManifestHash
		});
	});

	it('preserves the previous failure when a write-required run is incomplete', () => {
		const plan = publicationPlan();
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			previousState: {
				failure: { provider: 'zenodo', failureClass: 'TimeoutError', summary: 'old', consecutiveCount: 2 }
			},
			operationResults: [{ type: 'crossref_redeposit', status: 'succeeded' }]
		});

		expect(settlement.statePatch.failure).toBeUndefined();
	});

	it('does not mutate provider state while Zenodo waits for a file', () => {
		const plan = planPublicationSync({
			record: {
				recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report', title: 'Report',
				publicationDate: '2026-05-20', abstract: 'Evidence summary',
				creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
				publisher: 'OpenDevEd',
				landingUrl: 'https://example.org/items/ABC12345', fields: {}
			},
			files: { files: [] }, identifiers: {},
			targets: { crossref: { enabled: false }, zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' } }
		});
		expect(settlePublicationSyncState({ plan, observedAt })).toEqual({ statePatch: {} });
	});

	it('does not pair a recovered journal hash with a newer current payload snapshot', () => {
		const base = publicationPlan();
		if (base.status !== 'write_required') throw new Error('expected write-required plan');
		const plan = planPublicationSync({
			record: { ...base.record, title: 'A newer local title' },
			files: base.files,
			identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
			targets: {
				crossref: { enabled: false },
				zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-crossref' }
			},
			state: {
				zenodo: {
					environment: 'sandbox',
					identifierPolicy: 'reuse-crossref',
					journal: {
						operationType: 'zenodo_create', depositionId: '42', draftRecordId: '42',
						payloadHash: 'prepared-payload', fileManifestHash: 'prepared-files',
						status: 'ready_to_publish'
					}
				}
			}
		});
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			operationResults: [{
				type: 'zenodo_publish_journaled_draft', status: 'succeeded',
				zenodo: { latestRecordId: '42', parentId: '41' }
			}]
		});

		expect(settlement.statePatch.zenodo?.lastSuccess).toMatchObject({
			payloadHash: 'prepared-payload', fileManifestHash: 'prepared-files'
		});
		expect(settlement.statePatch.zenodo?.lastSuccess?.payloadSnapshot).toBeUndefined();
		expect(settlement.statePatch.zenodo?.lastSuccess?.fileManifestSnapshot).toBeUndefined();
	});

	it('persists failed orphan cleanup for retry without losing adopted Zenodo identifiers', () => {
		const plan = publicationPlan();
		const settlement = settlePublicationSyncState({
			plan,
			observedAt,
			operationResults: [{
				type: 'zenodo_create', status: 'succeeded', zenodoAdoptionOnly: true,
				zenodo: { latestRecordId: '50', parentId: '49', versionDoi: '10.53832/opendeved.1205' },
				zenodoOrphanDraftCleanup: {
					status: 'failed', depositionId: '42', failureClass: 'TimeoutError', failureSummary: 'timed out'
				}
			}]
		});

		expect(settlement.statePatch.zenodo).toMatchObject({
			identifiers: { latestRecordId: '50', parentId: '49' },
			orphanDraftCleanup: { depositionId: '42' }
		});
		expect(settlement.statePatch.failure).toMatchObject({
			provider: 'zenodo', failureClass: 'TimeoutError', summary: 'timed out'
		});
	});

	it('clears durable orphan cleanup state only after deletion succeeds', () => {
		const plan = planPublicationSync({
			record: {
				recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report', title: 'Report',
				publicationDate: '2026-05-20', abstract: 'Evidence summary', publisher: 'OpenDevEd',
				creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
				landingUrl: 'https://example.org/items/ABC12345', fields: {}
			},
			files: { files: [] }, identifiers: {},
			targets: {
				crossref: { enabled: false },
				zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
			},
			state: {
				zenodo: {
					environment: 'sandbox', identifierPolicy: 'mint-zenodo',
					orphanDraftCleanup: { depositionId: '42' }
				}
			}
		});
		const settlement = settlePublicationSyncState({
			plan, observedAt,
			operationResults: [{ type: 'zenodo_cleanup_orphan_draft', status: 'succeeded' }]
		});

		expect(settlement.statePatch.zenodo?.orphanDraftCleanup).toBeNull();
		expect(settlement.statePatch.failure).toBeNull();
	});
});
