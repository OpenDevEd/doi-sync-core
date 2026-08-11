import { describe, expect, it } from 'vitest';

import { analyzeZoteroDoiDrift, resolveZoteroCrossrefDoi } from '../zotero/doi.js';

describe('Zotero DOI adapter', () => {
  it('maps Zotero fields into the established resolution order', () => {
    expect(resolveZoteroCrossrefDoi({
      recordDoi: '',
      extra: 'not managed\n10.53832/bare-extra.1',
      callNumber: 'callnumber.1',
      callNumberDoiPrefix: '10.53832'
    })).toEqual({ doi: '10.53832/bare-extra.1', source: 'extra' });
  });

  it('preserves Extra line order when more than one DOI is present', () => {
    expect(resolveZoteroCrossrefDoi({
      recordDoi: '',
      extra: 'DOI: 10.53832/z-first.1\nDOI: 10.53832/a-second.1'
    })).toEqual({ doi: '10.53832/z-first.1', source: 'extra' });
  });

  it('maps Zotero field conflicts into provider-neutral drift analysis', () => {
    expect(analyzeZoteroDoiDrift({
      recordDoi: '10.53832/opendeved.1205',
      zoteroDoi: '10.53832/opendeved.1205',
      extra: 'DOI: https://doi.org/10.9999/wrong'
    })).toEqual({
      drifted: true,
      canonicalDoi: '10.53832/opendeved.1205',
      conflicts: [{ source: 'extra', doi: '10.9999/wrong' }]
    });
  });
});
