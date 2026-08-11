import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { CrossrefApiClient } from '../../crossref/client.js';
import type { CrossrefMappedRecord } from '../../crossref/record-mapper.js';
import { ZenodoApiClient } from '../../zenodo/client.js';
import { ZENODO_INVENIORDM_ACCEPT } from '../../zenodo/records.js';
import type { CrossrefDepositMetadata } from '../../publication/record.js';

const server = setupServer();

function publicationInput<const T extends { readonly metadata: CrossrefDepositMetadata; readonly resourceUrl: string }>(
  input: T
): Omit<T, 'metadata' | 'resourceUrl'> & { readonly record: CrossrefMappedRecord } {
  const { metadata, resourceUrl, ...rest } = input;
  return {
    ...rest,
    record: {
      kind: 'report', metadata, landingUrl: resourceUrl,
      publisher: metadata.publisher ?? 'Open Development & Education',
      isbns: [],
      institution: metadata.institution ?? metadata.publisher ?? 'Open Development & Education'
    }
  };
}

const metadata: CrossrefDepositMetadata = {
  doi: '10.53832/opendeved.1205',
  itemType: 'Report',
  title: 'Evidence report',
  publicationDate: '2026-05-20',
  abstract: 'Original summary',
  publisher: 'Open Development & Education',
  creators: [{ type: 'personal', name: 'Lovelace, Ada', givenName: 'Ada', familyName: 'Lovelace' }],
  tags: ['evidence']
};

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe('HTTP-level provider clients with MSW', () => {
  it('reads Crossref REST work metadata by DOI through fetch', async () => {
    const observed: {
      readonly url: string;
      readonly accept: string | null;
    }[] = [];

    server.use(
      http.get('https://api.crossref.org/works/10.53832%2Fopendeved.1205', ({ request }) => {
        observed.push({
          url: request.url,
          accept: request.headers.get('accept')
        });
        return HttpResponse.json({
          message: {
            DOI: '10.53832/opendeved.1205',
            title: ['Evidence report'],
            URL: 'https://my.educationevidence.io/lib/ABC12345',
            type: 'report',
            relation: {
              'is-supplemented-by': [{
                'id-type': 'doi',
                id: '10.5072/zenodo.502440'
              }]
            }
          }
        });
      })
    );

    const client = new CrossrefApiClient();

    await expect(client.readWork({
      doi: '10.53832/opendeved.1205',
      emailAddress: 'depositor@example.org'
    })).resolves.toMatchObject({
      doi: '10.53832/opendeved.1205',
      title: ['Evidence report'],
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345',
      relations: [{
        type: 'is-supplemented-by',
        idType: 'doi',
        id: '10.5072/zenodo.502440'
      }],
      raw: {
        DOI: '10.53832/opendeved.1205',
        URL: 'https://my.educationevidence.io/lib/ABC12345'
      }
    });
    expect(observed).toEqual([{
      url: 'https://api.crossref.org/works/10.53832%2Fopendeved.1205?mailto=depositor%40example.org',
      accept: 'application/json'
    }]);
  });

  it('submits Crossref multipart fields and polls submissionDownload through fetch', async () => {
    const observed: {
      deposit?: {
        readonly operation: string | null;
        readonly loginId: string | null;
        readonly password: string | null;
        readonly filename: string;
        readonly xml: string;
      };
      submissionDownload?: {
        readonly url: string;
        readonly usr: string | null;
        readonly pwd: string | null;
        readonly fileName: string | null;
        readonly type: string | null;
      };
    } = {};

    server.use(
      http.post('https://test.crossref.org/servlet/deposit', async ({ request }) => {
        const form = await request.formData();
        const file = form.get('fname');
        if (!(file instanceof File)) throw new Error('Expected Crossref fname to be a File');

        observed.deposit = {
          operation: valueToString(form.get('operation')),
          loginId: valueToString(form.get('login_id')),
          password: valueToString(form.get('login_passwd')),
          filename: file.name,
          xml: await file.text()
        };

        return HttpResponse.text('queued');
      }),
      http.post('https://test.crossref.org/servlet/submissionDownload', async ({ request }) => {
        const form = await request.formData();
        observed.submissionDownload = {
          url: request.url,
          usr: valueToString(form.get('usr')),
          pwd: valueToString(form.get('pwd')),
          fileName: valueToString(form.get('file_name')),
          type: valueToString(form.get('type'))
        };
        return HttpResponse.text(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `);
      })
    );

    const client = new CrossrefApiClient({ poll: { maxAttempts: 1, delayMs: 0 } });

    await expect(client.submitPublication(publicationInput({
      environment: 'test',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata,
      resourceUrl: 'https://my.educationevidence.io/lib/ABC12345'
    }))).resolves.toMatchObject({
      status: 'pending',
      filename: 'doi-sync-batch-1.xml'
    });

    expect(observed.deposit?.operation).toBe('doMDUpload');
    expect(observed.deposit?.loginId).toBe('depositor@example.org/odel');
    expect(observed.deposit?.password).toBe('secret');
    expect(observed.deposit?.filename).toBe('doi-sync-batch-1.xml');
    expect(observed.deposit?.xml).toContain('<doi>10.53832/opendeved.1205</doi>');
    expect(observed.submissionDownload).toEqual({
      url: 'https://test.crossref.org/servlet/submissionDownload',
      usr: 'depositor@example.org/odel',
      pwd: 'secret',
      fileName: 'doi-sync-batch-1.xml',
      type: 'result'
    });
  });

  it('creates and publishes a Zenodo sandbox deposition, then reads current InvenioRDM identifiers', async () => {
    const calls: string[] = [];
    const metadataBodies: unknown[] = [];

    server.use(
      http.post('https://sandbox.zenodo.org/api/deposit/depositions', ({ request }) => {
        calls.push(`${request.method} ${request.url}`);
        expect(request.headers.get('authorization')).toBe('Bearer zenodo-token');
        return HttpResponse.json({
          id: 502440,
          record_id: 502440,
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
          }
        });
      }),
      http.put('https://sandbox.zenodo.org/api/files/bucket-1/report.pdf', ({ request }) => {
        calls.push(`${request.method} ${request.url}`);
        expect(request.headers.get('authorization')).toBe('Bearer zenodo-token');
        expect(request.headers.get('content-type')).toContain('application/octet-stream');
        return HttpResponse.json({});
      }),
      http.put('https://sandbox.zenodo.org/api/deposit/depositions/502440', async ({ request }) => {
        calls.push(`${request.method} ${request.url}`);
        metadataBodies.push(await request.json());
        return HttpResponse.json({ id: 502440, record_id: 502440 });
      }),
      http.post('https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish', ({ request }) => {
        calls.push(`${request.method} ${request.url}`);
        return HttpResponse.json({ id: 502440, record_id: 502440 });
      }),
      http.get('https://sandbox.zenodo.org/api/records/502440', ({ request }) => {
        calls.push(`${request.method} ${request.url}`);
        expect(request.headers.get('accept')).toBe(ZENODO_INVENIORDM_ACCEPT);
        expect(request.headers.get('authorization')).toBe('Bearer zenodo-token');
        return HttpResponse.json(currentZenodoRecordResponse('502440', '502439'));
      })
    );

    const client = new ZenodoApiClient({ endpoint: 'https://sandbox.zenodo.org' });

    await expect(client.createRecord({
      token: 'zenodo-token',
      doiPolicy: 'dual',
      metadata,
      files: [{
        key: 'PDF12345',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }]
    })).resolves.toMatchObject({
      latestRecordId: '502440',
      parentId: '502439',
      conceptDoi: '10.5072/zenodo.502439',
      versionDoi: '10.5072/zenodo.502440'
    });

    expect(calls).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions',
      'PUT https://sandbox.zenodo.org/api/files/bucket-1/report.pdf',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502440',
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502440'
    ]);
    expect(metadataBodies[0]).toMatchObject({
      metadata: {
        title: 'Evidence report',
        upload_type: 'publication',
        publication_type: 'report'
      }
    });
  });
});

function valueToString(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' ? value : null;
}

function currentZenodoRecordResponse(recordId: string, parentId: string): {
  readonly id: string;
  readonly parent: {
    readonly id: string;
    readonly pids: {
      readonly doi: { readonly identifier: string };
    };
  };
  readonly pids: {
    readonly doi: { readonly identifier: string };
  };
  readonly links: {
    readonly self_html: string;
  };
} {
  return {
    id: recordId,
    parent: {
      id: parentId,
      pids: {
        doi: { identifier: `10.5072/zenodo.${parentId}` }
      }
    },
    pids: {
      doi: { identifier: `10.5072/zenodo.${recordId}` }
    },
    links: {
      self_html: `https://sandbox.zenodo.org/records/${recordId}`
    }
  };
}
