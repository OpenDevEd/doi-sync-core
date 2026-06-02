import { z } from 'zod';
import type { ZoteroChildItem } from '../files.js';
import type { ZoteroParentItem } from '../metadata.js';
import type { ZoteroReader } from '../ports.js';
import { ProviderHttpError, retryAfterMsFromHeaders } from '../resilience/errors.js';
import { DirectProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';
import { planZoteroDoiDriftAutofix, planZoteroWriteback, type ZoteroWritebackIdentifiers } from './writeback.js';

export interface ResponseHeadersLike {
  readonly get: (name: string) => string | null;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: ResponseHeadersLike;
  readonly json: () => Promise<unknown>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  readonly text: () => Promise<string>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<ResponseLike>;

export interface ZoteroApiClientOptions {
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
  readonly operationRunner?: ProviderOperationRunner;
}

export interface DownloadAttachmentFileInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly attachmentKey: string;
}

export interface DownloadedAttachmentFile {
  readonly bytes: Uint8Array;
  readonly etag?: string;
}

export interface PatchZoteroParentItemInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly itemKey: string;
  readonly ifUnmodifiedSinceVersion: number;
  readonly patch: {
    readonly DOI?: string;
    readonly extra?: string;
    readonly url?: string;
  };
}

export interface CreateLinkedUrlAttachmentInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly parentItemKey: string;
  readonly title: string;
  readonly url: string;
  readonly tags: readonly string[];
}

export interface PatchLinkedUrlAttachmentInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly attachmentKey: string;
  readonly ifUnmodifiedSinceVersion: number;
  readonly patch: {
    readonly title: string;
    readonly url: string;
    readonly tags: readonly { readonly tag: string }[];
  };
}

export interface DeleteZoteroItemInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly itemKey: string;
  readonly ifUnmodifiedSinceVersion: number;
}

export interface AddTagsToZoteroItemInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly itemKey: string;
  readonly tags: readonly string[];
}

export interface CreatedZoteroAttachment {
  readonly key: string;
}

export interface ApplyManagedZoteroWritebackInput {
  readonly groupId: string;
  readonly apiKey: string;
  readonly itemKey: string;
  readonly itemVersion: number;
  readonly publicResourceUrl?: string;
  readonly data: {
    readonly DOI?: string | null;
    readonly extra?: string | null;
    readonly url?: string | null;
  };
  readonly identifiers: ZoteroWritebackIdentifiers;
}

export type ApplyDoiDriftAutofixInput = ApplyManagedZoteroWritebackInput;

const zoteroParentItemSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().nonnegative(),
  data: z.object({
    itemType: z.string().min(1),
    title: z.string().nullable().optional(),
    DOI: z.string().nullable().optional(),
    doi: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    abstractNote: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    institution: z.string().nullable().optional(),
    publisher: z.string().nullable().optional(),
    creators: z.array(z.object({
      creatorType: z.string(),
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      name: z.string().nullable().optional()
    })).nullable().optional(),
    tags: z.array(z.object({ tag: z.string() })).nullable().optional(),
    extra: z.string().nullable().optional(),
    callNumber: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    deleted: z.union([z.boolean(), z.number()]).nullable().optional(),
    relations: z.record(z.string(), z.union([z.string(), z.array(z.string())])).nullable().optional()
  })
});

const zoteroChildItemSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().nonnegative(),
  data: z.object({
    itemType: z.string().min(1),
    linkMode: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    contentType: z.string().nullable().optional(),
    md5: z.string().nullable().optional(),
    mtime: z.number().nullable().optional(),
    url: z.string().nullable().optional(),
    tags: z.array(z.object({ tag: z.string() })).nullable().optional()
  })
});

const zoteroCreateItemsResponseSchema = z.object({
  successful: z.record(z.string(), z.object({
    key: z.string().min(1)
  })).optional(),
  failed: z.record(z.string(), z.object({
    code: z.number().optional(),
    message: z.string().optional()
  })).optional()
});

const zoteroTaggableItemSchema = z.object({
  key: z.string().min(1),
  version: z.number().int().nonnegative(),
  data: z.object({
    itemType: z.string().min(1),
    tags: z.array(z.object({ tag: z.string() })).nullable().optional()
  })
});

/** Reads Zotero items/files and applies managed DOI sync writebacks. */
export class ZoteroApiClient implements ZoteroReader {
  private readonly fetch: FetchLike;
  private readonly endpoint: string;
  private readonly operationRunner: ProviderOperationRunner;

  constructor(options: ZoteroApiClientOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? 'https://api.zotero.org';
    this.operationRunner = options.operationRunner ?? new DirectProviderOperationRunner();
  }

  async readParentAndChildren(input: {
    readonly groupId: string;
    readonly apiKey: string;
    readonly itemKey: string;
  }): Promise<{ readonly parent: ZoteroParentItem; readonly children: readonly ZoteroChildItem[] }> {
    const [parent, children] = await Promise.all([
      this.getJson(this.groupItemUrl(input.groupId, input.itemKey), input.apiKey),
      this.getJson(`${this.groupItemUrl(input.groupId, input.itemKey)}/children`, input.apiKey)
    ]);

    return {
      parent: zoteroParentItemSchema.parse(parent),
      children: z.array(zoteroChildItemSchema).parse(children)
    };
  }

  async downloadAttachmentFile(input: DownloadAttachmentFileInput): Promise<DownloadedAttachmentFile> {
    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(`${this.groupItemUrl(input.groupId, input.attachmentKey)}/file`, {
        method: 'GET',
        headers: zoteroHeaders(input.apiKey)
      });
      await assertOk(response);
      const arrayBuffer = await response.arrayBuffer();
      const etag = response.headers.get('ETag') ?? undefined;
      return {
        bytes: new Uint8Array(arrayBuffer),
        ...(etag ? { etag } : {})
      };
    });
  }

  async patchParentItem(input: PatchZoteroParentItemInput): Promise<void> {
    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(this.groupItemUrl(input.groupId, input.itemKey), {
        method: 'PATCH',
        headers: {
          ...zoteroHeaders(input.apiKey),
          'If-Unmodified-Since-Version': String(input.ifUnmodifiedSinceVersion),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(input.patch)
      });
      await assertOk(response);
    });
  }

  async createLinkedUrlAttachment(input: CreateLinkedUrlAttachmentInput): Promise<CreatedZoteroAttachment> {
    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(this.groupItemsUrl(input.groupId), {
        method: 'POST',
        headers: {
          ...zoteroHeaders(input.apiKey),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([{
          itemType: 'attachment',
          parentItem: input.parentItemKey,
          linkMode: 'linked_url',
          title: input.title,
          url: input.url,
          note: '',
          contentType: '',
          charset: '',
          tags: input.tags.map((tag) => ({ tag })),
          relations: {}
        }])
      });
      await assertOk(response);
      const parsed = zoteroCreateItemsResponseSchema.parse(await response.json());
      const failed = parsed.failed?.['0'];
      if (failed) throw new Error(`Zotero linked-url attachment create failed: ${failed.message ?? failed.code ?? 'unknown error'}`);
      const created = parsed.successful?.['0'];
      if (!created) throw new Error('Zotero linked-url attachment create did not return a created item key');
      return { key: created.key };
    });
  }

  async patchLinkedUrlAttachment(input: PatchLinkedUrlAttachmentInput): Promise<void> {
    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(this.groupItemUrl(input.groupId, input.attachmentKey), {
        method: 'PATCH',
        headers: {
          ...zoteroHeaders(input.apiKey),
          'If-Unmodified-Since-Version': String(input.ifUnmodifiedSinceVersion),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(input.patch)
      });
      await assertOk(response);
    });
  }

  async deleteItem(input: DeleteZoteroItemInput): Promise<void> {
    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(this.groupItemUrl(input.groupId, input.itemKey), {
        method: 'DELETE',
        headers: {
          ...zoteroHeaders(input.apiKey),
          'If-Unmodified-Since-Version': String(input.ifUnmodifiedSinceVersion)
        }
      });
      await assertOk(response);
    });
  }

  async addTagsToItem(input: AddTagsToZoteroItemInput): Promise<void> {
    const item = zoteroTaggableItemSchema.parse(await this.getJson(this.groupItemUrl(input.groupId, input.itemKey), input.apiKey));
    const tags = mergeZoteroTags(item.data.tags ?? [], input.tags);
    if (sameTags(item.data.tags ?? [], tags)) return;

    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(this.groupItemUrl(input.groupId, input.itemKey), {
        method: 'PATCH',
        headers: {
          ...zoteroHeaders(input.apiKey),
          'If-Unmodified-Since-Version': String(item.version),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tags })
      });
      await assertOk(response);
    });
  }

  async applyManagedWriteback(input: ApplyManagedZoteroWritebackInput): Promise<void> {
    const plan = planZoteroWriteback({
      itemVersion: input.itemVersion,
      ...(input.publicResourceUrl ? { publicResourceUrl: input.publicResourceUrl } : {}),
      data: input.data,
      identifiers: input.identifiers
    });
    if (plan.type === 'noop') return;
    if (plan.type === 'conflict') throw new Error(plan.reason);
    await this.patchParentItem({
      groupId: input.groupId,
      apiKey: input.apiKey,
      itemKey: input.itemKey,
      ifUnmodifiedSinceVersion: plan.ifUnmodifiedSinceVersion,
      patch: plan.patch
    });
  }

  async applyDoiDriftAutofix(input: ApplyDoiDriftAutofixInput): Promise<void> {
    const plan = planZoteroDoiDriftAutofix({
      itemVersion: input.itemVersion,
      ...(input.publicResourceUrl ? { publicResourceUrl: input.publicResourceUrl } : {}),
      data: input.data,
      identifiers: input.identifiers
    });
    if (plan.type === 'noop') return;
    if (plan.type === 'conflict') throw new Error(plan.reason);
    await this.patchParentItem({
      groupId: input.groupId,
      apiKey: input.apiKey,
      itemKey: input.itemKey,
      ifUnmodifiedSinceVersion: plan.ifUnmodifiedSinceVersion,
      patch: plan.patch
    });
  }

  private async getJson(url: string, apiKey: string): Promise<unknown> {
    return this.operationRunner.run('zotero', async () => {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: zoteroHeaders(apiKey)
      });
      await assertOk(response);
      return response.json();
    });
  }

  private groupItemUrl(groupId: string, itemKey: string): string {
    return `${this.endpoint}/groups/${encodeURIComponent(groupId)}/items/${encodeURIComponent(itemKey)}`;
  }

  private groupItemsUrl(groupId: string): string {
    return `${this.endpoint}/groups/${encodeURIComponent(groupId)}/items`;
  }
}

function mergeZoteroTags(
  existing: readonly { readonly tag: string }[],
  additions: readonly string[]
): readonly { readonly tag: string }[] {
  const seen = new Set(existing.map((entry) => entry.tag));
  const merged = [...existing];
  for (const tag of additions.map((value) => value.trim()).filter((value) => value.length > 0)) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    merged.push({ tag });
  }
  return merged;
}

function sameTags(
  left: readonly { readonly tag: string }[],
  right: readonly { readonly tag: string }[]
): boolean {
  return left.length === right.length && left.every((entry, index) => entry.tag === right[index]?.tag);
}

function zoteroHeaders(apiKey: string): HeadersInit {
  return {
    'Zotero-API-Key': apiKey,
    'Zotero-API-Version': '3'
  };
}

async function assertOk(response: ResponseLike): Promise<void> {
  if (response.ok) return;
  throw new ProviderHttpError({
    provider: 'zotero',
    status: response.status,
    body: await response.text(),
    retryAfterMs: retryAfterMsFromHeaders(response.headers)
  });
}
