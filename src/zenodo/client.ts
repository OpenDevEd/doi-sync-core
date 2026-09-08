import { createHash } from 'node:crypto';
import { buildZenodoWritePayload, parseZenodoLegacyDepositionIdentifiers, parseZenodoRecordIdentifiers, parseZenodoRecordSnapshot, ZENODO_INVENIORDM_ACCEPT, type DoiPolicy, type ZenodoDoiLookupResult, type ZenodoLegacyDepositionIdentifiers, type ZenodoLegacyDepositionPayload, type ZenodoPublishedRecordVerification, type ZenodoRecordIdentifiers, type ZenodoRecordSnapshot, type ZenodoUnsubmittedDraftDoiLookupResult, type ZenodoVerificationResult } from './records.js';
import type { ZenodoPreparedDraft, ZenodoPublishJournalOperationType } from './journal.js';
import type { PublicationProviderMetadata } from '../publication/record.js';
import { asJsonObject, toJsonValue } from '../json.js';
import type { JsonValue } from '../hash.js';
import { ProviderHttpError, retryAfterMsFromHeaders, type ProviderResponseHeaders } from '../resilience/errors.js';
import { DirectProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';
import { asRecord, asString, idString } from '../guards.js';
import {
  parseZenodoLegacyDepositionFiles,
  verifyZenodoLegacyDepositionState,
  type ZenodoExpectedPublishedFile,
  type ZenodoLegacyDepositionFile,
  type ZenodoPublishedStateVerification
} from './verification.js';

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

export type FindZenodoDraftByDoiInput = FindZenodoRecordByDoiInput;

export interface ReadZenodoRecordSnapshotInput {
  readonly token: string;
  readonly recordId: string;
}

export interface VerifyZenodoPublishedStateInput {
  readonly token: string;
  readonly recordId: string;
  readonly expectedPayload: ZenodoLegacyDepositionPayload;
  readonly files: readonly ZenodoExpectedPublishedFile[];
}

export type ZenodoRemoteStateVerification =
  | ZenodoPublishedStateVerification
  | { readonly status: 'missing' };

export interface ZenodoUploadFile {
  readonly key: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ZenodoCreateRecordInput {
  readonly draftDepositionId?: string;
  readonly token: string;
  readonly doiPolicy: DoiPolicy;
  readonly metadata: PublicationProviderMetadata;
  readonly files: readonly ZenodoUploadFile[];
  /** Public resource URL appended idempotently to the Zenodo `description`. */
  readonly resourceUrl?: string;
  /** Called as soon as Zenodo returns a draft/deposition id, before later mutable steps can fail. */
  readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
}

export type ZenodoPrepareEmptyDraftInput = Required<Pick<ZenodoCreateRecordInput, 'token' | 'onPreparedDraft'>>;

export interface ZenodoAdoptLegacyDepositionInput extends ZenodoCreateRecordInput {
  readonly depositionId: string;
}

export interface ZenodoUpdateRecordMetadataInput {
  readonly token: string;
  readonly latestRecordId: string;
  readonly doiPolicy: DoiPolicy;
  readonly metadata: PublicationProviderMetadata;
  /** Public resource URL appended idempotently to the Zenodo `description`. */
  readonly resourceUrl?: string;
  /** Called as soon as Zenodo returns a draft/deposition id, before later mutable steps can fail. */
  readonly onPreparedDraft?: (draft: ZenodoPreparedDraft) => Promise<void>;
}

export interface ZenodoCreateNewVersionInput extends ZenodoUpdateRecordMetadataInput {
  readonly files: readonly ZenodoUploadFile[];
}

export type ZenodoUpdateRecordFilesInput = ZenodoCreateNewVersionInput;

export interface DeleteZenodoUnpublishedDraftInput {
  readonly token: string;
  readonly depositionId: string;
}

export interface DiscardZenodoPreparedDraftInput {
  readonly token: string;
  readonly operationType: ZenodoPublishJournalOperationType;
  readonly draft: ZenodoPreparedDraft;
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

  async findDraftByDoi(input: FindZenodoDraftByDoiInput): Promise<ZenodoUnsubmittedDraftDoiLookupResult> {
    const depositions = await this.listUnsubmittedDepositions(input.token);
    const normalizedDoi = normalizeDoiForExactMatch(input.doi);
    const matches = depositions.filter((deposition) => (
      normalizeDoiForExactMatch(deposition.doi) === normalizedDoi
      || normalizeDoiForExactMatch(deposition.reservedDoi) === normalizedDoi
    ));
    if (matches.length === 0) return { status: 'not_found' };
    const firstMatch = matches[0];
    if (matches.length === 1 && firstMatch) {
      return {
        status: 'found',
        deposition: {
          kind: 'legacy_unsubmitted_deposition',
          deposition: firstMatch
        }
      };
    }
    return {
      status: 'ambiguous',
      depositionIds: matches.map((deposition) => deposition.depositionId)
    };
  }

  async readPublishedRecord(input: ReadZenodoRecordSnapshotInput): Promise<ZenodoRecordIdentifiers | null> {
    const snapshot = await this.readRecordSnapshot(input);
    return snapshot?.identifiers ?? null;
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

  async verifyPublishedState(input: VerifyZenodoPublishedStateInput): Promise<ZenodoRemoteStateVerification> {
    const response = await this.request(
      `${this.endpoint}/api/deposit/depositions/${encodeURIComponent(input.recordId)}`,
      {
        method: 'GET',
        headers: authHeaders(input.token)
      },
      { allowedStatuses: [404] }
    );
    if (response.status === 404) return { status: 'missing' };
    return verifyZenodoLegacyDepositionState({
      response: await response.json(),
      expectedPayload: input.expectedPayload,
      expectedFiles: input.files
    });
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

  async updateRecordFiles(input: ZenodoUpdateRecordFilesInput): Promise<ZenodoRecordIdentifiers> {
    const draft = await this.prepareUpdateRecordFiles(input);
    return this.publishDraft({ token: input.token, draft });
  }

  async deleteUnpublishedDraft(input: DeleteZenodoUnpublishedDraftInput): Promise<void> {
    await this.deleteUnpublishedDeposition(input.token, input.depositionId);
  }

  async discardPreparedDraft(input: DiscardZenodoPreparedDraftInput): Promise<void> {
    if (input.operationType === 'zenodo_file_update' || input.draft.api === 'invenio_record') {
      await this.request(
        `${this.endpoint}/api/records/${encodeURIComponent(input.draft.draftRecordId)}/draft`,
        { method: 'DELETE', headers: invenioHeaders(input.token) },
        { allowedStatuses: [404] }
      );
      return;
    }
    if (input.operationType === 'zenodo_metadata_update') {
      await this.request(
        `${this.endpoint}/api/deposit/depositions/${encodeURIComponent(input.draft.depositionId)}/actions/discard`,
        { method: 'POST', headers: authHeaders(input.token) },
        { allowedStatuses: [400, 404] }
      );
      return;
    }
    await this.deleteUnpublishedDeposition(input.token, input.draft.depositionId);
  }

  async prepareEmptyDraft(input: ZenodoPrepareEmptyDraftInput): Promise<ZenodoPreparedDraft> {
    return toPreparedDraft(await this.createEmptyDeposition(input.token, input.onPreparedDraft));
  }

  async prepareCreateRecord(input: ZenodoCreateRecordInput): Promise<ZenodoPreparedDraft> {
    if (input.draftDepositionId) {
      const existing = await this.getDeposition(input.token, input.draftDepositionId);
      if (existing) return this.prepareExistingDeposition(input, existing);
    }
    const deposition = await this.createEmptyDeposition(input.token, input.onPreparedDraft);
    const draft = toPreparedDraft(deposition);
    await this.uploadFilesToBucket(input.token, deposition, input.files);
    const payloads = buildDepositionPayloads(deposition, input);
    await this.updateDepositionMetadata(input.token, deposition.id, payloads.wire);
    return withPayloadSnapshot(draft, payloads.managed);
  }

  async prepareAdoptLegacyDeposition(input: ZenodoAdoptLegacyDepositionInput): Promise<ZenodoPreparedDraft> {
    const deposition = await this.getDeposition(input.token, input.depositionId);
    if (!deposition) throw new Error(`Zenodo deposition ${input.depositionId} no longer exists`);
    return this.prepareExistingDeposition(input, deposition);
  }

  private async prepareExistingDeposition(input: ZenodoCreateRecordInput, deposition: ZenodoDeposition): Promise<ZenodoPreparedDraft> {
    const draft = toPreparedDraft(deposition);
    await input.onPreparedDraft?.(draft);
    await this.replaceLegacyDepositionFiles(input.token, deposition, input.files);
    const payloads = buildDepositionPayloads(deposition, input);
    await this.updateDepositionMetadata(input.token, deposition.id, payloads.wire);
    return withPayloadSnapshot(draft, payloads.managed);
  }

  async prepareUpdateRecordMetadata(input: ZenodoUpdateRecordMetadataInput): Promise<ZenodoPreparedDraft> {
    const editable = await this.postDepositionAction(input.token, input.latestRecordId, 'edit');
    const draft = toPreparedDraft(editable);
    await input.onPreparedDraft?.(draft);
    const payloads = buildDepositionPayloads(editable, input);
    await this.updateDepositionMetadata(input.token, editable.id, payloads.wire);
    return withPayloadSnapshot(draft, payloads.managed);
  }

  async prepareNewVersion(input: ZenodoCreateNewVersionInput): Promise<ZenodoPreparedDraft> {
    const latestDraftUrl = await this.createNewVersionDraft(input.token, input.latestRecordId);
    const draft = await this.getDepositionByUrl(input.token, latestDraftUrl);
    const preparedDraft = toPreparedDraft(draft);
    await input.onPreparedDraft?.(preparedDraft);
    await this.replaceLegacyDepositionFiles(input.token, draft, input.files);
    const payloads = buildDepositionPayloads(draft, input);
    await this.updateDepositionMetadata(input.token, draft.id, payloads.wire);
    return withPayloadSnapshot(preparedDraft, payloads.managed);
  }

  async prepareUpdateRecordFiles(input: ZenodoUpdateRecordFilesInput): Promise<ZenodoPreparedDraft> {
    const draftRecord = await this.openInvenioEditDraft(input.token, input.latestRecordId);
    const draft = toInvenioPreparedDraft(draftRecord);
    await input.onPreparedDraft?.(draft);
    await this.unlockInvenioDraftFileModification(input.token, draftRecord, input.latestRecordId);
    await this.replaceInvenioDraftFiles(input.token, input.latestRecordId, input.files);
    return draft;
  }

  async publishDraft(input: {
    readonly token: string;
    readonly draft: ZenodoPreparedDraft;
  }): Promise<ZenodoRecordIdentifiers> {
    if (input.draft.api === 'invenio_record') {
      return this.publishInvenioDraft(input.token, input.draft.draftRecordId)
        .catch((error: unknown) => this.reconcilePublishedDraftAfterPublishFailure(input.token, input.draft, error));
    }
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

  private async publishInvenioDraft(token: string, recordId: string): Promise<ZenodoRecordIdentifiers> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(recordId)}/draft/actions/publish`, {
      method: 'POST',
      headers: invenioHeaders(token)
    });
    return parseZenodoRecordIdentifiers(await response.json());
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

  private async listUnsubmittedDepositions(token: string): Promise<readonly ZenodoLegacyDepositionIdentifiers[]> {
    const pageSize = 100;
    const depositions: ZenodoLegacyDepositionIdentifiers[] = [];
    for (let page = 1; ; page += 1) {
      const params = new URLSearchParams({
        page: String(page),
        size: String(pageSize)
      });
      const response = await this.request(`${this.endpoint}/api/deposit/depositions?${params.toString()}`, {
        method: 'GET',
        headers: authHeaders(token)
      });
      const parsedPage = parseUnsubmittedDepositionPage(await response.json());
      depositions.push(...parsedPage.depositions);
      if (parsedPage.rawCount < pageSize) return depositions;
    }
  }

  private async createEmptyDeposition(token: string, onPreparedDraft?: ZenodoPrepareEmptyDraftInput['onPreparedDraft']): Promise<ZenodoDeposition> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: '{}'
    });
    const deposition = parseDeposition(await response.json());
    await this.notifyPreparedDraft(toPreparedDraft(deposition), onPreparedDraft, () => this.deleteUnpublishedDeposition(token, deposition.id));
    return deposition;
  }

  private async getDeposition(token: string, depositionId: string): Promise<ZenodoDeposition | null> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}`, {
      method: 'GET',
      headers: authHeaders(token)
    }, {allowedStatuses: [404]});
    if (response.status === 404) return null;
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

  private async listLegacyDepositionFiles(token: string, depositionId: string): Promise<readonly ZenodoLegacyDepositionFile[]> {
    const response = await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}/files`, {
      method: 'GET',
      headers: authHeaders(token)
    });
    return parseZenodoLegacyDepositionFiles(await response.json());
  }

  private async updateDepositionMetadata(token: string, depositionId: string, payload: ZenodoLegacyDepositionPayload): Promise<void> {
    await this.request(`${this.endpoint}/api/deposit/depositions/${encodeURIComponent(depositionId)}`, {
      method: 'PUT',
      headers: jsonHeaders(token),
      body: JSON.stringify(payload)
    });
  }

  private async openInvenioEditDraft(token: string, recordId: string): Promise<InvenioRecordDraft> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(recordId)}/draft`, {
      method: 'POST',
      headers: invenioHeaders(token)
    });
    return parseInvenioRecordDraft(await response.json());
  }

  private async unlockInvenioDraftFileModification(token: string, draft: InvenioRecordDraft, recordId: string): Promise<void> {
    await this.request(draft.fileModificationUrl ?? `${this.endpoint}/api/records/${encodeURIComponent(recordId)}/file-modification`, {
      method: 'POST',
      headers: jsonHeadersWithAccept(token, ZENODO_INVENIORDM_ACCEPT),
      body: '{}'
    });
  }

  private async replaceInvenioDraftFiles(token: string, recordId: string, files: readonly ZenodoUploadFile[]): Promise<void> {
    const currentFiles = await this.listInvenioDraftFiles(token, recordId);
    const uniqueFiles = uniqueZenodoFileKeys(files);
    const desiredFileSet = new Set(uniqueFiles.map((file) => file.filename));

    for (const file of uniqueFiles) {
      const draftFile = await this.prepareWritableInvenioDraftFile(token, recordId, currentFiles, file);
      if (!draftFile) continue;
      await this.uploadInvenioDraftFileContent(token, draftFile, file.bytes);
      await this.commitInvenioDraftFile(token, draftFile);
    }

    for (const file of currentFiles) {
      if (desiredFileSet.has(file.key)) continue;
      await this.deleteInvenioDraftFile(token, file);
    }
  }

  private async prepareWritableInvenioDraftFile(
    token: string,
    recordId: string,
    currentFiles: readonly InvenioDraftFile[],
    file: ZenodoUploadFile
  ): Promise<InvenioDraftFile | null> {
    const existingWritable = findWritableInvenioDraftFile(currentFiles, file.filename);
    if (existingWritable) return existingWritable;
    if (findCompletedMatchingInvenioDraftFile(currentFiles, file)) return null;

    try {
      return await this.createInvenioDraftFile(token, recordId, file.filename);
    } catch (error) {
      if (!isInvenioDraftFileAlreadyExistsError(error)) throw error;
      const refreshedFiles = await this.listInvenioDraftFiles(token, recordId);
      const refreshedWritable = findWritableInvenioDraftFile(refreshedFiles, file.filename);
      if (refreshedWritable) return refreshedWritable;
      if (findCompletedMatchingInvenioDraftFile(refreshedFiles, file)) return null;

      const existingSameKey = refreshedFiles.find((entry) => entry.key === file.filename);
      if (!existingSameKey) throw error;
      await this.deleteInvenioDraftFile(token, existingSameKey);
      return this.createInvenioDraftFile(token, recordId, file.filename);
    }
  }

  private async listInvenioDraftFiles(token: string, recordId: string): Promise<readonly InvenioDraftFile[]> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(recordId)}/draft/files`, {
      method: 'GET',
      headers: invenioHeaders(token)
    });
    return parseInvenioDraftFiles(await response.json());
  }

  private async createInvenioDraftFile(token: string, recordId: string, filename: string): Promise<InvenioDraftFile> {
    const response = await this.request(`${this.endpoint}/api/records/${encodeURIComponent(recordId)}/draft/files`, {
      method: 'POST',
      headers: jsonHeadersWithAccept(token, ZENODO_INVENIORDM_ACCEPT),
      body: JSON.stringify([{ key: filename }])
    });
    const file = findWritableInvenioDraftFile(parseInvenioDraftFiles(await response.json()), filename)
      ?? findWritableInvenioDraftFile(await this.listInvenioDraftFiles(token, recordId), filename);
    if (!file) throw new Error(`Zenodo draft file create response did not include a writable ${filename}`);
    return file;
  }

  private async uploadInvenioDraftFileContent(token: string, file: InvenioDraftFile, bytes: Uint8Array): Promise<void> {
    await this.request(file.links.content, {
      method: 'PUT',
      headers: {
        ...invenioHeaders(token),
        'Content-Type': 'application/octet-stream'
      },
      body: new Blob([copyToArrayBuffer(bytes)], { type: 'application/octet-stream' })
    });
  }

  private async commitInvenioDraftFile(token: string, file: InvenioDraftFile): Promise<void> {
    await this.request(file.links.commit, {
      method: 'POST',
      headers: invenioHeaders(token)
    });
  }

  private async deleteInvenioDraftFile(token: string, file: InvenioDraftFile): Promise<void> {
    await this.request(file.links.self, {
      method: 'DELETE',
      headers: invenioHeaders(token)
    }, { allowedStatuses: [404] });
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
  readonly parentId?: string;
  readonly bucketUrl?: string;
  readonly latestDraftUrl?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

function buildDepositionPayloads(
  deposition: ZenodoDeposition,
  input: ZenodoCreateRecordInput | ZenodoUpdateRecordMetadataInput
): {
  readonly wire: ZenodoLegacyDepositionPayload;
  readonly managed: ZenodoLegacyDepositionPayload;
} {
  const managed = buildZenodoWritePayload({
    doiPolicy: input.doiPolicy,
    metadata: input.metadata,
    ...(input.resourceUrl ? { resourceUrl: input.resourceUrl } : {})
  });
  const wire = buildZenodoWritePayload({
    doiPolicy: input.doiPolicy,
    metadata: input.metadata,
    ...(deposition.metadata ? { existingMetadata: deposition.metadata } : {}),
    ...(input.resourceUrl ? { resourceUrl: input.resourceUrl } : {})
  });
  return { wire, managed };
}

function withPayloadSnapshot(draft: ZenodoPreparedDraft, payload: JsonValue | ZenodoLegacyDepositionPayload): ZenodoPreparedDraft {
  return {
    ...draft,
    payloadSnapshot: toJsonValue(payload)
  };
}

function jsonHeaders(token: string): HeadersInit {
  return jsonHeadersWithAccept(token);
}

function jsonHeadersWithAccept(token: string, accept?: string): HeadersInit {
  return {
    ...authHeaders(token),
    ...(accept ? { Accept: accept } : {}),
    'Content-Type': 'application/json'
  };
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`
  };
}

function invenioHeaders(token: string): HeadersInit {
  return {
    ...authHeaders(token),
    Accept: ZENODO_INVENIORDM_ACCEPT
  };
}

function parseDeposition(response: unknown): ZenodoDeposition {
  const deposition = asRecord(response);
  if (!deposition) throw new Error('Expected Zenodo deposition response object');

  const id = idString(deposition['id']);
  const recordId = idString(deposition['record_id']) ?? id;
  const parentId = idString(deposition['conceptrecid']);
  if (!id || !recordId) throw new Error('Expected Zenodo deposition id and record_id');

  const links = asRecord(deposition['links']) ?? {};
  const bucketUrl = asString(links['bucket']);
  const latestDraftUrl = asString(links['latest_draft']);
  const metadata = parseOptionalJsonObject(deposition['metadata']);

  return {
    id,
    recordId,
    ...(parentId ? { parentId } : {}),
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

interface UnsubmittedDepositionPage {
  readonly rawCount: number;
  readonly depositions: readonly ZenodoLegacyDepositionIdentifiers[];
}

interface InvenioRecordDraft {
  readonly id: string;
  readonly parentId?: string;
  readonly fileModificationUrl?: string;
}

interface InvenioDraftFile {
  readonly key: string;
  readonly status?: string;
  readonly fileId?: string;
  readonly checksum?: string;
  readonly size?: number;
  readonly links: {
    readonly self: string;
    readonly content: string;
    readonly commit: string;
  };
}

function parseUnsubmittedDepositionPage(response: unknown): UnsubmittedDepositionPage {
  if (!Array.isArray(response)) throw new Error('Expected Zenodo deposition list response array');
  return {
    rawCount: response.length,
    depositions: response.flatMap((entry) => {
      const deposition = parseZenodoLegacyDepositionIdentifiers(entry);
      return deposition ? [deposition] : [];
    })
  };
}

function normalizeDoiForExactMatch(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
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
    draftRecordId: deposition.recordId,
    ...(deposition.parentId ? { parentId: deposition.parentId } : {})
  };
}

function toInvenioPreparedDraft(record: InvenioRecordDraft): ZenodoPreparedDraft {
  return {
    depositionId: record.id,
    draftRecordId: record.id,
    ...(record.parentId ? { parentId: record.parentId } : {}),
    api: 'invenio_record'
  };
}

function parseOptionalDeposition(response: unknown): ZenodoDeposition | null {
  try {
    return parseDeposition(response);
  } catch {
    return null;
  }
}

function parseInvenioRecordDraft(response: unknown): InvenioRecordDraft {
  const record = asRecord(response);
  if (!record) throw new Error('Expected Zenodo InvenioRDM draft response object');
  const id = idString(record['id']);
  if (!id) throw new Error('Expected Zenodo InvenioRDM draft id');
  const parent = asRecord(record['parent']);
  const parentId = idString(parent?.['id']);
  const links = asRecord(record['links']) ?? {};
  const fileModificationUrl = asString(links['file_modification']);
  return {
    id,
    ...(parentId ? { parentId } : {}),
    ...(fileModificationUrl ? { fileModificationUrl } : {})
  };
}

function parseInvenioDraftFiles(response: unknown): readonly InvenioDraftFile[] {
  return parseInvenioDraftFileEntries(response).map((entry) => parseInvenioDraftFile(entry));
}

function parseInvenioDraftFileEntries(response: unknown): readonly unknown[] {
  if (Array.isArray(response)) return response;
  const object = asRecord(response);
  if (!object) throw new Error('Expected Zenodo draft files response object or array');
  const entries = object['entries'];
  if (Array.isArray(entries)) return entries;
  const entriesRecord = asRecord(entries);
  return entriesRecord ? Object.values(entriesRecord) : [];
}

function parseInvenioDraftFile(response: unknown): InvenioDraftFile {
  const file = asRecord(response);
  if (!file) throw new Error('Expected Zenodo draft file response object');
  const key = asString(file['key']);
  const status = asString(file['status']);
  const fileId = asString(file['file_id']);
  const checksum = asString(file['checksum']);
  const size = asNumber(file['size']);
  const links = asRecord(file['links']);
  const self = asString(links?.['self']);
  const content = asString(links?.['content']);
  const commit = asString(links?.['commit']);
  if (!key || !self || !content || !commit) {
    throw new Error('Expected Zenodo draft file key and self/content/commit links');
  }
  return {
    key,
    ...(status ? { status } : {}),
    ...(fileId ? { fileId } : {}),
    ...(checksum ? { checksum } : {}),
    ...(size === undefined ? {} : { size }),
    links: {
      self,
      content,
      commit
    }
  };
}

function findWritableInvenioDraftFile(files: readonly InvenioDraftFile[], filename: string): InvenioDraftFile | undefined {
  return files.find((file) => file.key === filename && isWritableInvenioDraftFile(file));
}

function isWritableInvenioDraftFile(file: InvenioDraftFile): boolean {
  return file.status === 'pending' || file.fileId === undefined;
}

function findCompletedMatchingInvenioDraftFile(files: readonly InvenioDraftFile[], upload: ZenodoUploadFile): InvenioDraftFile | undefined {
  return files.find((file) => file.key === upload.filename && !isWritableInvenioDraftFile(file) && completedInvenioDraftFileMatches(file, upload));
}

function completedInvenioDraftFileMatches(file: InvenioDraftFile, upload: ZenodoUploadFile): boolean {
  return file.size === upload.bytes.byteLength && normalizeChecksum(file.checksum) === md5Checksum(upload.bytes);
}

function normalizeChecksum(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.startsWith('md5:') ? normalized : `md5:${normalized}`;
}

function md5Checksum(bytes: Uint8Array): string {
  return `md5:${createHash('md5').update(bytes).digest('hex')}`;
}

function isInvenioDraftFileAlreadyExistsError(error: unknown): boolean {
  return error instanceof ProviderHttpError
    && error.status === 400
    && /file with key .+ already exists/i.test(error.body);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
