import { describe, expect, it } from 'vitest';
import { planZoteroIdentifierLinkReconciliation, planZoteroIdentifierLinks } from '../zotero/identifier-links.js';

describe('Zotero identifier child links', () => {
  it('plans zotzen-style DOI, Zenodo deposit, and Zenodo record links without a concept DOI child link', () => {
    expect(planZoteroIdentifierLinks({
      parentItemKey: 'ABC12345',
      children: [],
      zenodoBaseUrl: 'https://sandbox.zenodo.org',
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '502917',
        zenodoParentId: '502915'
      }
    })).toEqual([
      {
        title: '🔄View entry on Zenodo (deposit) [ABC12345]',
        url: 'https://sandbox.zenodo.org/deposit/502917',
        tags: ['_r:zenodoDeposit', '_r:zotzen']
      },
      {
        title: '🔄View entry on Zenodo (record) [ABC12345]',
        url: 'https://sandbox.zenodo.org/record/502917',
        tags: ['_r:zenodoRecord', '_r:zotzen']
      },
      {
        title: '🔄Look up this DOI (once activated) [ABC12345]',
        url: 'https://doi.org/10.53832/opendeved.1205',
        tags: ['_r:doi', '_r:crossref', '_r:zotzen']
      }
    ]);
  });

  it('only marks the DOI child link with _r:crossref (not the Zenodo links)', () => {
    const requests = planZoteroIdentifierLinks({
      parentItemKey: 'ABC12345',
      children: [],
      zenodoBaseUrl: 'https://zenodo.org',
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '502917'
      }
    });

    const doiRequest = requests.find((request) => request.tags.includes('_r:doi'));
    const zenodoRequests = requests.filter((request) => !request.tags.includes('_r:doi'));

    expect(doiRequest?.tags).toContain('_r:crossref');
    for (const zenodoRequest of zenodoRequests) {
      expect(zenodoRequest.tags).not.toContain('_r:crossref');
    }
  });

  it('does not duplicate existing managed child links that already carry the desired tag set', () => {
    expect(planZoteroIdentifierLinks({
      parentItemKey: 'ABC12345',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '15043088'
      },
      children: [{
        key: 'LINK1',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄View entry on Zenodo (deposit) [ABC12345]',
          url: 'https://zenodo.org/deposit/15043088',
          tags: [{ tag: '_r:zenodoDeposit' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'LINK2',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄View entry on Zenodo (record) [ABC12345]',
          url: 'https://zenodo.org/record/15043088',
          tags: [{ tag: '_r:zenodoRecord' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'LINK3',
        version: 1,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [ABC12345]',
          url: 'https://doi.org/10.53832/opendeved.1205',
          tags: [{ tag: '_r:doi' }, { tag: '_r:crossref' }, { tag: '_r:zotzen' }]
        }
      }]
    })).toEqual([]);
  });

  it('preserves user tags on current and patched managed child links', () => {
    expect(planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'ABC12345',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: { crossrefDoi: '10.53832/opendeved.1205' },
      children: [{
        key: 'CURRENT',
        version: 4,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [ABC12345]',
          url: 'https://doi.org/10.53832/opendeved.1205',
          tags: [{ tag: '_r:doi' }, { tag: '_r:crossref' }, { tag: '_r:zotzen' }, { tag: '_personal' }]
        }
      }]
    })).toEqual([]);

    expect(planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'ABC12345',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: { crossrefDoi: '10.53832/opendeved.1205' },
      children: [{
        key: 'STALE',
        version: 5,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: 'Old title',
          url: 'https://doi.org/10.53832/opendeved.1205',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }, { tag: '_personal' }]
        }
      }]
    })).toEqual([{
      type: 'update',
      attachmentKey: 'STALE',
      itemVersion: 5,
      previousTitle: 'Old title',
      previousUrl: 'https://doi.org/10.53832/opendeved.1205',
      previousTags: ['_r:doi', '_r:zotzen', '_personal'],
      title: '🔄Look up this DOI (once activated) [ABC12345]',
      url: 'https://doi.org/10.53832/opendeved.1205',
      tags: ['_personal', '_r:doi', '_r:crossref', '_r:zotzen']
    }]);
  });

  it('reconciles a pre-existing 2-tag DOI link by proposing an update that adds _r:crossref', () => {
    const actions = planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'ABC12345',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: { crossrefDoi: '10.53832/opendeved.1205' },
      children: [{
        key: 'DOILINK',
        version: 4,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [ABC12345]',
          url: 'https://doi.org/10.53832/opendeved.1205',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }]
    });

    expect(actions).toEqual([{
      type: 'update',
      attachmentKey: 'DOILINK',
      itemVersion: 4,
      previousTitle: '🔄Look up this DOI (once activated) [ABC12345]',
      previousUrl: 'https://doi.org/10.53832/opendeved.1205',
      previousTags: ['_r:doi', '_r:zotzen'],
      title: '🔄Look up this DOI (once activated) [ABC12345]',
      url: 'https://doi.org/10.53832/opendeved.1205',
      tags: ['_r:doi', '_r:crossref', '_r:zotzen']
    }]);
  });

  it('updates a stale managed DOI child link instead of creating another one', () => {
    expect(planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'QUVNI859',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: {
        crossrefDoi: '10.53832/edtechhub.1197',
        zenodoLatestRecordId: '18790561'
      },
      children: [{
        key: 'OLDLINK1',
        version: 7,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [F7H3M4ND]',
          url: 'https://doi.org/10.53832/edtechhub.1224',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }]
    })).toContainEqual({
      type: 'update',
      attachmentKey: 'OLDLINK1',
      itemVersion: 7,
      previousTitle: '🔄Look up this DOI (once activated) [F7H3M4ND]',
      previousUrl: 'https://doi.org/10.53832/edtechhub.1224',
      previousTags: ['_r:doi', '_r:zotzen'],
      title: '🔄Look up this DOI (once activated) [QUVNI859]',
      url: 'https://doi.org/10.53832/edtechhub.1197',
      tags: ['_r:doi', '_r:crossref', '_r:zotzen']
    });
  });

  it('keeps the current managed DOI child link (after migration) and deletes stale duplicates', () => {
    expect(planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'QUVNI859',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: {
        crossrefDoi: '10.53832/edtechhub.1197'
      },
      children: [{
        key: 'OLDLINK1',
        version: 7,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [F7H3M4ND]',
          url: 'https://doi.org/10.53832/edtechhub.1224',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'CURRENT1',
        version: 3,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄Look up this DOI (once activated) [QUVNI859]',
          url: 'https://doi.org/10.53832/edtechhub.1197',
          tags: [{ tag: '_r:doi' }, { tag: '_r:crossref' }, { tag: '_r:zotzen' }]
        }
      }]
    })).toEqual([{
      type: 'delete',
      attachmentKey: 'OLDLINK1',
      itemVersion: 7,
      previousTitle: '🔄Look up this DOI (once activated) [F7H3M4ND]',
      previousUrl: 'https://doi.org/10.53832/edtechhub.1224'
    }]);
  });

  it('deletes stale managed Zenodo child links when no Zenodo record is desired', () => {
    expect(planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'ABC12345',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205'
      },
      children: [{
        key: 'ZENODO_DEPOSIT',
        version: 8,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄View entry on Zenodo (deposit) [ABC12345]',
          url: 'https://zenodo.org/deposit/15043088',
          tags: [{ tag: '_r:zenodoDeposit' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'ZENODO_RECORD',
        version: 9,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: '🔄View entry on Zenodo (record) [ABC12345]',
          url: 'https://zenodo.org/record/15043088',
          tags: [{ tag: '_r:zenodoRecord' }, { tag: '_r:zotzen' }]
        }
      }, {
        key: 'USER_LINK',
        version: 10,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: 'User Zenodo bookmark',
          url: 'https://zenodo.org/record/15043088',
          tags: [{ tag: '_personal' }]
        }
      }]
    })).toEqual([
      {
        type: 'create',
        title: '🔄Look up this DOI (once activated) [ABC12345]',
        url: 'https://doi.org/10.53832/opendeved.1205',
        tags: ['_r:doi', '_r:crossref', '_r:zotzen']
      },
      {
        type: 'delete',
        attachmentKey: 'ZENODO_DEPOSIT',
        itemVersion: 8,
        previousTitle: '🔄View entry on Zenodo (deposit) [ABC12345]',
        previousUrl: 'https://zenodo.org/deposit/15043088'
      },
      {
        type: 'delete',
        attachmentKey: 'ZENODO_RECORD',
        itemVersion: 9,
        previousTitle: '🔄View entry on Zenodo (record) [ABC12345]',
        previousUrl: 'https://zenodo.org/record/15043088'
      }
    ]);
  });

  it('deletes a cross-tagged managed child link instead of patching it for multiple slots', () => {
    const actions = planZoteroIdentifierLinkReconciliation({
      parentItemKey: 'ABC12345',
      zenodoBaseUrl: 'https://zenodo.org/',
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '15043088'
      },
      children: [{
        key: 'CROSSTAGGED',
        version: 11,
        data: {
          itemType: 'attachment',
          linkMode: 'linked_url',
          title: 'Conflicting managed link',
          url: 'https://doi.org/10.53832/opendeved.1205',
          tags: [{ tag: '_r:doi' }, { tag: '_r:zenodoDeposit' }, { tag: '_r:zotzen' }]
        }
      }]
    });

    expect(actions.filter((action) => 'attachmentKey' in action && action.attachmentKey === 'CROSSTAGGED')).toEqual([{
      type: 'delete',
      attachmentKey: 'CROSSTAGGED',
      itemVersion: 11,
      previousTitle: 'Conflicting managed link',
      previousUrl: 'https://doi.org/10.53832/opendeved.1205'
    }]);
  });
});
