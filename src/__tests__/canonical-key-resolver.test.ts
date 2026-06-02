import { describe, expect, it } from 'vitest';
import { EvidenceLibraryRedirectResolver, type RedirectFetchLike } from '../zotero/canonical-key-resolver.js';

describe('EvidenceLibraryRedirectResolver', () => {
  it('extracts the canonical Zotero key from an Evidence Library redirect', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: RedirectFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        status: 301,
        headers: {
          get: (name) => name.toLowerCase() === 'location' ? '/lib/XIABTVMX' : null
        }
      });
    };
    const resolver = new EvidenceLibraryRedirectResolver({ fetch });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://evidence.ekitabu.com/lib/T9HHA2ZP',
      originalItemKey: 'T9HHA2ZP'
    })).resolves.toEqual({
      itemKey: 'XIABTVMX',
      publicItemUrl: 'https://evidence.ekitabu.com/lib/XIABTVMX'
    });
    expect(calls).toEqual([{
      url: 'https://evidence.ekitabu.com/lib/T9HHA2ZP',
      init: {
        method: 'HEAD',
        redirect: 'manual'
      }
    }]);
  });

  it('returns null when the Evidence Library item does not redirect', async () => {
    const resolver = new EvidenceLibraryRedirectResolver({
      fetch: () => Promise.resolve({
        status: 200,
        headers: { get: () => null }
      })
    });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://evidence.ekitabu.com/lib/XIABTVMX',
      originalItemKey: 'XIABTVMX'
    })).resolves.toBeNull();
  });
});
