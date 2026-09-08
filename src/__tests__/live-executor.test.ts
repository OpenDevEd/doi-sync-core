import { describe, expect, it, vi } from 'vitest';

import {
	executeLivePublicationSyncPlan,
	type CrossrefDepositor,
	type ExecuteLivePublicationSyncPlanInput,
	type ZenodoPublishJournalWriter,
	type ZenodoWriter
} from '../executor/live-executor.js';
import { planPublicationSync } from './plan-fixture.js';
import type { PublicationFile } from '../publication/files.js';
import type { PublicationTargetPolicy } from '../publication/targets.js';
import { ProviderHttpError } from '../resilience/errors.js';

const bytes = new Uint8Array([1, 2, 3]);
const zenodoPublishedAt = new Date('2026-04-20T00:00:00.000Z');
const file: PublicationFile = {
	fileKey: 'FILE1234', publicationRevision: 1, filename: 'report.pdf',
	contentType: 'application/pdf', size: 3,
	sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
};

function plan(targets: PublicationTargetPolicy) {
	return planPublicationSync({
		record: {
			recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report',
			title: 'Evidence report', publicationDate: '2026-05-20', abstract: 'Evidence summary',
			publisher: 'OpenDevEd', creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
			landingUrl: 'https://example.org/items/ABC12345', fields: {}
		},
		files: { files: [file] },
		identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
		targets
	});
}

function fileCorrectionPlan() {
	const targets = {
		crossref: { enabled: false as const },
		zenodo: {
			enabled: true as const,
			environment: 'sandbox' as const,
			identifierPolicy: 'reuse-crossref' as const
		}
	};
	const current = plan(targets);
	if (current.status !== 'write_required' || !current.hashes.zenodoPayloadHash) {
		throw new Error('expected Zenodo baseline');
	}
	const approval = {
		id: 'approval-1', kind: 'minor_correction' as const,
		recordKey: current.record.recordKey, doi: '10.53832/opendeved.1205',
		fileManifestHash: current.hashes.fileManifestHash,
		approvedAt: new Date('2026-05-20T00:00:00.000Z')
	};
	const correction = planPublicationSync({
		observedAt: new Date('2026-05-20T00:00:00.000Z'),
		record: current.record, files: current.files,
		identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
		targets,
		state: {
			zenodo: {
				environment: 'sandbox', identifierPolicy: 'reuse-crossref',
				firstPublishedAt: new Date('2026-04-20T00:00:00.000Z'),
				lastSuccess: {
					payloadHash: current.hashes.zenodoPayloadHash,
					fileManifestHash: 'previous-files'
				},
				identifiers: { latestRecordId: '42', parentId: '41' }
			}
		},
		zenodoFileChangeApproval: approval
	});
	if (correction.status !== 'write_required') throw new Error('expected file correction plan');
	return { correction, approval };
}

function crossref(overrides: Partial<CrossrefDepositor> = {}): CrossrefDepositor {
	return {
		submitPublication: vi.fn(() => Promise.resolve({
			status: 'succeeded' as const, filename: 'deposit.xml',
			diagnostic: {
				status: 'success' as const,
				batchId: 'batch',
				recordCount: 1,
				successCount: 1,
				failureCount: 0,
				records: []
			}
		})),
		verifyPublication: vi.fn(() => Promise.resolve({ status: 'matched' as const })),
		...overrides
	};
}

function zenodo(overrides: Partial<ZenodoWriter> = {}): ZenodoWriter {
	const draft = { depositionId: '42', draftRecordId: '42', parentId: '41' };
	return {
		discardPreparedDraft: vi.fn(() => Promise.resolve()),
		prepareCreateRecord: vi.fn(async (input: Parameters<ZenodoWriter['prepareCreateRecord']>[0]) => {
			await input.onPreparedDraft?.(draft);
			return draft;
		}),
		prepareUpdateRecordMetadata: vi.fn(() => Promise.resolve(draft)),
		prepareUpdateRecordFiles: vi.fn(() => Promise.resolve(draft)),
		prepareNewVersion: vi.fn(() => Promise.resolve(draft)),
		publishDraft: vi.fn(() => Promise.resolve({
			latestRecordId: '42', parentId: '41', publishedAt: zenodoPublishedAt, links: {}
		})),
		...overrides
	};
}

function zenodoJournal() {
	return {
		recordZenodoPublishDraft: vi.fn<ZenodoPublishJournalWriter['recordZenodoPublishDraft']>(() => Promise.resolve()),
		markZenodoPublishDraftPublished: vi.fn<ZenodoPublishJournalWriter['markZenodoPublishDraftPublished']>(() => Promise.resolve()),
		clearZenodoPublishDraft: vi.fn<ZenodoPublishJournalWriter['clearZenodoPublishDraft']>(() => Promise.resolve()),
		clearZenodoOrphanDraftCleanup: vi.fn<ZenodoPublishJournalWriter['clearZenodoOrphanDraftCleanup']>(() => Promise.resolve())
	};
}

function executionInput(
	targets: PublicationTargetPolicy,
	overrides: Partial<ExecuteLivePublicationSyncPlanInput> = {}
): ExecuteLivePublicationSyncPlanInput {
	return {
		plan: plan(targets),
		credentials: { zenodoToken: 'sandbox-token' },
		providers: { crossref: crossref(), zenodo: zenodo() },
		fileReader: { readFile: vi.fn(() => Promise.resolve(bytes)) },
		crossref: {
			loginId: 'login', password: 'password',
			depositorName: 'OpenDevEd', emailAddress: 'doi@example.org', registrant: 'OpenDevEd'
		},
		crossrefJournal: { recordCrossrefPendingDeposit: vi.fn(() => Promise.resolve()) },
		...overrides
	};
}

describe('provider-neutral live executor', () => {
	it('reads host-owned bytes, verifies SHA-256, journals, and publishes Zenodo', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const provider = zenodo();
		const journal = zenodoJournal();
		const input = executionInput(targets, {
			providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: journal
		});

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([{
			type: 'zenodo_create', status: 'succeeded',
			zenodoPublishedAt,
			zenodo: { latestRecordId: '42', parentId: '41' }
		}]);
		expect(provider.prepareCreateRecord).toHaveBeenCalledWith(expect.objectContaining({
			doiPolicy: 'dual',
			files: [{ key: 'FILE1234', filename: 'report.pdf', contentType: 'application/pdf', bytes }]
		}));
		expect(journal.recordZenodoPublishDraft).toHaveBeenCalledWith(expect.objectContaining({
			recordId: 'ABC12345', environment: 'sandbox', operationType: 'zenodo_create'
		}));
		expect(journal.recordZenodoPublishDraft).toHaveBeenNthCalledWith(1, expect.objectContaining({
			status: 'preparing'
		}));
		expect(journal.recordZenodoPublishDraft).toHaveBeenNthCalledWith(2, expect.objectContaining({
			status: 'ready_to_publish'
		}));
		expect(journal.markZenodoPublishDraftPublished).toHaveBeenCalledOnce();
	});

	it('journals the exact file-correction approval and refuses to publish after day 45', async () => {
		const { correction, approval } = fileCorrectionPlan();
		const journal = zenodoJournal();
		const draft = { depositionId: '42', draftRecordId: '42', parentId: '41' };
		const provider = zenodo({
			prepareUpdateRecordFiles: vi.fn(async (
				request: Parameters<ZenodoWriter['prepareUpdateRecordFiles']>[0]
			) => {
				await request.onPreparedDraft?.(draft);
				return draft;
			})
		});
		const now = vi.fn()
			.mockReturnValueOnce(new Date('2026-06-03T00:00:00.000Z'))
			.mockReturnValueOnce(new Date('2026-06-03T00:00:00.000Z'))
			.mockReturnValueOnce(new Date('2026-06-04T00:00:00.001Z'));

		await expect(executeLivePublicationSyncPlan({
			plan: correction,
			credentials: { zenodoToken: 'sandbox-token' },
			providers: { zenodo: provider },
			fileReader: { readFile: () => Promise.resolve(bytes) },
			zenodoJournal: journal,
			now
		})).resolves.toEqual([{
			type: 'zenodo_file_update', status: 'failed',
			failureClass: 'ZENODO_FILE_CORRECTION_WINDOW_CLOSED',
			failureSummary: 'The Zenodo file correction was not published before its 45-day deadline'
		}]);

		expect(journal.recordZenodoPublishDraft).toHaveBeenCalledTimes(2);
		expect(journal.recordZenodoPublishDraft).toHaveBeenNthCalledWith(
			1, expect.objectContaining({ status: 'preparing', fileCorrectionApproval: approval })
		);
		expect(journal.recordZenodoPublishDraft).toHaveBeenNthCalledWith(
			2, expect.objectContaining({ status: 'ready_to_publish', fileCorrectionApproval: approval })
		);
		expect(provider.publishDraft).not.toHaveBeenCalled();
		expect(provider.discardPreparedDraft).toHaveBeenCalledOnce();
		expect(journal.clearZenodoPublishDraft).toHaveBeenCalledOnce();
	});

	it('rejects bytes that do not match the canonical manifest before provider preparation', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const provider = zenodo();
		const input = executionInput(targets, {
			providers: { crossref: crossref(), zenodo: provider },
			fileReader: { readFile: () => Promise.resolve(new Uint8Array([9, 9, 9])) },
			zenodoJournal: zenodoJournal()
		});

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([{
			type: 'zenodo_create', status: 'failed', failureClass: 'Error',
			failureSummary: 'Published file FILE1234 SHA-256 does not match its manifest'
		}]);
		expect(provider.prepareCreateRecord).not.toHaveBeenCalled();
	});

	it('rejects bytes whose size differs from the canonical manifest', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: {
				enabled: true as const,
				environment: 'sandbox' as const,
				identifierPolicy: 'mint-zenodo' as const
			}
		};
		const input = executionInput(targets, {
			fileReader: { readFile: () => Promise.resolve(new Uint8Array([1])) },
			zenodoJournal: zenodoJournal()
		});

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([{
			type: 'zenodo_create', status: 'failed', failureClass: 'Error',
			failureSummary: 'Published file FILE1234 size does not match its manifest'
		}]);
	});

	it('adopts an exact existing Zenodo record only for reuse-crossref collisions', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'reuse-crossref' as const }
		};
		const provider = zenodo({
			prepareCreateRecord: vi.fn(() => Promise.reject(new ProviderHttpError({
				provider: 'zenodo', status: 400,
				body: '{"errors":[{"field":"pids.doi","messages":["already exists"]}]}'
			}))),
			findRecordByDoi: vi.fn(() => Promise.resolve({
				status: 'found' as const,
				record: { kind: 'published_record' as const, identifiers: {
					latestRecordId: '50', parentId: '49', versionDoi: '10.53832/opendeved.1205',
					publishedAt: zenodoPublishedAt, links: {}
				} }
			}))
		});
		const input = executionInput(targets, {
			providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: zenodoJournal()
		});

		const results = await executeLivePublicationSyncPlan(input);
		expect(results).toContainEqual({
			type: 'zenodo_create', status: 'succeeded', zenodoAdoptionOnly: true,
			zenodoPublishedAt,
			zenodo: { latestRecordId: '50', parentId: '49', versionDoi: '10.53832/opendeved.1205' }
		});
	});

	it('adopts a journaled draft that Zenodo already published when publish answers 404', async () => {
		// The first run published the draft on Zenodo, then our settlement
		// failed before the journal was cleared. The retry must not loop on
		// the 404 forever: the published record keeps the draft's id.
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const base = plan(targets);
		if (base.status !== 'write_required' || !base.hashes.zenodoPayloadHash) throw new Error('expected Zenodo baseline');
		const journaled = planPublicationSync({
			record: base.record, files: base.files, identifiers: {}, targets,
			state: {
				zenodo: {
					environment: 'sandbox', identifierPolicy: 'mint-zenodo',
					journal: {
						operationType: 'zenodo_create', depositionId: '42', draftRecordId: '42', parentId: '41',
						payloadHash: base.hashes.zenodoPayloadHash, fileManifestHash: base.hashes.fileManifestHash,
						status: 'ready_to_publish'
					}
				}
			}
		});
		expect(journaled.status).toBe('write_required');
		// A class instance: the executor must call the method on the provider,
		// not detach it, or `this` is lost.
		class RecordingProvider {
			readonly calls: unknown[] = [];
			readPublishedRecord(request: { token: string; recordId: string }) {
				this.calls.push(request);
				return Promise.resolve({
					latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42', conceptDoi: '10.5281/zenodo.41',
					publishedAt: zenodoPublishedAt, links: {}
				});
			}
		}
		const recording = new RecordingProvider();
		const provider = Object.assign(recording, zenodo({
			publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({
				provider: 'zenodo', status: 404, body: '{"status": 404, "message": "Not found."}'
			})))
		}));
		const journal = zenodoJournal();
		const results = await executeLivePublicationSyncPlan(executionInput(targets, {
			plan: journaled,
			providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: journal
		}));

		expect(recording.calls).toEqual([{ token: 'sandbox-token', recordId: '42' }]);
		expect(results).toEqual([{
			type: 'zenodo_publish_journaled_draft', status: 'succeeded', zenodoAdoptionOnly: true,
			zenodoPublishedAt,
			zenodo: { latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42', conceptDoi: '10.5281/zenodo.41' }
		}]);
		expect(journal.markZenodoPublishDraftPublished).toHaveBeenCalledOnce();
	});

	it('keeps failing when publish answers 404 and no published record exists under the draft id', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const base = plan(targets);
		if (base.status !== 'write_required' || !base.hashes.zenodoPayloadHash) throw new Error('expected Zenodo baseline');
		const journaled = planPublicationSync({
			record: base.record, files: base.files, identifiers: {}, targets,
			state: { zenodo: { environment: 'sandbox', identifierPolicy: 'mint-zenodo', journal: {
				operationType: 'zenodo_create', depositionId: '42', draftRecordId: '42', parentId: '41',
				payloadHash: base.hashes.zenodoPayloadHash, fileManifestHash: base.hashes.fileManifestHash, status: 'ready_to_publish'
			} } }
		});
		const provider = zenodo({
			publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({ provider: 'zenodo', status: 404, body: '{"status": 404}' }))),
			readPublishedRecord: vi.fn(() => Promise.resolve(null))
		});
		const results = await executeLivePublicationSyncPlan(executionInput(targets, {
			plan: journaled,
			providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: zenodoJournal()
		}));
		expect(results[0]).toMatchObject({ type: 'zenodo_publish_journaled_draft', status: 'failed', failureClass: 'ProviderHttpError' });
	});

	it('does not adopt an unchanged published record for a failed metadata update', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const base = plan(targets);
		if (base.status !== 'write_required' || !base.hashes.zenodoPayloadHash) throw new Error('expected Zenodo baseline');
		const journaled = planPublicationSync({
			record: base.record, files: base.files, identifiers: {}, targets,
			state: { zenodo: {
				environment: 'sandbox', identifierPolicy: 'mint-zenodo',
				journal: {
				operationType: 'zenodo_metadata_update', depositionId: '42', draftRecordId: '42', parentId: '41',
				payloadHash: base.hashes.zenodoPayloadHash, status: 'ready_to_publish'
			} } }
		});
		const readPublishedRecord = vi.fn(() => Promise.resolve({
			latestRecordId: '42', parentId: '41', versionDoi: '10.5281/zenodo.42',
			publishedAt: zenodoPublishedAt, links: {}
		}));
		const provider = zenodo({
			publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({ provider: 'zenodo', status: 404, body: '{"status": 404}' }))),
			readPublishedRecord
		});
		const results = await executeLivePublicationSyncPlan(executionInput(targets, {
			plan: journaled,
			providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: zenodoJournal(),
			now: () => new Date('2026-05-21T00:00:00.000Z')
		}));

		expect(readPublishedRecord).not.toHaveBeenCalled();
		expect(results[0]).toMatchObject({
			type: 'zenodo_publish_journaled_draft',
			status: 'failed',
			failureClass: 'ProviderHttpError'
		});
	});

	it('journals orphan cleanup before deletion and preserves provider method binding', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'reuse-crossref' as const }
		};
		const events: string[] = [];
		const journal = zenodoJournal();
		journal.markZenodoPublishDraftPublished.mockImplementation((entry) => {
			events.push(`journal:${entry.orphanDraftCleanup?.depositionId ?? 'none'}`);
			return Promise.resolve();
		});
		journal.clearZenodoOrphanDraftCleanup.mockImplementation(() => {
			events.push('journal:cleared');
			return Promise.resolve();
		});
		const base = zenodo({
			publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({
				provider: 'zenodo', status: 400,
				body: '{"errors":[{"field":"pids.doi","messages":["already exists"]}]}'
			}))),
			findRecordByDoi: vi.fn(() => Promise.resolve({
				status: 'found' as const,
				record: { kind: 'published_record' as const, identifiers: {
					latestRecordId: '50', parentId: '49', versionDoi: '10.53832/opendeved.1205',
					publishedAt: zenodoPublishedAt, links: {}
				} }
			}))
		});
		const provider = {
			...base,
			bindingMarker: 'bound',
			deleteUnpublishedDraft(input: { readonly depositionId: string }) {
				if (this.bindingMarker !== 'bound') throw new Error('provider method lost its binding');
				events.push(`delete:${input.depositionId}`);
				return Promise.resolve();
			}
		};

		const results = await executeLivePublicationSyncPlan(executionInput(targets, {
			providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: journal
		}));

		expect(results).toContainEqual({
			type: 'zenodo_create', status: 'succeeded', zenodoAdoptionOnly: true,
			zenodoPublishedAt,
			zenodo: { latestRecordId: '50', parentId: '49', versionDoi: '10.53832/opendeved.1205' },
			zenodoOrphanDraftCleanup: { status: 'deleted', depositionId: '42' }
		});
		expect(events).toEqual(['journal:42', 'delete:42', 'journal:cleared']);
	});

	it('keeps the orphan marker durable when cleanup fails after adoption', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'reuse-crossref' as const }
		};
		const journal = zenodoJournal();
		const provider = zenodo({
			publishDraft: vi.fn(() => Promise.reject(new ProviderHttpError({
				provider: 'zenodo', status: 400,
				body: '{"errors":[{"field":"pids.doi","messages":["already exists"]}]}'
			}))),
			findRecordByDoi: vi.fn(() => Promise.resolve({
				status: 'found' as const,
				record: { kind: 'published_record' as const, identifiers: {
					latestRecordId: '50', parentId: '49', versionDoi: '10.53832/opendeved.1205',
					publishedAt: zenodoPublishedAt, links: {}
				} }
			})),
			deleteUnpublishedDraft: vi.fn(() => Promise.reject(new Error('cleanup unavailable')))
		});

		const results = await executeLivePublicationSyncPlan(executionInput(targets, {
			providers: { crossref: crossref(), zenodo: provider }, zenodoJournal: journal
		}));

		expect(journal.markZenodoPublishDraftPublished).toHaveBeenCalledWith(expect.objectContaining({
			orphanDraftCleanup: { depositionId: '42' }
		}));
		expect(journal.clearZenodoOrphanDraftCleanup).not.toHaveBeenCalled();
		const result = results.find(({ type }) => type === 'zenodo_create');
		expect(result?.status).toBe('succeeded');
		if (result?.status !== 'succeeded') throw new Error('expected successful Zenodo adoption');
		expect(result.zenodoOrphanDraftCleanup).toMatchObject({ status: 'failed', depositionId: '42' });
	});

	it('retries a durably recorded orphaned Zenodo draft deletion', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const cleanup = vi.fn(() => Promise.resolve());
		const journal = zenodoJournal();
		const cleanupPlan = planPublicationSync({
			record: {
				recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report', title: 'Evidence report',
				publicationDate: '2026-05-20', abstract: 'Evidence summary', publisher: 'OpenDevEd',
				creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
				landingUrl: 'https://example.org/items/ABC12345', fields: {}
			},
			files: { files: [] }, identifiers: {}, targets,
			state: {
				zenodo: {
					environment: 'sandbox', identifierPolicy: 'mint-zenodo',
					orphanDraftCleanup: { depositionId: 'orphan-42' }
				}
			}
		});

		await expect(executeLivePublicationSyncPlan(executionInput(targets, {
			plan: cleanupPlan,
			providers: { zenodo: zenodo({ deleteUnpublishedDraft: cleanup }) },
			zenodoJournal: journal
		}))).resolves.toEqual([{ type: 'zenodo_cleanup_orphan_draft', status: 'succeeded' }]);
		expect(cleanup).toHaveBeenCalledWith({ token: 'sandbox-token', depositionId: 'orphan-42' });
		expect(journal.clearZenodoOrphanDraftCleanup).toHaveBeenCalledWith(expect.objectContaining({
			recordId: 'ABC12345', environment: 'sandbox', depositionId: 'orphan-42'
		}));
	});

	it('refuses orphan cleanup without durable journal storage', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'mint-zenodo' as const }
		};
		const cleanup = vi.fn(() => Promise.resolve());
		const base = plan(targets);
		if (!('record' in base)) throw new Error('expected valid plan fixture');
		const cleanupPlan = planPublicationSync({
			record: base.record,
			files: { files: [] }, identifiers: {}, targets,
			state: { zenodo: {
				environment: 'sandbox', identifierPolicy: 'mint-zenodo',
				orphanDraftCleanup: { depositionId: 'orphan-42' }
			} }
		});

		await expect(executeLivePublicationSyncPlan(executionInput(targets, {
			plan: cleanupPlan,
			providers: { zenodo: zenodo({ deleteUnpublishedDraft: cleanup }) }
		}))).resolves.toEqual([{
			type: 'zenodo_cleanup_orphan_draft', status: 'failed', failureClass: 'ZENODO_JOURNAL_REQUIRED',
			failureSummary: 'Cannot delete an orphaned Zenodo draft without journal storage'
		}]);
		expect(cleanup).not.toHaveBeenCalled();
	});

	it('executes the normalized DOI that was hashed into the Zenodo plan', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: true as const, environment: 'sandbox' as const, identifierPolicy: 'reuse-crossref' as const }
		};
		const base = plan(targets);
		if (!('record' in base)) throw new Error('expected valid plan fixture');
		const normalizedPlan = planPublicationSync({
			record: base.record,
			files: base.files,
			identifiers: { managedCrossrefDoi: 'https://doi.org/10.53832/OpenDevEd.1205' },
			targets
		});
		let executedDoi: string | undefined;
		const provider = zenodo({
			prepareCreateRecord: vi.fn(async (input: Parameters<ZenodoWriter['prepareCreateRecord']>[0]) => {
				executedDoi = input.metadata.doi;
				const draft = { depositionId: '42', draftRecordId: '42', parentId: '41' };
				await input.onPreparedDraft?.(draft);
				return draft;
			})
		});

		await executeLivePublicationSyncPlan(executionInput(targets, {
			plan: normalizedPlan, providers: { crossref: crossref(), zenodo: provider },
			zenodoJournal: zenodoJournal()
		}));

		expect(provider.prepareCreateRecord).toHaveBeenCalledOnce();
		expect(executedDoi).toBe('10.53832/opendeved.1205');
	});

	it('journals accepted Crossref submission before returning pending', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: false as const }
		};
		const journal = { recordCrossrefPendingDeposit: vi.fn(() => Promise.resolve()) };
		const depositor = crossref({
			submitPublication: vi.fn(async (request: Parameters<CrossrefDepositor['submitPublication']>[0]) => {
				await request.onSubmitted?.();
				return { status: 'pending' as const, filename: request.filename };
			})
		});
		const input = executionInput(targets, {
			providers: { crossref: depositor, zenodo: zenodo() },
			crossrefJournal: journal
		});

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([
			expect.objectContaining({ type: 'crossref_redeposit', status: 'pending' })
		]);
		const payloadHash = input.plan.status === 'write_required'
			? input.plan.hashes.crossrefPayloadHash
			: undefined;
		expect(journal.recordCrossrefPendingDeposit).toHaveBeenCalledWith(expect.objectContaining({
			recordId: 'ABC12345', environment: 'test', stage: 'deposit', payloadHash
		}));
	});

	it('persists a pending relation-clear stage without submitting the desired Crossref payload', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: false as const }
		};
		const base = plan(targets);
		if (base.status !== 'write_required') throw new Error('expected Crossref plan');
		const clearPlan = {
			...base,
			operations: base.operations.map((operation) => operation.type === 'crossref_redeposit'
				? { ...operation, clearRelations: true as const }
				: operation)
		};
		const journal = { recordCrossrefPendingDeposit: vi.fn(() => Promise.resolve()) };
		const provider = crossref({
			submitPublication: vi.fn(async (request: Parameters<CrossrefDepositor['submitPublication']>[0]) => {
				await request.onSubmitted?.();
				return { status: 'pending' as const, filename: 'clear.xml' };
			})
		});

		const results = await executeLivePublicationSyncPlan(executionInput(targets, {
			plan: clearPlan,
			providers: { crossref: provider },
			crossrefJournal: journal
		}));

		expect(results).toHaveLength(1);
		const [result] = results;
		expect(result).toMatchObject({ type: 'crossref_redeposit', status: 'pending' });
		expect(result?.status === 'pending' ? result.crossref.stage : undefined).toBe('relation_clear');
		expect(provider.submitPublication).toHaveBeenCalledTimes(1);
		expect(provider.submitPublication).toHaveBeenCalledWith(expect.objectContaining({
			relation: 'delete-all'
		}));
		expect(journal.recordCrossrefPendingDeposit).toHaveBeenCalledWith(expect.objectContaining({
			stage: 'relation_clear'
		}));
	});

	it('submits the desired Crossref payload only after a pending relation clear verifies', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: false as const }
		};
		const base = plan(targets);
		if (base.status !== 'write_required' || !base.hashes.crossrefPayloadHash) {
			throw new Error('expected Crossref plan');
		}
		const resumedPlan = planPublicationSync({
			record: base.record,
			files: base.files,
			identifiers: base.identifiers,
			targets,
			state: {
				crossref: {
					environment: 'test',
					pending: {
						stage: 'relation_clear', payloadHash: base.hashes.crossrefPayloadHash,
						batchId: 'clear-1', filename: 'clear-1.xml'
					}
				}
			}
		});
		const provider = crossref();

		await expect(executeLivePublicationSyncPlan(executionInput(targets, {
			plan: resumedPlan,
			providers: { crossref: provider }
		}))).resolves.toEqual([{ type: 'crossref_verify_pending', status: 'succeeded' }]);

		expect(provider.verifyPublication).toHaveBeenCalledWith(expect.objectContaining({
			relation: 'delete-all'
		}));
		const desiredSubmission = vi.mocked(provider.submitPublication).mock.calls[0]?.[0];
		expect(desiredSubmission?.relation).toBeUndefined();
	});

	it('executes Crossref-only plans without Zenodo dependencies', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: false as const }
		};
		const input: ExecuteLivePublicationSyncPlanInput = {
			plan: plan(targets),
			credentials: {},
			providers: { crossref: crossref() },
			crossref: {
				loginId: 'login', password: 'password', depositorName: 'OpenDevEd',
				emailAddress: 'doi@example.org', registrant: 'OpenDevEd'
			},
			crossrefJournal: { recordCrossrefPendingDeposit: vi.fn(() => Promise.resolve()) }
		};

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([
			{ type: 'crossref_redeposit', status: 'succeeded' }
		]);
	});

	it('refuses to upload Crossref metadata without durable journal storage', async () => {
		const targets = {
			crossref: { enabled: true as const, environment: 'test' as const },
			zenodo: { enabled: false as const }
		};
		const provider = crossref();
		const input: ExecuteLivePublicationSyncPlanInput = {
			plan: plan(targets), credentials: {}, providers: { crossref: provider },
			crossref: {
				loginId: 'login', password: 'password', depositorName: 'OpenDevEd',
				emailAddress: 'doi@example.org', registrant: 'OpenDevEd'
			}
		};

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([{
			type: 'crossref_redeposit', status: 'failed', failureClass: 'Error',
			failureSummary: 'Crossref submission requires durable journal storage'
		}]);
		expect(provider.submitPublication).not.toHaveBeenCalled();
	});

	it('executes Zenodo-only plans without Crossref dependencies', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: {
				enabled: true as const, environment: 'sandbox' as const,
				identifierPolicy: 'mint-zenodo' as const
			}
		};
		const input: ExecuteLivePublicationSyncPlanInput = {
			plan: plan(targets),
			credentials: { zenodoToken: 'sandbox-token' },
			providers: { zenodo: zenodo() },
			fileReader: { readFile: () => Promise.resolve(bytes) },
			zenodoJournal: zenodoJournal()
		};

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([{
			type: 'zenodo_create', status: 'succeeded', zenodoPublishedAt,
			zenodo: { latestRecordId: '42', parentId: '41' }
		}]);
	});

	it('executes Zenodo updates against the record id bound into the plan', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: {
				enabled: true as const, environment: 'sandbox' as const,
				identifierPolicy: 'mint-zenodo' as const
			}
		};
		const baseline = plan(targets);
		if (baseline.status !== 'write_required' || !baseline.hashes.zenodoPayloadHash) {
			throw new Error('expected Zenodo baseline');
		}
		const updatePlan = planPublicationSync({
			record: { ...baseline.record, title: 'Updated evidence report' },
			files: baseline.files,
			identifiers: {},
			targets,
			state: {
				zenodo: {
					environment: 'sandbox', identifierPolicy: 'mint-zenodo',
					lastSuccess: {
						payloadHash: baseline.hashes.zenodoPayloadHash,
						fileManifestHash: baseline.hashes.fileManifestHash
					},
					identifiers: { latestRecordId: 'planned-record', parentId: 'planned-parent' }
				}
			}
		});
		const provider = zenodo();
		const input: ExecuteLivePublicationSyncPlanInput = {
			plan: updatePlan,
			credentials: { zenodoToken: 'sandbox-token' },
			providers: { zenodo: provider },
			zenodoJournal: zenodoJournal()
		};

		await executeLivePublicationSyncPlan(input);

		expect(provider.prepareUpdateRecordMetadata).toHaveBeenCalledWith(expect.objectContaining({
			latestRecordId: 'planned-record'
		}));
	});

	it('durably marks a draft as preparing before a later preparation failure', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: {
				enabled: true as const, environment: 'sandbox' as const,
				identifierPolicy: 'mint-zenodo' as const
			}
		};
		const journal = zenodoJournal();
		const provider = zenodo({
			prepareCreateRecord: vi.fn(async (request: Parameters<ZenodoWriter['prepareCreateRecord']>[0]) => {
				await request.onPreparedDraft?.({ depositionId: '42', draftRecordId: '42' });
				throw new Error('metadata write failed');
			})
		});
		const input = executionInput(targets, {
			providers: { zenodo: provider }, zenodoJournal: journal
		});

		await expect(executeLivePublicationSyncPlan(input)).resolves.toEqual([{
			type: 'zenodo_create', status: 'failed', failureClass: 'Error',
			failureSummary: 'metadata write failed'
		}]);
		expect(journal.recordZenodoPublishDraft).toHaveBeenCalledTimes(1);
		expect(journal.recordZenodoPublishDraft).toHaveBeenCalledWith(expect.objectContaining({
			status: 'preparing'
		}));
	});

	it('discards an incomplete prepared draft and clears its durable journal', async () => {
		const targets = {
			crossref: { enabled: false as const },
			zenodo: {
				enabled: true as const, environment: 'sandbox' as const,
				identifierPolicy: 'mint-zenodo' as const
			}
		};
		const base = plan(targets);
		if (base.status !== 'write_required') throw new Error('expected Zenodo plan');
		const recoveryPlan = planPublicationSync({
			record: base.record,
			files: base.files,
			identifiers: base.identifiers,
			targets,
			state: {
				zenodo: {
					environment: 'sandbox', identifierPolicy: 'mint-zenodo',
					journal: {
						operationType: 'zenodo_create', depositionId: 'draft-42',
						draftRecordId: 'record-42', payloadHash: 'payload',
						fileManifestHash: 'files', status: 'preparing'
					}
				}
			}
		});
		const provider = zenodo();
		const journal = zenodoJournal();

		await expect(executeLivePublicationSyncPlan({
			plan: recoveryPlan,
			credentials: { zenodoToken: 'sandbox-token' },
			providers: { zenodo: provider },
			zenodoJournal: journal
		})).resolves.toEqual([{
			type: 'zenodo_discard_preparing_draft', status: 'succeeded'
		}]);

		expect(provider.discardPreparedDraft).toHaveBeenCalledWith({
			token: 'sandbox-token',
			operationType: 'zenodo_create',
			draft: { depositionId: 'draft-42', draftRecordId: 'record-42' }
		});
		expect(provider.publishDraft).not.toHaveBeenCalled();
		expect(journal.clearZenodoPublishDraft).toHaveBeenCalledWith(expect.objectContaining({
			recordId: 'ABC12345', environment: 'sandbox', depositionId: 'draft-42'
		}));
	});

	it('never exposes a source writeback operation', () => {
		expect(JSON.stringify(plan({
			crossref: { enabled: true, environment: 'test' }, zenodo: { enabled: false }
		}))).not.toMatch(/writeback|zotero/i);
	});
});

it('passes the existing draft to preparation and publishes that same record', async () => {
  const targets = {crossref: {enabled: false as const}, zenodo: {enabled: true as const, environment: 'production' as const, identifierPolicy: 'mint-zenodo' as const}};
  const initial = plan(targets);
  if (initial.status !== 'write_required') throw new Error('Expected a publication plan');
  const continued = planPublicationSync({
    record: initial.record, files: initial.files, identifiers: initial.identifiers, targets,
    state: {zenodo: {environment: 'production', identifierPolicy: 'mint-zenodo', unpublishedDraft: {depositionId: '42'}}}
  });
  const provider = zenodo();
  const result = await executeLivePublicationSyncPlan(executionInput(targets, {plan: continued, providers: {zenodo: provider}, zenodoJournal: zenodoJournal()}));
  expect(provider.prepareCreateRecord).toHaveBeenCalledWith(expect.objectContaining({draftDepositionId: '42'}));
  expect(provider.publishDraft).toHaveBeenCalledWith({token: 'sandbox-token', draft: {depositionId: '42', draftRecordId: '42', parentId: '41'}});
  expect(result[0]?.status).toBe('succeeded');
});
