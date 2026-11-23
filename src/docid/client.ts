import { ProviderHttpError, retryAfterMsFromHeaders, type ProviderResponseHeaders } from '../resilience/errors.js';
import { DirectProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';
import { asRecord, asString } from '../guards.js';
import type { DocidDeposit } from './deposit.js';

export interface DocidResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: ProviderResponseHeaders;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}

export type DocidFetchLike = (url: string, init: RequestInit) => Promise<DocidResponseLike>;

export interface DocidApiClientOptions {
  readonly fetch?: DocidFetchLike;
  /** The deployment, without `/api/v1`. Every deployment, demo included, mints real Handles. */
  readonly endpoint?: string;
  readonly operationRunner?: ProviderOperationRunner;
}

export interface DocidSession {
  readonly token: string;
  readonly refreshToken: string;
}

/**
 * DOCiD's API (Africa PID Alliance). Sign-in tokens last 24 hours. A mint creates a permanent Handle at once, so each
 * carries an idempotency key: DOCiD answers a repeated key with the Handle it already minted.
 */
export class DocidApiClient {
  private readonly fetch: DocidFetchLike;
  private readonly endpoint: string;
  private readonly operationRunner: ProviderOperationRunner;

  constructor(options: DocidApiClientOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.endpoint = (options.endpoint ?? 'https://docid.africapidalliance.org').replace(/\/+$/, '');
    this.operationRunner = options.operationRunner ?? new DirectProviderOperationRunner();
  }

  async signIn(input: { readonly email: string; readonly password: string }): Promise<DocidSession> {
    const body = asRecord(await this.json('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
    return { token: required(body?.['token'], 'token'), refreshToken: required(body?.['refresh_token'], 'refresh_token') };
  }

  /** A new sign-in token from the refresh token, which DOCiD names `access_token` here. */
  async refresh(input: { readonly refreshToken: string }): Promise<string> {
    const body = asRecord(await this.json('/auth/refresh', { method: 'POST', headers: { Authorization: `Bearer ${input.refreshToken}` } }));
    return required(body?.['access_token'], 'access_token');
  }

  /** Mints the record's DOCiD, holding its title and description, before the deposit that fills it. */
  async mint(input: { readonly token: string; readonly title: string; readonly description: string; readonly idempotencyKey: string }): Promise<string> {
    const body = asRecord(await this.json('/cordoi/assign-doi/container-id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({ title: input.title, description: input.description })
    }));
    return required(body?.['id'] ?? asRecord(body?.['data'])?.['id'], 'id');
  }

  /** Deposits the record under its minted DOCiD. Not repeated by itself: a second deposit would make a second record. */
  async deposit(input: { readonly token: string; readonly deposit: DocidDeposit }): Promise<{ readonly publicationId: number; readonly docid: string }> {
    const form = formOf(input.deposit);
    const body = asRecord(await this.json('/publications/publish', { method: 'POST', headers: { Authorization: `Bearer ${input.token}` }, body: form }, { once: true }));
    const publication = asRecord(body?.['publication']);
    const publicationId = body?.['publication_id'];
    if (typeof publicationId !== 'number') throw new Error('DOCiD answered a deposit without a publication_id.');
    return { publicationId, docid: required(publication?.['document_docid'], 'publication.document_docid') };
  }

  /** Adds the DOI a record was given after its deposit. Only the depositing account may. */
  async addDoi(input: { readonly token: string; readonly publicationId: number; readonly doi: string }): Promise<void> {
    await this.json(`/publications/update-publication/${input.publicationId}`, { method: 'PUT', headers: { Authorization: `Bearer ${input.token}` }, body: formOf({ fields: [['doi', input.doi]], files: [] }) });
  }

  /** Retires the record: its DOCiD keeps resolving, to a tombstone. */
  async withdraw(input: { readonly token: string; readonly publicationId: number; readonly reason?: string }): Promise<void> {
    await this.json(`/publications/${input.publicationId}/delete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input.reason ? { reason: input.reason } : {})
    });
  }

  /** Brings a retired record back. DOCiD answers an active one with 200 too. */
  async reinstate(input: { readonly token: string; readonly publicationId: number }): Promise<void> {
    await this.json(`/publications/${input.publicationId}/restore`, { method: 'POST', headers: { Authorization: `Bearer ${input.token}` } });
  }

  private async json(path: string, init: RequestInit, options: { readonly once?: boolean } = {}): Promise<unknown> {
    const operation = async () => {
      const response = await this.fetch(`${this.endpoint}/api/v1${path}`, { ...init, headers: { 'User-Agent': 'doi-sync-core', Accept: 'application/json', ...init.headers } });
      if (!response.ok) {
        throw new ProviderHttpError({ provider: 'docid', status: response.status, body: await response.text(), retryAfterMs: retryAfterMsFromHeaders(response.headers) });
      }
      return response.json();
    };
    const runner = this.operationRunner;
    return options.once && runner.runOnce ? runner.runOnce('docid', operation) : runner.run('docid', operation);
  }
}

function required(value: unknown, field: string): string {
  const text = asString(value);
  if (!text) throw new Error(`DOCiD answered without ${field}.`);
  return text;
}

function formOf(deposit: DocidDeposit): FormData {
  const form = new FormData();
  for (const [name, value] of deposit.fields) form.append(name, value);
  for (const [name, file] of deposit.files) form.append(name, new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.contentType }), file.filename);
  return form;
}
