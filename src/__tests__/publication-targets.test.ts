import { describe, expect, it } from 'vitest';

import { parsePublicationTargetPolicy } from '../publication/targets.js';

describe('publication target policy', () => {
  it('allows Zenodo minting without Crossref', () => {
    expect(parsePublicationTargetPolicy({
      crossref: { enabled: false },
      zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
    })).toEqual({
      crossref: { enabled: false },
      zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'mint-zenodo' }
    });
  });

  it('allows independently enabled Crossref', () => {
    expect(parsePublicationTargetPolicy({
      crossref: { enabled: true, environment: 'test' },
      zenodo: { enabled: false }
    })).toEqual({
      crossref: { enabled: true, environment: 'test' },
      zenodo: { enabled: false }
    });
  });

  it('requires Crossref when Zenodo reuses its DOI', () => {
    expect(() => parsePublicationTargetPolicy({
      crossref: { enabled: false },
      zenodo: { enabled: true, environment: 'sandbox', identifierPolicy: 'reuse-crossref' }
    })).toThrow(/requires Crossref/i);
  });
});
