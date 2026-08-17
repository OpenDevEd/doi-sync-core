import { describe, expect, it } from 'vitest';

import { describeDryRun } from '../executor/dry-run-executor.js';
import { planPublicationSync } from './plan-fixture.js';

describe('publication dry-run description', () => {
	it('projects the exact provider-neutral operations without writes', () => {
		const plan = planPublicationSync({
			record: {
				recordKey: 'ABC12345',
				canonicalRevision: 1,
				itemType: 'Report',
				title: 'Evidence report',
				publicationDate: '2026-05-20',
				publisher: 'OpenDevEd',
				creators: [],
				tags: [],
				landingUrl: 'https://example.org/items/ABC12345',
				fields: {}
			},
			files: { files: [] },
			identifiers: { managedCrossrefDoi: '10.53832/opendeved.1205' },
			targets: { crossref: { enabled: true, environment: 'test' }, zenodo: { enabled: false } }
		});

		expect(describeDryRun(plan)).toMatchObject({
			recordKey: 'ABC12345',
			status: 'write_required',
			actions: [{ kind: 'would_submit_crossref' }]
		});
	});

	it('reports local waiting-for-file state without a remote action', () => {
		const plan = planPublicationSync({
			record: {
				recordKey: 'ABC12345', canonicalRevision: 1, itemType: 'Report',
				title: 'Evidence report', publicationDate: '2026-05-20', abstract: 'Evidence summary',
				creators: [{ type: 'organizational', name: 'OpenDevEd' }], tags: [],
				landingUrl: 'https://example.org/items/ABC12345', fields: {}
			},
			files: { files: [] },
			identifiers: {},
			targets: {
				crossref: { enabled: false },
				zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
			}
		});

		expect(describeDryRun(plan)).toEqual({
			recordKey: 'ABC12345',
			status: 'waiting_for_file',
			waitingForFile: true,
			actions: []
		});
	});
});
