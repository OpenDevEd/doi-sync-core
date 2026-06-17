import { describe, expect, it } from 'vitest';
import { EvidenceLibraryRedirectResolver, type RedirectFetchLike, type RedirectResponseLike } from '../zotero/canonical-key-resolver.js';

interface StubResponse extends RedirectResponseLike {
  readonly status: number;
  readonly headers: { readonly get: (name: string) => string | null };
  readonly text?: () => Promise<string>;
}

function redirectResponse(location: string, status = 301): StubResponse {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) }
  };
}

function jsonResponse(body: unknown): StubResponse {
  return {
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

function textResponse(body: string): StubResponse {
  return {
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(body)
  };
}

function notRedirectingResponse(): StubResponse {
  return { status: 200, headers: { get: () => null } };
}

const isRedirectsApi = (url: string) => url.includes('/api/redirects/');

describe('EvidenceLibraryRedirectResolver', () => {
  it('resolves the canonical key from the /api/redirects endpoint (JSON destination)', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: RedirectFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse({ destination: '/lib/ERIPJ48W' }));
    };
    const resolver = new EvidenceLibraryRedirectResolver({ fetch });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://docs.edtechhub.org/lib/QKWCDTQK',
      originalItemKey: 'QKWCDTQK'
    })).resolves.toEqual({
      itemKey: 'ERIPJ48W',
      publicItemUrl: 'https://docs.edtechhub.org/lib/ERIPJ48W'
    });

    // It must hit the shield-free API endpoint, not the SPA item URL, and not fall through to HEAD.
    expect(calls).toEqual([{
      url: 'https://docs.edtechhub.org/api/redirects/lib/QKWCDTQK',
      init: { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' } }
    }]);
  });

  it('resolves when the endpoint answers with an HTTP 3xx Location', async () => {
    const resolver = new EvidenceLibraryRedirectResolver({
      fetch: () => Promise.resolve(redirectResponse('/lib/ERIPJ48W'))
    });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://docs.edtechhub.org/lib/QKWCDTQK',
      originalItemKey: 'QKWCDTQK'
    })).resolves.toEqual({
      itemKey: 'ERIPJ48W',
      publicItemUrl: 'https://docs.edtechhub.org/lib/ERIPJ48W'
    });
  });

  it('resolves when the endpoint answers with a bare destination path', async () => {
    const resolver = new EvidenceLibraryRedirectResolver({
      fetch: () => Promise.resolve(textResponse('/lib/ERIPJ48W'))
    });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://docs.edtechhub.org/lib/QKWCDTQK',
      originalItemKey: 'QKWCDTQK'
    })).resolves.toEqual({
      itemKey: 'ERIPJ48W',
      publicItemUrl: 'https://docs.edtechhub.org/lib/ERIPJ48W'
    });
  });

  it('falls back to a direct HTTP redirect when the endpoint reports no destination', async () => {
    const calls: string[] = [];
    const fetch: RedirectFetchLike = (url) => {
      calls.push(url);
      return Promise.resolve(isRedirectsApi(url)
        ? jsonResponse({ destination: null })
        : redirectResponse('/lib/XIABTVMX'));
    };
    const resolver = new EvidenceLibraryRedirectResolver({ fetch });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://evidence.ekitabu.com/lib/T9HHA2ZP',
      originalItemKey: 'T9HHA2ZP'
    })).resolves.toEqual({
      itemKey: 'XIABTVMX',
      publicItemUrl: 'https://evidence.ekitabu.com/lib/XIABTVMX'
    });
    expect(calls).toEqual([
      'https://evidence.ekitabu.com/api/redirects/lib/T9HHA2ZP',
      'https://evidence.ekitabu.com/lib/T9HHA2ZP'
    ]);
  });

  it('falls back to a direct HTTP redirect when the endpoint request throws', async () => {
    const fetch: RedirectFetchLike = (url) => {
      if (isRedirectsApi(url)) return Promise.reject(new Error('network'));
      return Promise.resolve(redirectResponse('/lib/XIABTVMX'));
    };
    const resolver = new EvidenceLibraryRedirectResolver({ fetch });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://evidence.ekitabu.com/lib/T9HHA2ZP',
      originalItemKey: 'T9HHA2ZP'
    })).resolves.toEqual({
      itemKey: 'XIABTVMX',
      publicItemUrl: 'https://evidence.ekitabu.com/lib/XIABTVMX'
    });
  });

  it('returns null when neither the endpoint nor the public URL redirects', async () => {
    const resolver = new EvidenceLibraryRedirectResolver({
      fetch: (url) => Promise.resolve(isRedirectsApi(url)
        ? jsonResponse({ destination: null })
        : notRedirectingResponse())
    });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://evidence.ekitabu.com/lib/XIABTVMX',
      originalItemKey: 'XIABTVMX'
    })).resolves.toBeNull();
  });

  it('ignores a redirect that points back at the original item key', async () => {
    const resolver = new EvidenceLibraryRedirectResolver({
      fetch: (url) => Promise.resolve(isRedirectsApi(url)
        ? jsonResponse({ destination: '/lib/QKWCDTQK' })
        : notRedirectingResponse())
    });

    await expect(resolver.resolveCanonicalItemKey({
      publicItemUrl: 'https://docs.edtechhub.org/lib/QKWCDTQK',
      originalItemKey: 'QKWCDTQK'
    })).resolves.toBeNull();
  });
});
