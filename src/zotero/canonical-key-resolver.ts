import type { CanonicalZoteroItemKeyResolver } from '../ports.js';

export interface RedirectResponseLike {
  readonly status: number;
  readonly headers: {
    readonly get: (name: string) => string | null;
  };
  readonly text?: () => Promise<string>;
}

export type RedirectFetchLike = (url: string, init: RequestInit) => Promise<RedirectResponseLike>;

export interface EvidenceLibraryRedirectResolverOptions {
  readonly fetch?: RedirectFetchLike;
}

interface ResolverInput {
  readonly publicItemUrl: string;
  readonly originalItemKey: string;
}

interface CanonicalItemKeyResolution {
  readonly itemKey: string;
  readonly publicItemUrl: string;
}

/**
 * Resolves Evidence Library redirect targets for deleted Zotero items.
 *
 * The Evidence Library is a client-side SPA whose item redirects are served as a JavaScript
 * challenge (HTTP 200), not an HTTP 3xx, so a plain HEAD on the public item URL never observes
 * them. The `/api/redirects/<path>` endpoint exposes the same redirect map server-side without the
 * JS shield, so it is consulted first; a direct HTTP 3xx redirect is kept as a fallback for
 * libraries that still answer the public URL with a real redirect.
 */
export class EvidenceLibraryRedirectResolver implements CanonicalZoteroItemKeyResolver {
  private readonly fetch: RedirectFetchLike;

  constructor(options: EvidenceLibraryRedirectResolverOptions = {}) {
    this.fetch = options.fetch ?? fetch;
  }

  async resolveCanonicalItemKey(input: ResolverInput): Promise<CanonicalItemKeyResolution | null> {
    return (await this.resolveViaRedirectsApi(input)) ?? (await this.resolveViaHttpRedirect(input));
  }

  private async resolveViaRedirectsApi(input: ResolverInput): Promise<CanonicalItemKeyResolution | null> {
    const apiUrl = toRedirectsApiUrl(input.publicItemUrl);
    if (!apiUrl) return null;

    let response: RedirectResponseLike;
    try {
      response = await this.fetch(apiUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json' }
      });
    } catch {
      return null;
    }

    const destination = await readRedirectDestination(response);
    if (!destination) return null;

    return toResolution(destination, input);
  }

  private async resolveViaHttpRedirect(input: ResolverInput): Promise<CanonicalItemKeyResolution | null> {
    let response: RedirectResponseLike;
    try {
      response = await this.fetch(input.publicItemUrl, {
        method: 'HEAD',
        redirect: 'manual'
      });
    } catch {
      return null;
    }
    if (!isRedirectStatus(response.status)) return null;

    const location = response.headers.get('location');
    if (!location) return null;

    return toResolution(location, input);
  }
}

/** Maps a public `/lib/<key>` item URL to its `/api/redirects/lib/<key>` lookup URL. */
function toRedirectsApiUrl(publicItemUrl: string): string | null {
  try {
    const url = new URL(publicItemUrl);
    return new URL(`/api/redirects${url.pathname}`, url.origin).toString();
  } catch {
    return null;
  }
}

/** Reads a redirect destination from either an HTTP 3xx `Location` or an `/api/redirects` body. */
async function readRedirectDestination(response: RedirectResponseLike): Promise<string | null> {
  if (isRedirectStatus(response.status)) {
    return response.headers.get('location');
  }
  if (response.status < 200 || response.status >= 300 || !response.text) return null;

  let body: string;
  try {
    body = (await response.text()).trim();
  } catch {
    return null;
  }
  if (!body) return null;

  // The endpoint returns `{ "destination": "/lib/<key>" }` (or `{ "destination": null }`); some
  // deployments answer with the bare destination path instead.
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { readonly destination?: unknown };
      return typeof parsed.destination === 'string' && parsed.destination ? parsed.destination : null;
    } catch {
      return null;
    }
  }

  return body;
}

function toResolution(destination: string, input: ResolverInput): CanonicalItemKeyResolution | null {
  let publicItemUrl: string;
  try {
    publicItemUrl = new URL(destination, input.publicItemUrl).toString();
  } catch {
    return null;
  }
  const itemKey = extractItemKey(publicItemUrl);
  if (!itemKey || itemKey === input.originalItemKey) return null;

  return { itemKey, publicItemUrl };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function extractItemKey(url: string): string | null {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\/lib\/([^/]+)\/?$/);
  return match?.[1] ?? null;
}
