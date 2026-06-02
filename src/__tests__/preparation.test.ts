import { describe, expect, it } from 'vitest';
import { prepareDoiSync } from '../preparation.js';
import type { DoiSyncRecord } from '../planner.js';
import type { ZoteroParentItem } from '../metadata.js';

const record: DoiSyncRecord = {
  id: 'rec-1',
  zoteroItemKey: 'ABC12345',
  crossrefDoi: '10.53832/opendeved.1205',
  doiActivated: true
};

const zoteroItem: ZoteroParentItem = {
  key: 'ABC12345',
  version: 12,
  data: {
    itemType: 'report',
    title: 'Evidence report',
    DOI: '10.53832/opendeved.1205',
    date: '2026-05-20'
  }
};

describe('prepareDoiSync', () => {
  it('builds the reusable plan, intended diff, and Zotero select URL together', () => {
    const prepared = prepareDoiSync({
      record,
      zoteroItem,
      zoteroChildren: [],
      policy: {
        callNumberDoiPrefix: '10.53832',
        doiPolicy: 'external-crossref',
        fallbackPublicationDate: '1970-01-01'
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      zoteroGroupId: '123'
    });

    expect(prepared.plan.status).toBe('write_required');
    expect(prepared.intendedDiff.sections.map((section) => section.provider)).toContain('crossref');
    expect(prepared.zoteroSelectUrl).toBe('zotero://select/groups/123/items/ABC12345');
  });
});
