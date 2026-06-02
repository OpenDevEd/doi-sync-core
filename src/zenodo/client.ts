import { buildZenodoWritePayload, parseZenodoLegacyDepositionIdentifiers, parseZenodoRecordIdentifiers, parseZenodoRecordSnapshot, ZENODO_INVENIORDM_ACCEPT, type DoiPolicy, type ZenodoDoiLookupResult, type ZenodoLegacyDepositionPayload, type ZenodoPublishedRecordVerification, type ZenodoRecordIdentifiers, type ZenodoRecordSnapshot, type ZenodoVerificationResult } from './records.js';
import type { ZenodoPreparedDraft } from './journal.js';
import type { CanonicalMetadataSnapshot } from '../metadata.js';
import { asJsonObject, toJsonValue } from '../json.js';
import type { JsonValue } from '../hash.js';
import { ProviderHttpError, retryAfterMsFromHeaders, type ProviderResponseHeaders } from '../resilience/errors.js';
import { DirectProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';
import { asRecord, asString, idString } from '../guards.js';

export interface ZenodoResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: ProviderResponseHeaders;
  readonly json: () => Promise<unknown>;
  readonly text: () => Promise<string>;
}

export type ZenodoFetchLike = (url: string, init: RequestInit) => Promise<ZenodoResponseLike>;

export interface ZenodoApiClientOptions {
  readonly fetch?: ZenodoFetchLike;
  readonly endpoint?: string;
  readonly operationRunner?: ProviderOperationRunner;
}

export interface VerifyZenodoRecordInput {
  readonly token: string;
  readonly recordId: string;
}

export interface FindZenodoRecordByDoiInput {
  readonly token: string;
  readonly doi: string;
}

export interface ReadZenodoRecordSnapshotInput {
  readonly token: string;
  readonly recordId: string;
}

export interface ZenodoUploadFile {
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ZenodoCreateRecordInput {
  readonly token: string;
  readonly doiPolicy: DoiPolicy;
  readonly metadata: CanonicalMetadataSnapshot;
  readonly files: readonly ZenodoUploadFile[];
  /** Zotero `zotero://select/...` URL emitted into the legacy Zenodo deposition `related_identifiers` write payload. */
  readonly zoteroSelectUrl?: string;
  /** Public resource URL appended idempotently to the Zenodo `description`. */
  readonly resourceUrl?: string;
  /** Called as soon as Zenodo returns a draft/deposition id, before later mutable steps can fail. */
  readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
}

export interface ZenodoAdoptLegacyDepositionInput extends ZenodoCreateRecordInput {
  readonly depositionId: string;
}

export interface ZenodoUpdateRecordMetadataInput {
  readonly token: string;
  readonly latestRecordId: string;
  readonly doiPolicy: DoiPolicy;
  readonly metadata: CanonicalMetadataSnapshot;
  /** Zotero `zotero://select/...` URL emitted into the legacy Zenodo deposition `related_identifiers` write payload. */
  readonly zoteroSelectUrl?: string;
  /** Public resource URL appended idempotently to the Zenodo `description`. */
  readonly resourceUrl?: string;
  /** Called as soon as Zenodo returns a draft/deposition id, before later mutable steps can fail. */
  readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
}

export interface ZenodoCreateNewVersionInput extends ZenodoUpdateRecordMetadataInput {
  readonly files: readonly ZenodoUploadFile[];
}

export interface DeleteZenodoUnpublishedDraftInput {
  readonly token: string;
  readonly depositionId: string;
}

/** Creates, updates, verifies, and publishes Zenodo records for the supported DOI policies. */
export class ZenodoApiClient {
  private readonly fetch: ZenodoFetchLike;
  private readonly endpoint: string;
  private readonly operationRunner: ProviderOperationRunner;

  constructor(options: ZenodoApiClientOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? 'https://zenodo.org';
    this.operationRunner = options.operationRunner ?? new DirectProviderOperationRunner();
  }

  async verifyRecord(input: VerifyZenodoRecordInput): Promise<ZenodoVerificationResult | null> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(input.recordId)}`, {
      method: 'GET',
      headers: {
        Accept: ZENODO_INVENIORDM_ACCEPT,
        Authorization: `Bearer ${input.token}`
      }
    }, { allowedStatuses: [404] });

    if (response.status === 404) return this.verifyLegacyDeposition(input);
    return {
      kind: 'published_record',
      identifiers: parseZenodoRecordIdentifiers(await response.json())
    };
  }

  async findRecordByDoi(input: FindZenodoRecordByDoiInput): Promise<ZenodoDoiLookupResult> {
    const params = new URLSearchParams({
      q: `doi:"${escapeZenodoSearchPhrase(input.doi.trim())}"`,
      all_versions: 'true',
      size: '2'
    });
    const response = await this.request(`${this.endpoint}/api/records?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: ZENODO_INVENIORDM_ACCEPT,
        Authorization: `Bearer ${input.token}`
      }
    });
    const records = parsePublishedRecordsForExactDoi(await response.json(), input.doi);
    if (records.length === 0) return { status: 'not_found' };
    const firstRecord = records[0];
    if (records.length === 1 && firstRecord) return { status: 'found', record: firstRecord };
    return {
      status: 'ambiguous',
      recordIds: records.map((record) => record.identifiers.latestRecordId)
    };
  }

  async readRecordSnapshot(input: ReadZenodoRecordSnapshotInput): Promise<ZenodoRecordSnapshot | null> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(input.recordId)}`, {
      method: 'GET',
      headers: {
        Accept: ZENODO_INVENIORDM_ACCEPT,
        Authorization: `Bearer ${input.token}`
      }
    }, { allowedStatuses: [404] });
    if (response.status === 404) return null;
    return parseZenodoRecordSnapshot(await response.json());
  }

  async createRecord(input: ZenodoCreateRecordInput): Promise<ZenodoRecordIdentifiers> {
    const draft = await this.prepareCreateRecord(input);
    return this.publishDraft({ token: input.token, draft });
  }

  async adoptLegacyDeposition(input: ZenodoAdoptLegacyDepositionInput): Promise<ZenodoRecordIdentifiers> {
    const draft = await this.prepareAdoptLegacyDeposition(input);
    return this.publishDraft({ token: input.token, draft });
  }

  async updateRecordMetadata(input: ZenodoUpdateRecordMetadataInput): Promise<ZenodoRecordIdentifiers> {
    const draft = await this.prepareUpdateRecordMetadata(input);
    return this.publishDraft({ token: input.token, draft });
  }

  async createNewVersion(input: ZenodoCreateNewVersionInput): Promise<ZenodoRecordIdentifiers> {
    const draft = await this.prepareNewVersion(input);
    return this.publishDraft({ token: input.token, draft });
  }

  async deleteUnpublishedDraft(input: DeleteZenodoUnpublishedDraftInput): Promise<void> {
    await this.deleteUnpublishedDeposition(input.token, input.depositionId);
  }

  async prepareCreateRecord(input: ZenodoCreateRecordInput): Promise<ZenodoPreparedDraft> {
    const deposition = await this.createEmptyDeposition(input.token);
    const draft = toPreparedDraft(deposition);
    await this.notifyPreparedDraft(draft, input.onPreparedDraft, () => this.deleteUnpublishedDeposition(input.token, deposition.id));
    await this.uploadFilesToBucket(input.token, deposition, input.files);
    const payload = buildDepositionPayload(deposition, input);
    await this.updateDepositionMetadata(input.token, deposition.id, payload);
    return withPayloadSnapshot(draft, payload);
  }

  async prepareAdoptLegacyDeposition(input: ZenodoAdoptLegacyDepositionInput): Promise<ZenodoPreparedDraft> {
    const deposition = await this.getDeposition(input.token, input.depositionId);
    const draft = toPreparedDraft(deposition);
    await input.onPreparedDraft?.(draft);
    await this.replaceLegacyDepositionFiles(input.token, deposition, input.files);
    const payload = buildDepositionPayload(deposition, input);
    await this.updateDepositionMetadata(input.token, deposition.id, payload);
    return withPayloadSnapshot(draft, payload);
  }

  async prepareUpdateRecordMetadata(input: ZenodoUpdateRecordMetadataInput): Promise<ZenodoPreparedDraft> {
    const editable = await this.postDepositionAction(input.token, input.latestRecordId, 'edit');
    const draft = toPreparedDraft(editable);
    await input.onPreparedDraft?.(draft);
    const payload = buildDepositionPayload(editable, input);
    await this.updateDepositionMetadata(input.token, editable.id, payload);
    return withPayloadSnapshot(draft, payload);
  }

  async prepareNewVersion(input: ZenodoCreateNewVersionInput): Promise<ZenodoPreparedDraft> {
    const latestDraftUrl = await this.createNewVersionDraft(input.token, input.latestRecordId);
    const draft = await this.getDepositionByUrl(input.token, latestDraftUrl);
    const preparedDraft = toPreparedDraft(draft);
    await input.onPreparedDraft?.(preparedDraft);
    await this.replaceLegacyDepositionFiles(input.token, draft, input.files);
    const payload = buildDepositionPayload(draft, input);
    await this.updateDepositionMetadata(input.token, draft.id, payload);
    return withPayloadSnapshot(preparedDraft, payload);
  }

  async publishDraft(input: {
    readonly token: string;
    readonly draft: ZenodoPreparedDraft;
  }): Promise<ZenodoRecordIdentifiers> {
    const published = await this.publishDraftRecordId(input.token, input.draft)
      .catch((error: unknown) => this.reconcilePublishedDraftAfterPublishFailure(input.token, input.draft, error));
    if (typeof published !== 'string') return published;
    try {
      return await this.readPublishedIdentifiers(input.token, published);
    } catch (error) {
      throw new Error(`Zenodo publish succeeded for ${published}, but published identifier lookup failed: ${errorMessage(error)}`, {
        cause: error
      });
    }
  }

  private async publishDraftRecordId(token: string, draft: ZenodoPreparedDraft): Promise<string> {
    return this.publishDeposition(token, draft.depositionId, draft.draftRecordId);
  }

  private async verifyLegacyDeposition(input: VerifyZenodoRecordInput): Promise<ZenodoVerificationResult | null> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(input.recordId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.token}`
      }
    }, { allowedStatuses: [404] });

    if (response.status === 404) return null;
    const deposition = parseZenodoLegacyDepositionIdentifiers(await response.json());
    return deposition ? {
      kind: 'legacy_unsubmitted_deposition',
      deposition
    } : null;
  }

  private async createEmptyDeposition(token: string): Promise<ZenodoDeposition> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: '{}'
    });
    return parseDeposition(await response.json());
  }

  private async getDeposition(token: string, depositionId: string): Promise<ZenodoDeposition> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}`, {
      method: 'GET',
      headers: authHeaders(token)
    });
    return parseDeposition(await response.json());
  }

  private async deleteUnpublishedDeposition(token: string, depositionId: string): Promise<void> {
    await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}`, {
      method: 'DELETE',
      headers: authHeaders(token)
    }, { allowedStatuses: [404] });
  }

  private async getDepositionByUrl(token: string, url: string): Promise<ZenodoDeposition> {
    const response = await this.request(url, {
      method: 'GET',
      headers: authHeaders(token)
    });
    return parseDeposition(await response.json());
  }

  private async postDepositionAction(token: string, recordId: string, action: 'edit' | 'newversion'): Promise<ZenodoDeposition> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(recordId)}/actions/${action}`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    return parseDeposition(await response.json());
  }

  private async createNewVersionDraft(token: string, recordId: string): Promise<string> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(recordId)}/actions/newversion`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    const links = asRecord(asRecord(await response.json())?.['links']) ?? {};
    return asString(links['latest_draft']) ?? missingLatestDraftUrl(recordId);
  }

  private async uploadFilesToBucket(token: string, deposition: ZenodoDeposition, files: readonly ZenodoUploadFile[]): Promise<void> {
    if (files.length === 0) return;
    if (!deposition.bucketUrl) throw new Error(`Zenodo deposition ${deposition.id} does not expose a bucket URL`);

    for (const file of uniqueZenodoFileKeys(files)) {
      await this.request(`${deposition.bucketUrl}/${encodeURIComponent(file.filename)}`, {
        method: 'PUT',
        headers: {
          ...authHeaders(token),
          'Content-Type': 'application/octet-stream'
        },
        body: new Blob([copyToArrayBuffer(file.bytes)], { type: 'application/octet-stream' })
      });
    }
  }

  private async replaceLegacyDepositionFiles(token: string, deposition: ZenodoDeposition, files: readonly ZenodoUploadFile[]): Promise<void> {
    const currentFiles = await this.listLegacyDepositionFiles(token, deposition.id);
    const uniqueFiles = uniqueZenodoFileKeys(files);
    const desiredFileSet = new Set(uniqueFiles.map((file) => file.filename));

    await this.uploadFilesToBucket(token, deposition, uniqueFiles);

    for (const file of currentFiles) {
      if (desiredFileSet.has(file.filename)) continue;
      await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(deposition.id)}/files/${encodeURIComponent(file.id)}`, {
        method: 'DELETE',
        headers: authHeaders(token)
      });
    }
  }

  private async listLegacyDepositionFiles(token: string, depositionId: string): Promise<readonly ZenodoDepositionFile[]> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}/files`, {
      method: 'GET',
      headers: authHeaders(token)
    });
    return parseDepositionFiles(await response.json());
  }

  private async updateDepositionMetadata(token: string, depositionId: string, payload: ZenodoLegacyDepositionPayload): Promise<void> {
    await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}`, {
      method: 'PUT',
      headers: jsonHeaders(token),
      body: JSON.stringify(payload)
    });
  }

  private async publishDeposition(token: string, depositionId: string, fallbackRecordId: string): Promise<string> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}/actions/publish`, {
      method: 'POST',
      headers: authHeaders(token)
    });
    const published = parseOptionalDeposition(await response.json());
    return published?.recordId ?? fallbackRecordId;
  }

  private async reconcilePublishedDraftAfterPublishFailure(token: string, draft: ZenodoPreparedDraft, error: unknown): Promise<ZenodoRecordIdentifiers> {
    if (!shouldReconcilePublishedDraftAfterPublishFailure(error)) throw error;
    try {
      return await this.readPublishedIdentifiers(token, draft.draftRecordId);
    } catch {
      throw error;
    }
  }

  private async readPublishedIdentifiers(token: string, recordId: string): Promise<ZenodoRecordIdentifiers> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(recordId)}`, {
      method: 'GET',
      headers: {
        Accept: ZENODO_INVENIORDM_ACCEPT,
        Authorization: `Bearer ${token}`
      }
    });
    return parseZenodoRecordIdentifiers(await response.json());
  }

  private async notifyPreparedDraft(
    draft: ZenodoPreparedDraft,
    onPreparedDraft: ((draft: ZenodoPreparedDraft) => Promise<void>) | undefined,
    cleanup?: () => Promise<void>
  ): Promise<void> {
    if (!onPreparedDraft) return;
    try {
      await onPreparedDraft(draft);
    } catch (error) {
      if (!cleanup) throw error;
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new Error(`Zenodo prepared-draft journal failed and cleanup failed: ${errorMessage(error)}; cleanup failed: ${errorMessage(cleanupError)}`, {
          cause: cleanupError
        });
      }
      throw error;
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    options: { readonly allowedStatuses?: readonly number[] } = {}
  ): Promise<ZenodoResponseLike> {
    return this.operationRunner.run('zenodo', async () => {
      const response = await this.fetch(url, init);
      if (response.ok || options.allowedStatuses?.includes(response.status) === true) return response;
      throw new ProviderHttpError({
        provider: 'zenodo',
        status: response.status,
        body: await response.text(),
        retryAfterMs: retryAfterMsFromHeaders(response.headers)
      });
    });
  }
}

interface ZenodoDeposition {
  readonly id: string;
  readonly recordId: string;
  readonly bucketUrl?: string;
  readonly latestDraftUrl?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

interface ZenodoDepositionFile {
  readonly id: string;
  readonly filename: string;
}

function buildDepositionPayload(
  deposition: ZenodoDeposition,
  input: ZenodoCreateRecordInput | ZenodoUpdateRecordMetadataInput
): ZenodoLegacyDepositionPayload {
  return buildZenodoWritePayload({
    doiPolicy: input.doiPolicy,
    metadata: input.metadata,
    ...(deposition.metadata ? { existingMetadata: deposition.metadata } : {}),
    ...(input.zoteroSelectUrl ? { zoteroSelectUrl: input.zoteroSelectUrl } : {}),
    ...(input.resourceUrl ? { resourceUrl: input.resourceUrl } : {})
  });
}

function withPayloadSnapshot(draft: ZenodoPreparedDraft, payload: JsonValue | ZenodoLegacyDepositionPayload): ZenodoPreparedDraft {
  return {
    ...draft,
    payloadSnapshot: toJsonValue(payload)
  };
}

function jsonHeaders(token: string): HeadersInit {
  return {
    ...authHeaders(token),
    'Content-Type': 'application/json'
  };
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`
  };
}

function parseDeposition(response: unknown): ZenodoDeposition {
  const deposition = asRecord(response);
  if (!deposition) throw new Error('Expected Zenodo deposition response object');

  const id = idString(deposition['id']);
  const recordId = idString(deposition['record_id']) ?? id;
  if (!id || !recordId) throw new Error('Expected Zenodo deposition id and record_id');

  const links = asRecord(deposition['links']) ?? {};
  const bucketUrl = asString(links['bucket']);
  const latestDraftUrl = asString(links['latest_draft']);
  const metadata = parseOptionalJsonObject(deposition['metadata']);

  return {
    id,
    recordId,
    ...(bucketUrl ? { bucketUrl } : {}),
    ...(latestDraftUrl ? { latestDraftUrl } : {}),
    ...(metadata ? { metadata } : {})
  };
}

function parseOptionalJsonObject(value: unknown): Readonly<Record<string, JsonValue>> | undefined {
  const object = asRecord(value);
  if (!object) return undefined;
  const json = toJsonValue(object);
  const jsonObject = asJsonObject(json);
  if (!jsonObject) throw new Error('Expected Zenodo deposition metadata object');
  return jsonObject;
}

function parsePublishedRecordsForExactDoi(response: unknown, doi: string): readonly ZenodoPublishedRecordVerification[] {
  const hits = asRecord(asRecord(response)?.['hits'])?.['hits'];
  if (!Array.isArray(hits)) return [];
  const normalizedDoi = doi.trim().toLowerCase();
  return hits.flatMap((hit) => {
    if (recordDoi(hit)?.trim().toLowerCase() !== normalizedDoi) return [];
    return [{
      kind: 'published_record',
      identifiers: parseZenodoRecordIdentifiers(hit)
    }];
  });
}

function recordDoi(record: unknown): string | undefined {
  const object = asRecord(record);
  const pids = asRecord(object?.['pids']);
  const doiPid = asRecord(pids?.['doi']);
  return asString(doiPid?.['identifier'])
    ?? asString(asRecord(object?.['metadata'])?.['doi'])
    ?? asString(object?.['doi'])
    ?? undefined;
}

function escapeZenodoSearchPhrase(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function toPreparedDraft(deposition: ZenodoDeposition): ZenodoPreparedDraft {
  return {
    depositionId: deposition.id,
    draftRecordId: deposition.recordId
  };
}

function parseOptionalDeposition(response: unknown): ZenodoDeposition | null {
  try {
    return parseDeposition(response);
  } catch {
    return null;
  }
}

function parseDepositionFiles(response: unknown): readonly ZenodoDepositionFile[] {
  if (!Array.isArray(response)) throw new Error('Expected Zenodo deposition files array');
  return response.map((entry) => {
    const file = asRecord(entry);
    const id = asString(file?.['id']);
    if (!id) throw new Error('Expected Zenodo deposition file id');
    const filename = asString(file?.['filename']) ?? asString(file?.['name']);
    if (!filename) throw new Error('Expected Zenodo deposition file filename');
    return { id, filename };
  });
}

function uniqueZenodoFileKeys(files: readonly ZenodoUploadFile[]): readonly ZenodoUploadFile[] {
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.filename, (counts.get(file.filename) ?? 0) + 1);

  const seen = new Map<string, number>();
  return files.map((file) => {
    if ((counts.get(file.filename) ?? 0) < 2) return file;
    const index = seen.get(file.filename) ?? 0;
    seen.set(file.filename, index + 1);
    return {
      ...file,
      filename: appendFilenameSuffix(file.filename, file.key, index)
    };
  });
}

function appendFilenameSuffix(filename: string, key: string, index: number): string {
  const dot = filename.lastIndexOf('.');
  const suffix = index === 0 ? key : `${key}-${index + 1}`;
  if (dot <= 0) return `${filename}-${suffix}`;
  return `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingLatestDraftUrl(recordId: string): never {
  throw new Error(`Zenodo newversion response for ${recordId} did not include links.latest_draft`);
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function shouldReconcilePublishedDraftAfterPublishFailure(error: unknown): boolean {
  if (!(error instanceof ProviderHttpError)) return false;
  if (error.retryable) return true;
  if (error.status !== 400) return false;
  return /state does not allow/i.test(error.body) || /already published/i.test(error.body);
}
