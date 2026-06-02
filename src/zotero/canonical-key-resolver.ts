import type { CanonicalZoteroItemKeyResolver } from '../ports.js';

export interface RedirectResponseLike {
  readonly status: number;
  readonly headers: {
    readonly get: (name: string) => string | null;
  };
}

export type RedirectFetchLike = (url: string, init: RequestInit) => Promise<RedirectResponseLike>;

export interface EvidenceLibraryRedirectResolverOptions {
  readonly fetch?: RedirectFetchLike;
}

/** Resolves Evidence Library redirect targets for deleted Zotero items. */
export class EvidenceLibraryRedirectResolver implements CanonicalZoteroItemKeyResolver {
  private readonly fetch: RedirectFetchLike;

  constructor(options: EvidenceLibraryRedirectResolverOptions = {}) {
    this.fetch = options.fetch ?? fetch;
  }

  async resolveCanonicalItemKey(input: {
    readonly publicItemUrl: string;
    readonly originalItemKey: string;
  }): Promise<{ readonly itemKey: string; readonly publicItemUrl: string } | null> {
    const response = await this.fetch(input.publicItemUrl, {
      method: 'HEAD',
      redirect: 'manual'
    });
    if (!isRedirectStatus(response.status)) return null;

    const location = response.headers.get('location');
    if (!location) return null;

    const publicItemUrl = new URL(location, input.publicItemUrl).toString();
    const itemKey = extractItemKey(publicItemUrl);
    if (!itemKey || itemKey === input.originalItemKey) return null;

    return { itemKey, publicItemUrl };
  }
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function extractItemKey(url: string): string | null {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\/lib\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}
