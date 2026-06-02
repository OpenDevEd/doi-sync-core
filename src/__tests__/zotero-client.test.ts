import { describe, expect, it } from 'vitest';
import { ZoteroApiClient, type FetchLike, type ResponseLike } from '../zotero/client.js';

function jsonResponse(body: unknown): ResponseLike {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

function binaryResponse(bytes: Uint8Array, etag: string): ResponseLike {
  const copied = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copied).set(bytes);

  return {
    ok: true,
    status: 200,
    headers: { get: (name) => name.toLowerCase() === 'etag' ? etag : null },
    json: () => Promise.resolve({}),
    arrayBuffer: () => Promise.resolve(copied),
    text: () => Promise.resolve('')
  };
}

function parseJsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON string request body');
  return JSON.parse(init.body);
}

describe('ZoteroApiClient', () => {
  it('reads a Zotero parent item and its children from the Web API', async () => {
    const calls: string[] = [];
    const fetch: FetchLike = (url) => {
      calls.push(url);
      if (url.endsWith('/children')) {
        return Promise.resolve(jsonResponse([{
          key: 'PDF12345',
          version: 8,
          data: {
            itemType: 'attachment',
            linkMode: 'imported_file',
            filename: 'report.pdf',
            contentType: 'application/pdf'
          }
        }]));
      }

      return Promise.resolve(jsonResponse({
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: '10.53832/opendeved.1205'
        }
      }));
    };
    const client = new ZoteroApiClient({ fetch });

    await expect(client.readParentAndChildren({
      groupId: '123',
      apiKey: 'redacted',
      itemKey: 'ABC12345'
    })).resolves.toEqual({
      parent: {
        key: 'ABC12345',
        version: 7,
        data: {
          itemType: 'report',
          title: 'Evidence report',
          DOI: '10.53832/opendeved.1205'
        }
      },
      children: [{
        key: 'PDF12345',
        version: 8,
        data: {
          itemType: 'attachment',
          linkMode: 'imported_file',
          filename: 'report.pdf',
          contentType: 'application/pdf'
        }
      }]
    });
    expect(calls).toEqual([
      'https://api.zotero.org/groups/123/items/ABC12345',
      'https://api.zotero.org/groups/123/items/ABC12345/children'
    ]);
  });

  it('downloads attachment bytes through the Zotero file endpoint', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const client = new ZoteroApiClient({
      fetch: () => Promise.resolve(binaryResponse(bytes, 'abc123'))
    });

    await expect(client.downloadAttachmentFile({
      groupId: '123',
      apiKey: 'redacted',
      attachmentKey: 'PDF12345'
    })).resolves.toEqual({
      bytes,
      etag: 'abc123'
    });
  });

  it('patches only managed Zotero parent fields with an item-version precondition', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZoteroApiClient({
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({}));
      }
    });

    await expect(client.patchParentItem({
      groupId: '123',
      apiKey: 'redacted',
      itemKey: 'ABC12345',
      ifUnmodifiedSinceVersion: 42,
      patch: {
        DOI: '10.53832/opendeved.1205',
        extra: 'DOI: 10.53832/opendeved.1205'
      }
    })).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.zotero.org/groups/123/items/ABC12345');
    expect(calls[0]?.init).toMatchObject({
      method: 'PATCH',
      headers: {
        'Zotero-API-Key': 'redacted',
        'Zotero-API-Version': '3',
        'If-Unmodified-Since-Version': '42',
        'Content-Type': 'application/json'
      }
    });
    expect(parseJsonRequestBody(calls[0]?.init)).toEqual({
      DOI: '10.53832/opendeved.1205',
      extra: 'DOI: 10.53832/opendeved.1205'
    });
  });

  it('applies DOI drift autofix by overwriting the managed parent DOI fields', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZoteroApiClient({
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({}));
      }
    });

    await expect(client.applyDoiDriftAutofix({
      groupId: '123',
      apiKey: 'redacted',
      itemKey: 'ABC12345',
      itemVersion: 42,
      publicResourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      data: {
        DOI: '10.9999/wrong',
        extra: 'DOI: 10.9999/wrong',
        url: ''
      },
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205'
      }
    })).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe('https://api.zotero.org/groups/123/items/ABC12345');
    expect(calls[0]?.init.method).toBe('PATCH');
    expect(parseJsonRequestBody(calls[0]?.init)).toEqual({
      DOI: '10.53832/opendeved.1205',
      extra: [
        'DOI: 10.53832/opendeved.1205',
        'previousDOI: 10.9999/wrong',
        'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 10.9999/wrong'
      ].join('\n'),
      url: 'https://docs.opendeved.net/lib/ABC12345'
    });
  });

  it('creates a managed linked-url child attachment under the Zotero parent', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZoteroApiClient({
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({
          successful: {
            0: { key: 'LINK1234' }
          },
          failed: {}
        }));
      }
    });

    await expect(client.createLinkedUrlAttachment({
      groupId: '123',
      apiKey: 'redacted',
      parentItemKey: 'ABC12345',
      title: 'View Zenodo archive [ABC12345]',
      url: 'https://sandbox.zenodo.org/records/502440',
      tags: ['_r:zotzen', '_r:zenodo']
    })).resolves.toEqual({ key: 'LINK1234' });

    expect(calls[0]?.url).toBe('https://api.zotero.org/groups/123/items');
    expect(calls[0]?.init.method).toBe('POST');
    expect(parseJsonRequestBody(calls[0]?.init)).toEqual([{
      itemType: 'attachment',
      parentItem: 'ABC12345',
      linkMode: 'linked_url',
      title: 'View Zenodo archive [ABC12345]',
      url: 'https://sandbox.zenodo.org/records/502440',
      note: '',
      contentType: '',
      charset: '',
      tags: [{ tag: '_r:zotzen' }, { tag: '_r:zenodo' }],
      relations: {}
    }]);
  });

  it('patches a managed linked-url child attachment with an item-version precondition', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZoteroApiClient({
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({}));
      }
    });

    await expect(client.patchLinkedUrlAttachment({
      groupId: '123',
      apiKey: 'redacted',
      attachmentKey: 'LINK1234',
      ifUnmodifiedSinceVersion: 12,
      patch: {
        title: 'Look up DOI [ABC12345]',
        url: 'https://doi.org/10.53832/opendeved.1205',
        tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
      }
    })).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe('https://api.zotero.org/groups/123/items/LINK1234');
    expect(calls[0]?.init).toMatchObject({
      method: 'PATCH',
      headers: {
        'Zotero-API-Key': 'redacted',
        'Zotero-API-Version': '3',
        'If-Unmodified-Since-Version': '12',
        'Content-Type': 'application/json'
      }
    });
    expect(parseJsonRequestBody(calls[0]?.init)).toEqual({
      title: 'Look up DOI [ABC12345]',
      url: 'https://doi.org/10.53832/opendeved.1205',
      tags: [{ tag: '_r:doi' }, { tag: '_r:zotzen' }]
    });
  });

  it('deletes a stale managed linked-url child attachment with an item-version precondition', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZoteroApiClient({
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(jsonResponse({}));
      }
    });

    await expect(client.deleteItem({
      groupId: '123',
      apiKey: 'redacted',
      itemKey: 'LINK1234',
      ifUnmodifiedSinceVersion: 12
    })).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe('https://api.zotero.org/groups/123/items/LINK1234');
    expect(calls[0]?.init).toMatchObject({
      method: 'DELETE',
      headers: {
        'Zotero-API-Key': 'redacted',
        'Zotero-API-Version': '3',
        'If-Unmodified-Since-Version': '12'
      }
    });
  });

  it('adds missing ZotZen success tags without duplicating existing item tags', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZoteroApiClient({
      fetch: (url, init) => {
        calls.push({ url, init });
        if (init.method === 'GET') {
          return Promise.resolve(jsonResponse({
            key: 'PDF12345',
            version: 17,
            data: {
              itemType: 'attachment',
              tags: [{ tag: '_DOILIVE' }, { tag: 'keep' }]
            }
          }));
        }
        return Promise.resolve(jsonResponse({}));
      }
    });

    await expect(client.addTagsToItem({
      groupId: '123',
      apiKey: 'redacted',
      itemKey: 'PDF12345',
      tags: ['_DOILIVE', '_zenodo:uploaded']
    })).resolves.toBeUndefined();

    expect(calls.map((call) => call.init.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]?.url).toBe('https://api.zotero.org/groups/123/items/PDF12345');
    expect(calls[1]?.init).toMatchObject({
      method: 'PATCH',
      headers: {
        'Zotero-API-Key': 'redacted',
        'Zotero-API-Version': '3',
        'If-Unmodified-Since-Version': '17',
        'Content-Type': 'application/json'
      }
    });
    expect(parseJsonRequestBody(calls[1]?.init)).toEqual({
      tags: [{ tag: '_DOILIVE' }, { tag: 'keep' }, { tag: '_zenodo:uploaded' }]
    });
  });
});
