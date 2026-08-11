import { describe, expect, it } from 'vitest';
import { ZenodoApiClient, type ZenodoFetchLike, type ZenodoResponseLike } from '../zenodo/client.js';

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly accept?: string;
  readonly contentType?: string;
  readonly bodyText?: string;
}

describe('ZenodoApiClient published external DOI file modification', () => {
  it('opens a same-record edit draft, unlocks file modification, replaces draft files, and publishes without creating a new version', async () => {
    const requests: CapturedRequest[] = [];
    const fetch: ZenodoFetchLike = async (url, init) => {
      requests.push({
        method: init.method ?? 'GET',
        path: new URL(url).pathname,
        ...optionalHeader('accept', init.headers),
        ...optionalHeader('content-type', init.headers),
        ...await optionalBodyText(init.body)
      });
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';

      if (method === 'POST' && path === '/api/records/508524/draft') {
        return jsonResponse(201, {
          id: '508524',
          parent: { id: '508523' },
          links: {
            file_modification: 'https://sandbox.zenodo.org/api/records/508524/file-modification'
          }
        });
      }
      if (method === 'POST' && path === '/api/records/508524/file-modification') {
        return jsonResponse(200, { status: 'accepted' });
      }
      if (method === 'GET' && path === '/api/records/508524/draft/files') {
        return jsonResponse(200, {
          entries: [
            completedDraftFile('report.pdf'),
            completedDraftFile('stale.pdf')
          ]
        });
      }
      if (method === 'POST' && path === '/api/records/508524/draft/files') {
        const requestedFiles = parseRequestedFileKeys(init.body);
        return jsonResponse(201, {
          entries: [
            completedDraftFile('report.pdf'),
            ...requestedFiles.map((key) => pendingDraftFile(key))
          ]
        });
      }
      if (method === 'PUT' && path === '/api/records/508524/draft/files/report.pdf/content') {
        return jsonResponse(200, pendingDraftFile('report.pdf'));
      }
      if (method === 'PUT' && path === '/api/records/508524/draft/files/appendix.pdf/content') {
        return jsonResponse(200, pendingDraftFile('appendix.pdf'));
      }
      if (method === 'POST' && path === '/api/records/508524/draft/files/report.pdf/commit') {
        return jsonResponse(200, completedDraftFile('report.pdf'));
      }
      if (method === 'POST' && path === '/api/records/508524/draft/files/appendix.pdf/commit') {
        return jsonResponse(200, completedDraftFile('appendix.pdf'));
      }
      if (method === 'DELETE' && path === '/api/records/508524/draft/files/stale.pdf') {
        return emptyResponse(204);
      }
      if (method === 'POST' && path === '/api/records/508524/draft/actions/publish') {
        return jsonResponse(202, {
          id: '508524',
          parent: { id: '508523' },
          pids: {
            doi: {
              identifier: '10.53832/doi-sync-file-edit-probe',
              provider: 'external'
            }
          },
          links: {
            self_html: 'https://sandbox.zenodo.org/records/508524'
          },
          versions: {
            index: 1
          }
        });
      }

      return jsonResponse(500, { message: `Unhandled ${method} ${path}` });
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    const draft = await client.prepareUpdateRecordFiles({
      token: 'zenodo-token',
      latestRecordId: '508524',
      doiPolicy: 'external-crossref',
      metadata: {
        doi: '10.53832/doi-sync-file-edit-probe',
        itemType: 'Report',
        title: 'Probe report',
        publicationDate: '2026-06-04',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [
        {
          key: 'PDF1',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array([1, 2, 3])
        },
        {
          key: 'PDF2',
          filename: 'appendix.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array([4, 5, 6])
        }
      ]
    });
    const identifiers = await client.publishDraft({
      token: 'zenodo-token',
      draft
    });

    expect(draft).toEqual({
      api: 'invenio_record',
      depositionId: '508524',
      draftRecordId: '508524',
      parentId: '508523'
    });
    expect(identifiers).toMatchObject({
      latestRecordId: '508524',
      parentId: '508523',
      versionDoi: '10.53832/doi-sync-file-edit-probe'
    });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/records/508524/draft',
      'POST /api/records/508524/file-modification',
      'GET /api/records/508524/draft/files',
      'POST /api/records/508524/draft/files',
      'PUT /api/records/508524/draft/files/report.pdf/content',
      'POST /api/records/508524/draft/files/report.pdf/commit',
      'POST /api/records/508524/draft/files',
      'PUT /api/records/508524/draft/files/appendix.pdf/content',
      'POST /api/records/508524/draft/files/appendix.pdf/commit',
      'DELETE /api/records/508524/draft/files/stale.pdf',
      'POST /api/records/508524/draft/actions/publish'
    ]);
    expect(requests.find((request) => request.path.endsWith('/report.pdf/content'))?.contentType).toBe('application/octet-stream');
    expect(requests.filter((request) => request.method === 'POST' && request.path === '/api/records/508524/draft/files').map((request) => request.bodyText)).toEqual([
      '[{"key":"report.pdf"}]',
      '[{"key":"appendix.pdf"}]'
    ]);
  });

  it('treats an already-completed matching draft file as idempotently prepared', async () => {
    const requests: CapturedRequest[] = [];
    const fetch: ZenodoFetchLike = async (url, init) => {
      requests.push({
        method: init.method ?? 'GET',
        path: new URL(url).pathname,
        ...optionalHeader('accept', init.headers),
        ...optionalHeader('content-type', init.headers),
        ...await optionalBodyText(init.body)
      });
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';

      if (method === 'POST' && path === '/api/records/508524/draft') {
        return jsonResponse(201, {
          id: '508524',
          parent: { id: '508523' },
          links: {
            file_modification: 'https://sandbox.zenodo.org/api/records/508524/file-modification'
          }
        });
      }
      if (method === 'POST' && path === '/api/records/508524/file-modification') {
        return jsonResponse(200, { status: 'accepted' });
      }
      if (method === 'GET' && path === '/api/records/508524/draft/files') {
        return jsonResponse(200, {
          entries: [
            completedDraftFile('report.pdf', { checksum: 'md5:5289df737df57326fcdd22597afb1fac', size: 3 })
          ]
        });
      }
      if (method === 'POST' && path === '/api/records/508524/draft/actions/publish') {
        return jsonResponse(202, {
          id: '508524',
          parent: { id: '508523' },
          pids: {
            doi: {
              identifier: '10.53832/doi-sync-file-edit-probe',
              provider: 'external'
            }
          },
          links: {
            self_html: 'https://sandbox.zenodo.org/records/508524'
          },
          versions: {
            index: 1
          }
        });
      }

      return jsonResponse(500, { message: `Unhandled ${method} ${path}` });
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    const draft = await client.prepareUpdateRecordFiles({
      token: 'zenodo-token',
      latestRecordId: '508524',
      doiPolicy: 'external-crossref',
      metadata: {
        doi: '10.53832/doi-sync-file-edit-probe',
        itemType: 'Report',
        title: 'Probe report',
        publicationDate: '2026-06-04',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF1',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }]
    });
    await client.publishDraft({
      token: 'zenodo-token',
      draft
    });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/records/508524/draft',
      'POST /api/records/508524/file-modification',
      'GET /api/records/508524/draft/files',
      'POST /api/records/508524/draft/actions/publish'
    ]);
  });
});

function completedDraftFile(key: string, options: { readonly checksum?: string; readonly size?: number } = {}): unknown {
  return draftFile(key, 'completed', options);
}

function pendingDraftFile(key: string): unknown {
  return draftFile(key, 'pending', {});
}

function draftFile(key: string, status: 'completed' | 'pending', options: { readonly checksum?: string; readonly size?: number }): unknown {
  return {
    key,
    status,
    ...(status === 'completed' ? { file_id: `file-${key}` } : {}),
    ...(options.checksum ? { checksum: options.checksum } : {}),
    ...(options.size === undefined ? {} : { size: options.size }),
    links: {
      self: `https://sandbox.zenodo.org/api/records/508524/draft/files/${encodeURIComponent(key)}`,
      content: `https://sandbox.zenodo.org/api/records/508524/draft/files/${encodeURIComponent(key)}/content`,
      commit: `https://sandbox.zenodo.org/api/records/508524/draft/files/${encodeURIComponent(key)}/commit`
    }
  };
}

function parseRequestedFileKeys(body: RequestInit['body'] | undefined): readonly string[] {
  if (typeof body !== 'string') throw new Error('Expected draft file create body');
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Expected draft file create array');
  return parsed.map((entry) => {
    const object = entry as Partial<Record<'key', unknown>>;
    if (typeof entry !== 'object' || entry === null || typeof object.key !== 'string') {
      throw new Error('Expected draft file create key');
    }
    return object.key;
  });
}

function jsonResponse(status: number, body: unknown): ZenodoResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

function emptyResponse(status: number): ZenodoResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(null),
    text: () => Promise.resolve('')
  };
}

function optionalHeader(name: 'accept' | 'content-type', headers: RequestInit['headers']): { readonly accept?: string; readonly contentType?: string } {
  const value = headerValue(headers, name);
  if (!value) return {};
  return name === 'accept' ? { accept: value } : { contentType: value };
}

function headerValue(headers: RequestInit['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name)?.[1];
  }
  const record = headers as Readonly<Record<string, string>>;
  return record[name] ?? record[canonicalHeaderName(name)];
}

function canonicalHeaderName(name: string): string {
  return name.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join('-');
}

async function optionalBodyText(body: RequestInit['body'] | undefined): Promise<{ readonly bodyText?: string }> {
  if (typeof body === 'string') return { bodyText: body };
  if (body instanceof Blob) return { bodyText: await body.text() };
  return {};
}
