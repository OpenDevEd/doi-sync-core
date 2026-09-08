import { describe, expect, it } from 'vitest';
import { ZenodoApiClient, type ZenodoFetchLike, type ZenodoResponseLike } from '../zenodo/client.js';
import { buildZenodoWritePayload, ZENODO_INVENIORDM_ACCEPT } from '../zenodo/records.js';
import type { ProviderName } from '../resilience/errors.js';
import { ResilientProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';

const publishedAtIso = '2026-04-20T09:30:00.000Z';
const publishedAt = new Date(publishedAtIso);

function response(body: unknown): ZenodoResponseLike {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  };
}

interface LegacyDepositionOptions {
  readonly doi?: string;
  readonly reservedDoi?: string;
  readonly conceptrecid?: string;
  readonly submitted?: boolean;
  readonly state?: string;
}

function legacyDeposition(id: string, options: LegacyDepositionOptions = {}): Readonly<Record<string, unknown>> {
  return {
    id,
    record_id: id,
    conceptrecid: options.conceptrecid ?? `${Number(id) - 1}`,
    submitted: options.submitted ?? false,
    state: options.state ?? 'unsubmitted',
    metadata: {
      ...(options.doi ? { doi: options.doi } : {}),
      ...(options.reservedDoi ? { prereserve_doi: { doi: options.reservedDoi } } : {})
    },
    links: {
      self: `https://sandbox.zenodo.org/api/deposit/depositions/${id}`,
      html: `https://sandbox.zenodo.org/deposit/${id}`
    },
    files: []
  };
}

class NonReentrantRunner implements ProviderOperationRunner {
  readonly calls: ProviderName[] = [];
  private runningProvider: ProviderName | null = null;

  async run<T>(provider: ProviderName, operation: () => Promise<T>): Promise<T> {
    if (this.runningProvider) throw new Error(`nested ${provider} operation inside ${this.runningProvider}`);
    this.runningProvider = provider;
    this.calls.push(provider);
    try {
      return await operation();
    } finally {
      this.runningProvider = null;
    }
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function createSuccessfulCreateRecordFetch(): ZenodoFetchLike {
  return (url, init) => {
    if (url.endsWith('/api/deposit/depositions')) {
      return Promise.resolve(response({
        id: 502440,
        record_id: 502440,
        links: {
          bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
        }
      }));
    }

    if (url.endsWith('/api/deposit/depositions/502440')) return Promise.resolve(response({ id: 502440 }));
    if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) return Promise.resolve(response({ record_id: 502440 }));
    if (url.endsWith('/api/records/502440')) {
      return Promise.resolve(response({
        id: '502440',
        created: publishedAtIso,
        parent: {
          id: '502439',
          pids: {
            doi: { identifier: '10.5072/zenodo.502439' }
          }
        },
        pids: {
          doi: { identifier: '10.5072/zenodo.502440' }
        }
      }));
    }

    throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
  };
}

describe('ZenodoApiClient', () => {
  it('does not nest provider-runner calls for create-and-publish convenience methods', async () => {
    const runner = new NonReentrantRunner();
    const fetch = createSuccessfulCreateRecordFetch();
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch,
      operationRunner: runner
    });

    await expect(client.createRecord({
      token: 'sandbox-token',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: []
    })).resolves.toMatchObject({
      latestRecordId: '502440'
    });
    expect(runner.calls).toEqual(['zenodo', 'zenodo', 'zenodo', 'zenodo']);
  });

  it('verifies a Zenodo record using the current InvenioRDM response shape', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response({
        id: '15043088',
        created: publishedAtIso,
        parent: {
          id: '15043087',
          pids: {
            doi: { identifier: '10.5281/zenodo.15043087' }
          }
        },
        pids: {
          doi: { identifier: '10.5281/zenodo.15043088' }
        },
        links: {
          self_html: 'https://zenodo.org/records/15043088'
        }
      }));
    };
    const client = new ZenodoApiClient({ fetch });

    await expect(client.verifyRecord({
      token: 'redacted',
      recordId: '15043088'
    })).resolves.toEqual({
      kind: 'published_record',
      identifiers: {
        latestRecordId: '15043088',
        parentId: '15043087',
        publishedAt,
        conceptDoi: '10.5281/zenodo.15043087',
        versionDoi: '10.5281/zenodo.15043088',
        links: {
          selfHtml: 'https://zenodo.org/records/15043088'
        }
      }
    });
    expect(calls).toEqual([{
      url: 'https://zenodo.org/api/records/15043088',
      init: {
        method: 'GET',
        headers: {
          Accept: ZENODO_INVENIORDM_ACCEPT,
          Authorization: 'Bearer redacted'
        }
      }
    }]);
  });

  it('reads a published InvenioRDM record snapshot with metadata and files for pre-write audits', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response({
        id: '17585570',
        created: publishedAtIso,
        parent: {
          id: '17585569',
          pids: {}
        },
        pids: {
          doi: {
            identifier: '10.53832/edtechhub.1152',
            provider: 'external'
          }
        },
        metadata: {
          title: "How Is AI Transforming Teachers' Roles?",
          publication_date: '2026-04-01',
          description: 'Zenodo description',
          creators: [{
            person_or_org: {
              name: 'Adam, Taskeen'
            }
          }]
        },
        files: {
          count: 1,
          entries: {
            'paper.pdf': {
              key: 'paper.pdf',
              checksum: 'md5:abc123',
              size: 12345,
              mimetype: 'application/pdf'
            }
          }
        }
      }));
    };
    const client = new ZenodoApiClient({ endpoint: 'https://zenodo.org', fetch });

    await expect(client.readRecordSnapshot({
      token: 'zenodo-token',
      recordId: '17585570'
    })).resolves.toEqual({
      identifiers: {
        latestRecordId: '17585570',
        publishedAt,
        parentId: '17585569',
        versionDoi: '10.53832/edtechhub.1152',
        links: {}
      },
      metadata: {
        title: "How Is AI Transforming Teachers' Roles?",
        publication_date: '2026-04-01',
        description: 'Zenodo description',
        creators: [{
          person_or_org: {
            name: 'Adam, Taskeen'
          }
        }]
      },
      files: [{
        key: 'paper.pdf',
        checksum: 'md5:abc123',
        size: 12345,
        contentType: 'application/pdf'
      }]
    });

    expect(calls).toEqual([{
      url: 'https://zenodo.org/api/records/17585570',
      init: {
        method: 'GET',
        headers: {
          Accept: ZENODO_INVENIORDM_ACCEPT,
          Authorization: 'Bearer zenodo-token'
        }
      }
    }]);
  });

  it('finds a published Zenodo record by exact DOI search', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response({
        hits: {
          hits: [{
            id: '505547',
            created: publishedAtIso,
            parent: { id: '505546' },
            pids: { doi: { identifier: '10.53832/opendeved.1205' } },
            links: {
              self_html: 'https://sandbox.zenodo.org/records/505547'
            }
          }]
        }
      }));
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.findRecordByDoi({
      token: 'sandbox-token',
      doi: '10.53832/opendeved.1205'
    })).resolves.toEqual({
      status: 'found',
      record: {
        kind: 'published_record',
        identifiers: {
          latestRecordId: '505547',
          parentId: '505546',
          publishedAt,
          versionDoi: '10.53832/opendeved.1205',
          links: {
            selfHtml: 'https://sandbox.zenodo.org/records/505547'
          }
        }
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('https://sandbox.zenodo.org/api/records?');
    expect(calls[0]?.url).toContain('q=doi%3A%2210.53832%2Fopendeved.1205%22');
    expect(calls[0]?.url).toContain('all_versions=true');
    expect(calls[0]?.url).toContain('size=2');
    expect(calls[0]?.init).toEqual({
      method: 'GET',
      headers: {
        Accept: ZENODO_INVENIORDM_ACCEPT,
        Authorization: 'Bearer sandbox-token'
      }
    });
  });

  it('finds an unsubmitted Zenodo draft by exact DOI across paginated deposition lists', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('page=1')) {
        return Promise.resolve(response([
          ...Array.from({ length: 99 }, (_, index) => legacyDeposition(`${500000 + index}`, {
            doi: `10.53832/other.${index}`
          })),
          legacyDeposition('500999', {
            doi: '10.53832/opendeved.1205',
            submitted: true,
            state: 'done'
          })
        ]));
      }
      if (url.includes('page=2')) {
        return Promise.resolve(response([
          legacyDeposition('501001', {
            doi: ' 10.53832/OpenDevEd.1205 ',
            conceptrecid: '501000'
          })
        ]));
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.findDraftByDoi({
      token: 'sandbox-token',
      doi: '10.53832/opendeved.1205'
    })).resolves.toEqual({
      status: 'found',
      deposition: {
        kind: 'legacy_unsubmitted_deposition',
        deposition: {
          depositionId: '501001',
          recordId: '501001',
          conceptRecordId: '501000',
          submitted: false,
          state: 'unsubmitted',
          doi: ' 10.53832/OpenDevEd.1205 ',
          fileCount: 0,
          links: {
            self: 'https://sandbox.zenodo.org/api/deposit/depositions/501001',
            html: 'https://sandbox.zenodo.org/deposit/501001'
          }
        }
      }
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://sandbox.zenodo.org/api/deposit/depositions?page=1&size=100',
      'https://sandbox.zenodo.org/api/deposit/depositions?page=2&size=100'
    ]);
    expect(calls[0]?.init).toEqual({
      method: 'GET',
      headers: {
        Authorization: 'Bearer sandbox-token'
      }
    });
  });

  it('finds an unsubmitted Zenodo draft by exact reserved DOI', async () => {
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch: () => Promise.resolve(response([
        legacyDeposition('501002', {
          reservedDoi: '10.5072/zenodo.501002'
        })
      ]))
    });

    await expect(client.findDraftByDoi({
      token: 'sandbox-token',
      doi: '10.5072/zenodo.501002'
    })).resolves.toMatchObject({
      status: 'found',
      deposition: {
        deposition: {
          depositionId: '501002',
          reservedDoi: '10.5072/zenodo.501002'
        }
      }
    });
  });

  it('does not recover a dual-DOI draft from a Crossref DOI when the draft only has a Zenodo reserved DOI', async () => {
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch: () => Promise.resolve(response([
        legacyDeposition('501005', {
          reservedDoi: '10.5072/zenodo.501005'
        })
      ]))
    });

    await expect(client.findDraftByDoi({
      token: 'sandbox-token',
      doi: '10.53832/opendeved.1205'
    })).resolves.toEqual({ status: 'not_found' });
  });

  it('reports ambiguous unsubmitted Zenodo drafts for duplicate exact DOI matches', async () => {
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch: () => Promise.resolve(response([
        legacyDeposition('501003', { doi: '10.53832/opendeved.1205' }),
        legacyDeposition('501004', { doi: '10.53832/opendeved.1205' })
      ]))
    });

    await expect(client.findDraftByDoi({
      token: 'sandbox-token',
      doi: '10.53832/opendeved.1205'
    })).resolves.toEqual({
      status: 'ambiguous',
      depositionIds: ['501003', '501004']
    });
  });

  it('returns null for missing Zenodo records', async () => {
    const client = new ZenodoApiClient({
      fetch: () => Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve('not found')
      })
    });

    await expect(client.verifyRecord({
      token: 'redacted',
      recordId: 'missing'
    })).resolves.toBeNull();
  });

  it('can verify records against the Zenodo sandbox endpoint', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(response({
        id: '123',
        created: publishedAtIso,
        parent: {
          id: '122',
          pids: {
            doi: { identifier: '10.5072/zenodo.122' }
          }
        },
        pids: {
          doi: { identifier: '10.5072/zenodo.123' }
        },
        links: {
          self_html: 'https://sandbox.zenodo.org/records/123'
        }
      }));
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.verifyRecord({
      token: 'sandbox-token',
      recordId: '123'
    })).resolves.toMatchObject({
      kind: 'published_record'
    });
    expect(calls[0]?.url).toBe('https://sandbox.zenodo.org/api/records/123');
  });

  it('falls back to legacy depositions when the public record endpoint has no record', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('/api/records/')) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('not found')
        });
      }

      return Promise.resolve(response({
        id: 17585551,
        record_id: 17585551,
        conceptrecid: '17585550',
        submitted: false,
        state: 'unsubmitted',
        metadata: {
          doi: '10.53832/edtechhub.1151',
          prereserve_doi: {
            doi: '10.5281/zenodo.17585551',
            recid: 17585551
          }
        },
        links: {
          self: 'https://zenodo.org/api/deposit/depositions/17585551',
          html: 'https://zenodo.org/deposit/17585551',
          bucket: 'https://zenodo.org/api/files/bucket-id'
        },
        files: []
      }));
    };
    const client = new ZenodoApiClient({ fetch });

    await expect(client.verifyRecord({
      token: 'redacted',
      recordId: '17585551'
    })).resolves.toEqual({
      kind: 'legacy_unsubmitted_deposition',
      deposition: {
        depositionId: '17585551',
        recordId: '17585551',
        conceptRecordId: '17585550',
        submitted: false,
        state: 'unsubmitted',
        doi: '10.53832/edtechhub.1151',
        reservedDoi: '10.5281/zenodo.17585551',
        fileCount: 0,
        links: {
          self: 'https://zenodo.org/api/deposit/depositions/17585551',
          html: 'https://zenodo.org/deposit/17585551',
          bucket: 'https://zenodo.org/api/files/bucket-id'
        }
      }
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://zenodo.org/api/records/17585551',
      'https://zenodo.org/api/deposit/depositions/17585551'
    ]);
  });

  it('creates, uploads files through the bucket API, publishes, and reads current identifiers with the InvenioRDM Accept header', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            id: 502440,
            record_id: 502440,
            links: {
              bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
            }
          }),
          text: () => Promise.resolve('{}')
        });
      }

      if (url.includes('/api/files/bucket-1/')) return Promise.resolve(response({ key: 'report.pdf' }));
      if (url.endsWith('/api/deposit/depositions/502440')) return Promise.resolve(response({ id: 502440 }));
      if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) return Promise.resolve(response({ record_id: 502440 }));
      if (url.endsWith('/api/records/502440')) {
        return Promise.resolve(response({
          id: '502440',
          created: publishedAtIso,
          parent: {
            id: '502439',
            pids: {
              doi: { identifier: '10.5072/zenodo.502439' }
            }
          },
          pids: {
            doi: { identifier: '10.5072/zenodo.502440' }
          },
          links: {
            self_html: 'https://sandbox.zenodo.org/records/502440'
          }
        }));
      }

      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.createRecord({
      token: 'sandbox-token',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
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

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions',
      'PUT https://sandbox.zenodo.org/api/files/bucket-1/report.pdf',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502440',
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502440'
    ]);
    expect(calls[4]?.init.headers).toMatchObject({
      Accept: ZENODO_INVENIORDM_ACCEPT,
      Authorization: 'Bearer sandbox-token'
    });
    expect(calls[2]?.init.body).toBe(JSON.stringify(buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      }
    })));
  });

  it('deletes an unpublished Zenodo draft through the legacy deposition API', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('')
        });
      }
    });

    await expect(client.deleteUnpublishedDraft({
      token: 'sandbox-token',
      depositionId: '505638'
    })).resolves.toBeUndefined();

    expect(calls).toEqual([{
      url: 'https://sandbox.zenodo.org/api/deposit/depositions/505638',
      init: {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer sandbox-token'
        }
      }
    }]);
  });

  it.each([
    {
      name: 'new record', operationType: 'zenodo_create' as const,
      draft: { depositionId: '501', draftRecordId: '501' },
      url: 'https://sandbox.zenodo.org/api/deposit/depositions/501', method: 'DELETE'
    },
    {
      name: 'legacy metadata edit', operationType: 'zenodo_metadata_update' as const,
      draft: { depositionId: '502', draftRecordId: '502' },
      url: 'https://sandbox.zenodo.org/api/deposit/depositions/502/actions/discard', method: 'POST'
    },
    {
      name: 'Invenio file edit', operationType: 'zenodo_file_update' as const,
      draft: { depositionId: '503', draftRecordId: 'record-503', api: 'invenio_record' as const },
      url: 'https://sandbox.zenodo.org/api/records/record-503/draft', method: 'DELETE'
    }
  ])('discards an incomplete $name draft through its native API', async ({ operationType, draft, url, method }) => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch: (requestUrl, init) => {
        calls.push({ url: requestUrl, init });
        return Promise.resolve({
          ok: true, status: 204,
          json: () => Promise.resolve({}), text: () => Promise.resolve('')
        });
      }
    });

    await expect(client.discardPreparedDraft({
      token: 'sandbox-token', operationType, draft
    })).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url, init: { method } });
  });

  it('preserves existing legacy deposition metadata when adopting an unsubmitted draft', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440')) {
        if (init.method === 'GET') {
          return Promise.resolve(response({
            id: 502440,
            record_id: 502440,
            metadata: {
              title: 'Old title',
              upload_type: 'publication',
              publication_type: 'technicalnote',
              description: 'Old summary',
              creators: [{ name: 'Old Author' }],
              access_right: 'open',
              doi: '10.53832/opendeved.1205',
              prereserve_doi: { doi: '10.5072/zenodo.502440', recid: 502440 },
              communities: [{ identifier: 'opendeved' }],
              related_identifiers: [{
                identifier: 'zotero://select/groups/123/items/ABC12345',
                relation: 'isAlternateIdentifier',
                resource_type: 'other',
                scheme: 'url'
              }],
              license: 'cc-by-4.0'
            },
            links: {
              bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
            }
          }));
        }

        return Promise.resolve(response({ id: 502440, record_id: 502440 }));
      }

      if (url.endsWith('/api/deposit/depositions/502440/files')) return Promise.resolve(response([]));

      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.prepareAdoptLegacyDeposition({
      token: 'sandbox-token',
      depositionId: '502440',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        abstract: 'Updated summary',
        creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
        tags: []
      },
      files: []
    })).resolves.toMatchObject({
      depositionId: '502440',
      draftRecordId: '502440'
    });

    const put = calls.find((call) => call.init.method === 'PUT' && call.url.endsWith('/api/deposit/depositions/502440'));
    expect(put?.init.body).toBe(JSON.stringify(buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        abstract: 'Updated summary',
        creators: [{ type: 'personal', name: 'Lovelace, Ada' }],
        tags: []
      },
      existingMetadata: {
        title: 'Old title',
        upload_type: 'publication',
        publication_type: 'technicalnote',
        description: 'Old summary',
        creators: [{ name: 'Old Author' }],
        access_right: 'open',
        doi: '10.53832/opendeved.1205',
        prereserve_doi: { doi: '10.5072/zenodo.502440', recid: 502440 },
        communities: [{ identifier: 'opendeved' }],
        related_identifiers: [{
          identifier: 'zotero://select/groups/123/items/ABC12345',
          relation: 'isAlternateIdentifier',
          resource_type: 'other',
          scheme: 'url'
        }],
        license: 'cc-by-4.0'
      }
    })));
  });

  it('keeps existing legacy deposition files when adoption upload fails', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440')) {
        return Promise.resolve(response({
          id: 502440,
          record_id: 502440,
          metadata: {
            title: 'Old title',
            upload_type: 'publication',
            publication_type: 'technicalnote',
            description: 'Old summary',
            creators: [{ name: 'Old Author' }],
            access_right: 'open'
          },
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
          }
        }));
      }
      if (url.endsWith('/api/deposit/depositions/502440/files')) {
        return Promise.resolve(response([{ id: 'old-file-id', filename: 'report-v1.pdf' }]));
      }
      if (url.endsWith('/api/deposit/depositions/502440/files/old-file-id')) {
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      }
      if (url.includes('/api/files/bucket-1/')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: 'temporary file upload outage' }),
          text: () => Promise.resolve('temporary file upload outage')
        });
      }

      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.prepareAdoptLegacyDeposition({
      token: 'sandbox-token',
      depositionId: '502440',
      doiPolicy: 'external-crossref',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF67890',
        filename: 'report-v2.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([4, 5, 6])
      }]
    })).rejects.toThrow('zenodo API request failed with HTTP 503');

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'GET https://sandbox.zenodo.org/api/deposit/depositions/502440',
      'GET https://sandbox.zenodo.org/api/deposit/depositions/502440/files',
      'PUT https://sandbox.zenodo.org/api/files/bucket-1/report-v2.pdf'
    ]);
  });

  it('prepares a draft without publishing so callers can journal the draft before publish', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            id: 502440,
            record_id: 502440,
            links: {
              bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
            }
          }),
          text: () => Promise.resolve('{}')
        });
      }

      if (url.includes('/api/files/bucket-1/')) return Promise.resolve(response({ key: 'report.pdf' }));
      if (url.endsWith('/api/deposit/depositions/502440')) return Promise.resolve(response({ id: 502440, record_id: 502440 }));
      if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) return Promise.resolve(response({ record_id: 502440 }));
      if (url.endsWith('/api/records/502440')) {
        return Promise.resolve(response({
          id: '502440',
          created: publishedAtIso,
          parent: {
            id: '502439',
            pids: {
              doi: { identifier: '10.5072/zenodo.502439' }
            }
          },
          pids: {
            doi: { identifier: '10.5072/zenodo.502440' }
          },
          links: {
            self_html: 'https://sandbox.zenodo.org/records/502440'
          }
        }));
      }

      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    const draft = await client.prepareCreateRecord({
      token: 'sandbox-token',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF12345',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }]
    });

    expect(draft).toMatchObject({
      depositionId: '502440',
      draftRecordId: '502440'
    });
    expect(draft.payloadSnapshot).toEqual(buildZenodoWritePayload({
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      }
    }));
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions',
      'PUT https://sandbox.zenodo.org/api/files/bucket-1/report.pdf',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502440'
    ]);

    await expect(client.publishDraft({
      token: 'sandbox-token',
      draft
    })).resolves.toMatchObject({
      latestRecordId: '502440',
      parentId: '502439',
      conceptDoi: '10.5072/zenodo.502439',
      versionDoi: '10.5072/zenodo.502440'
    });
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions',
      'PUT https://sandbox.zenodo.org/api/files/bucket-1/report.pdf',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502440',
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502440'
    ]);
  });

  it('writes preserved provider metadata but journals only the managed payload projection', async () => {
    let writtenPayload: unknown;
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch: (url, init) => {
        if (url.endsWith('/api/deposit/depositions/502440/actions/edit')) {
          return Promise.resolve(response({
            id: 502440,
            record_id: 502440,
            metadata: {
              custom_provider_field: 'preserve me',
              contributors: [{ name: 'Provider editor', type: 'Editor' }]
            }
          }));
        }
        if (url.endsWith('/api/deposit/depositions/502440') && init.method === 'PUT') {
          if (typeof init.body !== 'string') throw new Error('expected JSON request body');
          writtenPayload = JSON.parse(init.body);
          return Promise.resolve(response({ id: 502440 }));
        }
        throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
      }
    });
    const metadata = {
      itemType: 'Report', title: 'Evidence report', publicationDate: '2026-05-20',
      abstract: 'Evidence summary', institution: 'OpenDevEd',
      creators: [{ type: 'organizational' as const, name: 'OpenDevEd' }], tags: []
    };

    const draft = await client.prepareUpdateRecordMetadata({
      token: 'sandbox-token', latestRecordId: '502440', doiPolicy: 'dual', metadata
    });

    expect(writtenPayload).toMatchObject({ metadata: {
      custom_provider_field: 'preserve me',
      contributors: [
        { name: 'Provider editor', type: 'Editor' },
        { name: 'OpenDevEd', type: 'HostingInstitution' }
      ]
    } });
    expect(draft.payloadSnapshot).toEqual(buildZenodoWritePayload({
      doiPolicy: 'dual', metadata
    }));
    expect(draft.payloadSnapshot).not.toHaveProperty('metadata.custom_provider_field');
  });

  it('reconciles a retryable publish failure by reading the published record before retrying publish', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: 'temporary gateway failure after commit' }),
          text: () => Promise.resolve('temporary gateway failure after commit')
        });
      }
      if (url.endsWith('/api/records/502440')) {
        return Promise.resolve(response({
          id: '502440',
          created: publishedAtIso,
          parent: {
            id: '502439',
            pids: { doi: { identifier: '10.5072/zenodo.502439' } }
          },
          pids: { doi: { identifier: '10.5072/zenodo.502440' } },
          links: {}
        }));
      }
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({ endpoint: 'https://sandbox.zenodo.org', fetch });

    await expect(client.publishDraft({
      token: 'sandbox-token',
      draft: {
        depositionId: '502440',
        draftRecordId: '502440'
      }
    })).resolves.toMatchObject({
      latestRecordId: '502440',
      parentId: '502439',
      versionDoi: '10.5072/zenodo.502440'
    });

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502440'
    ]);
  });

  it('does not re-send publish when publish succeeded but identifier lookup failed', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) return Promise.resolve(response({ record_id: 502440 }));
      if (url.endsWith('/api/records/502440')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: 'identifier read unavailable' }),
          text: () => Promise.resolve('identifier read unavailable')
        });
      }
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({ endpoint: 'https://sandbox.zenodo.org', fetch });

    await expect(client.publishDraft({
      token: 'sandbox-token',
      draft: {
        depositionId: '502440',
        draftRecordId: '502440'
      }
    })).rejects.toThrow('Zenodo publish succeeded for 502440, but published identifier lookup failed');

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502440'
    ]);
  });

  it('reconciles an already-published draft retry by reading the published record', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ message: 'Deposition state does not allow for publishing' }),
          text: () => Promise.resolve('Deposition state does not allow for publishing')
        });
      }
      if (url.endsWith('/api/records/502440')) {
        return Promise.resolve(response({
          id: '502440',
          created: publishedAtIso,
          parent: {
            id: '502439',
            pids: { doi: { identifier: '10.5072/zenodo.502439' } }
          },
          pids: { doi: { identifier: '10.5072/zenodo.502440' } },
          links: {}
        }));
      }
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({ endpoint: 'https://sandbox.zenodo.org', fetch });

    await expect(client.publishDraft({
      token: 'sandbox-token',
      draft: {
        depositionId: '502440',
        draftRecordId: '502440'
      }
    })).resolves.toMatchObject({
      latestRecordId: '502440',
      parentId: '502439',
      versionDoi: '10.5072/zenodo.502440'
    });

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502440'
    ]);
  });

  it('reports a prepared draft before file and metadata writes can fail', async () => {
    const preparedDrafts: unknown[] = [];
    const fetch: ZenodoFetchLike = (url) => {
      if (url.endsWith('/api/deposit/depositions')) {
        return Promise.resolve(response({
          id: 502440,
          record_id: 502440,
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
          }
        }));
      }

      if (url.includes('/api/files/bucket-1/')) return Promise.resolve(response({ key: 'report.pdf' }));
      if (url.endsWith('/api/deposit/depositions/502440')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: 'temporary Zenodo metadata outage' }),
          text: () => Promise.resolve('temporary Zenodo metadata outage')
        });
      }

      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.prepareCreateRecord({
      token: 'sandbox-token',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF12345',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }],
      onPreparedDraft: (draft) => {
        preparedDrafts.push(draft);
        return Promise.resolve();
      }
    })).rejects.toThrow('zenodo API request failed with HTTP 503');

    expect(preparedDrafts).toEqual([{
      depositionId: '502440',
      draftRecordId: '502440'
    }]);
  });

  it('deletes a newly created deposition when the prepared-draft journal write fails', async () => {
    const calls: Array<{ readonly method: string | undefined; readonly url: string }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ method: init.method, url });
      if (url.endsWith('/api/deposit/depositions')) {
        return Promise.resolve(response({
          id: 502440,
          record_id: 502440,
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
          }
        }));
      }

      if (url.endsWith('/api/deposit/depositions/502440')) return Promise.resolve(response({}));
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.prepareCreateRecord({
      token: 'sandbox-token',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF12345',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([1, 2, 3])
      }],
      onPreparedDraft: () => Promise.reject(new Error('journal unavailable'))
    })).rejects.toThrow('journal unavailable');

    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'https://sandbox.zenodo.org/api/deposit/depositions'
      },
      {
        method: 'DELETE',
        url: 'https://sandbox.zenodo.org/api/deposit/depositions/502440'
      }
    ]);
  });

  it('retries failed metadata writes without creating another empty deposition', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    let metadataAttempts = 0;
    const operationRunner = new ResilientProviderOperationRunner({
      retry: {
        retries: 1,
        minTimeoutMs: 1,
        maxTimeoutMs: 1,
        randomize: false
      }
    });
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions')) {
        return Promise.resolve(response({
          id: 502440,
          record_id: 502440,
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
          }
        }));
      }

      if (url.includes('/api/files/bucket-1/')) return Promise.resolve(response({ key: 'report.pdf' }));
      if (url.endsWith('/api/deposit/depositions/502440')) {
        metadataAttempts += 1;
        if (metadataAttempts === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ message: 'temporary Zenodo metadata outage' }),
            text: () => Promise.resolve('temporary Zenodo metadata outage')
          });
        }
        return Promise.resolve(response({ id: 502440 }));
      }

      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch,
      operationRunner
    });

    try {
      await expect(client.prepareCreateRecord({
        token: 'sandbox-token',
        doiPolicy: 'dual',
        metadata: {
          doi: '10.53832/opendeved.1205',
          itemType: 'Report',
          title: 'Evidence report',
          publicationDate: '2026-05-20',
          abstract: 'Evidence summary',
          creators: [{ type: 'organizational', name: 'OpenDevEd' }],
          tags: []
        },
        files: [{
          key: 'PDF12345',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array([1, 2, 3])
        }]
      })).resolves.toMatchObject({
        depositionId: '502440',
        draftRecordId: '502440'
      });
    } finally {
      await operationRunner.close();
    }

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions',
      'PUT https://sandbox.zenodo.org/api/files/bucket-1/report.pdf',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502440',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502440'
    ]);
  });

  it('makes duplicate Zenodo upload filenames deterministic before bucket upload', async () => {
    const uploadedUrls: string[] = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      if (url.endsWith('/api/deposit/depositions')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            id: 502440,
            record_id: 502440,
            links: {
              bucket: 'https://sandbox.zenodo.org/api/files/bucket-1'
            }
          }),
          text: () => Promise.resolve('{}')
        });
      }

      if (url.includes('/api/files/bucket-1/')) {
        uploadedUrls.push(url);
        return Promise.resolve(response({}));
      }

      if (url.endsWith('/api/deposit/depositions/502440')) return Promise.resolve(response({ id: 502440 }));
      if (url.endsWith('/api/deposit/depositions/502440/actions/publish')) return Promise.resolve(response({ record_id: 502440 }));
      if (url.endsWith('/api/records/502440')) {
        return Promise.resolve(response({
          id: '502440',
          created: publishedAtIso,
          parent: { id: '502439', pids: { doi: { identifier: '10.5072/zenodo.502439' } } },
          pids: { doi: { identifier: '10.5072/zenodo.502440' } },
          links: {}
        }));
      }

      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await client.createRecord({
      token: 'sandbox-token',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [
        {
          key: 'PDF12345',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array([1])
        },
        {
          key: 'PDF67890',
          filename: 'report.pdf',
          contentType: 'application/pdf',
          bytes: new Uint8Array([2])
        }
      ]
    });

    expect(uploadedUrls).toEqual([
      'https://sandbox.zenodo.org/api/files/bucket-1/report-PDF12345.pdf',
      'https://sandbox.zenodo.org/api/files/bucket-1/report-PDF67890-2.pdf'
    ]);
  });

  it('creates a new version from the latest record, removes inherited files, uploads current files, and publishes it', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440/actions/newversion')) {
        return Promise.resolve(response({
          links: {
            latest_draft: 'https://sandbox.zenodo.org/api/deposit/depositions/502441'
          }
        }));
      }
      if (url.endsWith('/api/deposit/depositions/502441')) {
        return Promise.resolve(response({
          id: 502441,
          record_id: 502441,
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-2'
          }
        }));
      }
      if (url.endsWith('/api/deposit/depositions/502441/files')) {
        return Promise.resolve(response([{ id: 'old-file-id', filename: 'report-v1.pdf' }]));
      }
      if (url.endsWith('/api/deposit/depositions/502441/files/old-file-id')) {
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      }
      if (url.includes('/api/files/bucket-2/')) return Promise.resolve(response({ key: 'report-v2.pdf' }));
      if (url.endsWith('/api/deposit/depositions/502441/actions/publish')) return Promise.resolve(response({ record_id: 502441 }));
      if (url.endsWith('/api/records/502441')) {
        return Promise.resolve(response({
          id: '502441',
          created: publishedAtIso,
          parent: { id: '502439', pids: { doi: { identifier: '10.5072/zenodo.502439' } } },
          pids: { doi: { identifier: '10.5072/zenodo.502441' } },
          links: {}
        }));
      }

      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.createNewVersion({
      token: 'sandbox-token',
      latestRecordId: '502440',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF67890',
        filename: 'report-v2.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([4, 5, 6])
      }]
    })).resolves.toMatchObject({
      latestRecordId: '502441',
      parentId: '502439',
      versionDoi: '10.5072/zenodo.502441'
    });

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/newversion',
      'GET https://sandbox.zenodo.org/api/deposit/depositions/502441',
      'GET https://sandbox.zenodo.org/api/deposit/depositions/502441/files',
      'PUT https://sandbox.zenodo.org/api/files/bucket-2/report-v2.pdf',
      'DELETE https://sandbox.zenodo.org/api/deposit/depositions/502441/files/old-file-id',
      'PUT https://sandbox.zenodo.org/api/deposit/depositions/502441',
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502441/actions/publish',
      'GET https://sandbox.zenodo.org/api/records/502441'
    ]);
  });

  it('keeps inherited legacy draft files when new-version upload fails', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: ZenodoFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/deposit/depositions/502440/actions/newversion')) {
        return Promise.resolve(response({
          links: {
            latest_draft: 'https://sandbox.zenodo.org/api/deposit/depositions/502441'
          }
        }));
      }
      if (url.endsWith('/api/deposit/depositions/502441')) {
        return Promise.resolve(response({
          id: 502441,
          record_id: 502441,
          links: {
            bucket: 'https://sandbox.zenodo.org/api/files/bucket-2'
          }
        }));
      }
      if (url.endsWith('/api/deposit/depositions/502441/files')) {
        return Promise.resolve(response([{ id: 'old-file-id', filename: 'report-v1.pdf' }]));
      }
      if (url.endsWith('/api/deposit/depositions/502441/files/old-file-id')) {
        return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
      }
      if (url.includes('/api/files/bucket-2/')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ message: 'temporary file upload outage' }),
          text: () => Promise.resolve('temporary file upload outage')
        });
      }

      throw new Error(`unexpected URL ${url}`);
    };
    const client = new ZenodoApiClient({
      endpoint: 'https://sandbox.zenodo.org',
      fetch
    });

    await expect(client.createNewVersion({
      token: 'sandbox-token',
      latestRecordId: '502440',
      doiPolicy: 'dual',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report v2',
        publicationDate: '2026-05-21',
        abstract: 'Evidence summary',
        creators: [{ type: 'organizational', name: 'OpenDevEd' }],
        tags: []
      },
      files: [{
        key: 'PDF67890',
        filename: 'report-v2.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([4, 5, 6])
      }]
    })).rejects.toThrow('zenodo API request failed with HTTP 503');

    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'POST https://sandbox.zenodo.org/api/deposit/depositions/502440/actions/newversion',
      'GET https://sandbox.zenodo.org/api/deposit/depositions/502441',
      'GET https://sandbox.zenodo.org/api/deposit/depositions/502441/files',
      'PUT https://sandbox.zenodo.org/api/files/bucket-2/report-v2.pdf'
    ]);
  });
});

describe('empty Zenodo draft preparation', () => {
  it('creates and journals an unpublished draft without metadata or files', async () => {
    const requests: {url: string; method: string | undefined; body: BodyInit | null | undefined}[] = [];
    const persisted: unknown[] = [];
    const client = new ZenodoApiClient({endpoint: 'https://zenodo.org', fetch: (url, init) => {
      requests.push({url, method: init.method, body: init.body});
      return Promise.resolve(response(legacyDeposition('700001')));
    }});
    const draft = await client.prepareEmptyDraft({token: 'token', onPreparedDraft: value => {persisted.push(value); return Promise.resolve();}});
    expect(draft.depositionId).toBe('700001');
    expect(persisted).toEqual([draft]);
    expect(requests).toEqual([{url: 'https://zenodo.org/api/deposit/depositions', method: 'POST', body: '{}'}]);
  });
});

it.each([false, true])('fills and publishes a saved draft; missing=%s', async (missing) => {
  const calls: string[] = [];
  const id = missing ? '700002' : '700001';
  const client = new ZenodoApiClient({endpoint: 'https://sandbox.zenodo.org', fetch: (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path}`);
    if (missing && path === '/api/deposit/depositions/700001') return Promise.resolve({...response({}), ok: false, status: 404});
    if (path === '/api/deposit/depositions' || path === `/api/deposit/depositions/${id}`) {
      return Promise.resolve(response({...legacyDeposition(id), links: {bucket: 'https://sandbox.zenodo.org/api/files/saved-bucket'}}));
    }
    if (path.endsWith('/files')) return Promise.resolve(response([]));
    if (path.startsWith('/api/files/')) return Promise.resolve(response({key:'report.pdf'}));
    if (path.endsWith('/actions/publish')) return Promise.resolve(response({record_id:id}));
    if (path === `/api/records/${id}`) return Promise.resolve(response({id, created: publishedAtIso, parent:{id:'700000',pids:{doi:{identifier:'10.5072/zenodo.700000'}}},pids:{doi:{identifier:`10.5072/zenodo.${id}`}},links:{self_html:`https://sandbox.zenodo.org/records/${id}`}}));
    throw new Error(`Unexpected request ${init.method} ${path}`);
  }});
  const persisted: string[] = [];
  const draft = await client.prepareCreateRecord({token:'token',draftDepositionId:'700001',doiPolicy:'dual',metadata:{doi:'10.53832/opendeved.1205',itemType:'Report',title:'Approved report',publicationDate:'2026-05-20',abstract:'Approved abstract',creators:[{type:'organizational',name:'OpenDevEd'}],tags:[]},files:[{key:'PDF12345',filename:'report.pdf',contentType:'application/pdf',bytes:new Uint8Array([1,2,3])}],onPreparedDraft: value => {persisted.push(value.depositionId);return Promise.resolve();}});
  expect(persisted).toEqual([id]);
  const published = await client.publishDraft({token:'token',draft});
  expect(published.latestRecordId).toBe(id);
  expect(calls.filter(call => call === 'POST /api/deposit/depositions')).toHaveLength(missing ? 1 : 0);
  expect(calls).toContain('GET /api/deposit/depositions/700001');
  expect(calls).toContain(`PUT /api/deposit/depositions/${id}`);
  expect(calls).toContain(`POST /api/deposit/depositions/${id}/actions/publish`);
});
