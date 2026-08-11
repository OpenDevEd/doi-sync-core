import { describe, expect, it } from 'vitest';
import { CrossrefApiClient, type CrossrefFetchLike, type CrossrefResponseLike } from '../crossref/client.js';
import type { CrossrefMappedRecord } from '../crossref/record-mapper.js';
import type { CrossrefDepositMetadata } from '../publication/record.js';
import { ResilientProviderOperationRunner } from '../resilience/provider-runner.js';

function textResponse(body: string, status = 200): CrossrefResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body)
  };
}

function publicationInput<const T extends { readonly metadata: CrossrefDepositMetadata; readonly resourceUrl: string }>(
  input: T
): Omit<T, 'metadata' | 'resourceUrl'> & { readonly record: CrossrefMappedRecord } {
  const { metadata, resourceUrl, ...rest } = input;
  return {
    ...rest,
    record: {
      kind: 'report',
      metadata,
      landingUrl: resourceUrl,
      publisher: metadata.publisher ?? 'Open Development & Education',
      isbns: [],
      institution: metadata.institution ?? metadata.publisher ?? 'Open Development & Education'
    }
  };
}

describe('CrossrefApiClient', () => {
  it('submits Crossref XML with documented multipart fields and polls submissionDownload by filename', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('/servlet/deposit')) {
        return Promise.resolve(textResponse('queued'));
      }

      return Promise.resolve(textResponse(`
        <doi_batch_diagnostic status="completed">
          <batch_data>
            <record_count>1</record_count>
            <success_count>1</success_count>
            <failure_count>0</failure_count>
          </batch_data>
        </doi_batch_diagnostic>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

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
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      relation: {
        type: 'isSupplementedBy',
        identifierType: 'doi',
        identifier: '10.5281/zenodo.15043088',
        description: 'Archived file package'
      }
    }))).resolves.toMatchObject({
      status: 'pending',
      filename: 'doi-sync-batch-1.xml'
    });

    expect(calls[0]?.url).toBe('https://test.crossref.org/servlet/deposit');
    const depositBody = calls[0]?.init.body;
    expect(depositBody).toBeInstanceOf(FormData);
    const form = depositBody as FormData;
    expect(form.get('operation')).toBe('doMDUpload');
    expect(form.get('login_id')).toBe('depositor@example.org/odel');
    expect(form.get('login_passwd')).toBe('secret');
    expect(form.get('fname')).toBeInstanceOf(File);
    const file = form.get('fname');
    if (!(file instanceof File)) throw new Error('expected Crossref XML upload file');
    await expect(file.text()).resolves.toContain('<rel:inter_work_relation relationship-type="isSupplementedBy" identifier-type="doi">10.5281/zenodo.15043088</rel:inter_work_relation>');

    expect(calls[1]?.url).toBe('https://test.crossref.org/servlet/submissionDownload');
    expect(calls[1]?.init.method).toBe('POST');
    const pollBody = calls[1]?.init.body;
    expect(pollBody).toBeInstanceOf(FormData);
    const pollForm = pollBody as FormData;
    expect(pollForm.get('usr')).toBe('depositor@example.org/odel');
    expect(pollForm.get('pwd')).toBe('secret');
    expect(pollForm.get('file_name')).toBe('doi-sync-batch-1.xml');
    expect(pollForm.get('type')).toBe('result');
  });

  it('calls the submission journal hook after upload acceptance and before polling submissionDownload', async () => {
    const events: string[] = [];
    const fetch: CrossrefFetchLike = (url) => {
      if (url.includes('/servlet/deposit')) {
        events.push('upload');
        return Promise.resolve(textResponse('queued'));
      }

      events.push('poll');
      return Promise.resolve(textResponse(`
        <doi_batch_diagnostic status="completed">
          <batch_data>
            <record_count>1</record_count>
            <success_count>1</success_count>
            <failure_count>0</failure_count>
          </batch_data>
        </doi_batch_diagnostic>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await client.submitPublication(publicationInput({
      environment: 'test',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      onSubmitted: () => {
        events.push('journal');
        return Promise.resolve();
      }
    }));

    expect(events).toEqual(['upload', 'journal', 'poll']);
  });

  it('reads current Crossref REST work metadata by DOI without deposit credentials', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(textResponse(JSON.stringify({
        status: 'ok',
        message: {
          DOI: '10.53832/opendeved.1205',
          title: ['Evidence report'],
          URL: 'https://docs.opendeved.net/lib/ABC12345'
        }
      })));
    };
    const client = new CrossrefApiClient({ fetch });

    await expect(client.readWork({
      doi: '10.53832/opendeved.1205',
      emailAddress: 'depositor@example.org'
    })).resolves.toMatchObject({
      doi: '10.53832/opendeved.1205',
      title: ['Evidence report'],
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      raw: {
        DOI: '10.53832/opendeved.1205'
      }
    });

    expect(calls).toEqual([{
      url: 'https://api.crossref.org/works/10.53832%2Fopendeved.1205?mailto=depositor%40example.org',
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      }
    }]);
  });

  it('reads the deposited Crossref resource URL from resource.primary.URL instead of the DOI resolver URL', async () => {
    const fetch: CrossrefFetchLike = () => Promise.resolve(textResponse(JSON.stringify({
      status: 'ok',
      message: {
        DOI: '10.53832/edtechhub.1152',
        title: ['How Is AI Transforming Teachers Roles?'],
        URL: 'https://doi.org/10.53832/edtechhub.1152',
        resource: {
          primary: {
            URL: 'https://docs.edtechhub.org/lib/95DU3BRT'
          }
        }
      }
    })));
    const client = new CrossrefApiClient({ fetch });

    await expect(client.readWork({
      doi: '10.53832/edtechhub.1152'
    })).resolves.toMatchObject({
      resourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT'
    });
  });

  it('returns null for missing Crossref REST works', async () => {
    const client = new CrossrefApiClient({
      fetch: () => Promise.resolve(textResponse('not found', 404))
    });

    await expect(client.readWork({ doi: '10.53832/opendeved.missing' })).resolves.toBeNull();
  });

  it('does not re-upload an accepted deposit when submission polling has a retryable failure', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    let submissionDownloadAttempts = 0;
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        submissionDownloadAttempts += 1;
        if (submissionDownloadAttempts === 1) return Promise.resolve(textResponse('temporary unavailable', 503));
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }
      throw new Error(`unexpected Crossref request ${url}`);
    };
    const operationRunner = new ResilientProviderOperationRunner({
      limiters: new Map(),
      retry: {
        retries: 1,
        minTimeoutMs: 0,
        maxTimeoutMs: 0,
        randomize: false
      }
    });
    const client = new CrossrefApiClient({
      fetch,
      operationRunner,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

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
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'pending',
      filename: 'doi-sync-batch-1.xml'
    });
    await operationRunner.close();

    expect(calls.filter((call) => call.url.includes('/servlet/deposit'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/servlet/submissionDownload'))).toHaveLength(2);
  });

  it('does not retry the Crossref deposit upload when upload acknowledgement fails', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('temporary unavailable', 503));
      throw new Error(`unexpected Crossref request ${url}`);
    };
    const operationRunner = new ResilientProviderOperationRunner({
      limiters: new Map(),
      retry: {
        retries: 1,
        minTimeoutMs: 0,
        maxTimeoutMs: 0,
        randomize: false
      }
    });
    const client = new CrossrefApiClient({
      fetch,
      operationRunner,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

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
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).rejects.toThrow('crossref API request failed with HTTP 503');
    await operationRunner.close();

    expect(calls.filter((call) => call.url.includes('/servlet/deposit'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/servlet/submissionDownload'))).toHaveLength(0);
  });

  it('does not re-upload an accepted deposit when the submission journal hook fails', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }
      throw new Error(`unexpected Crossref request ${url}`);
    };
    const operationRunner = new ResilientProviderOperationRunner({
      limiters: new Map(),
      retry: {
        retries: 1,
        minTimeoutMs: 0,
        maxTimeoutMs: 0,
        randomize: false
      }
    });
    const client = new CrossrefApiClient({
      fetch,
      operationRunner,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

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
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      onSubmitted: () => Promise.reject(new Error('journal unavailable'))
    }))).rejects.toThrow('journal unavailable');
    await operationRunner.close();

    expect(calls.filter((call) => call.url.includes('/servlet/deposit'))).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/servlet/submissionDownload'))).toHaveLength(0);
  });

  it('verifies production deposits against Crossref XML API before returning success', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }

      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-05-22 11:18:58">
	            <crossref>
	              <report-paper>
	                <report-paper_metadata>
	                  <contributors>
	                    <person_name contributor_role="author" sequence="first">
	                      <given_name>Ada</given_name>
	                      <surname>Lovelace</surname>
	                      <affiliations><institution><institution_name>OpenDevEd</institution_name></institution></affiliations>
	                      <ORCID>https://orcid.org/0000-0002-1825-0097</ORCID>
	                    </person_name>
	                  </contributors>
	                  <titles><title>Evidence report</title></titles>
	                  <jats:abstract xml:lang="en"><jats:p>Original summary</jats:p></jats:abstract>
	                  <publication_date media_type="online">
	                    <month>05</month>
	                    <day>20</day>
	                    <year>2026</year>
	                  </publication_date>
	                  <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
	                  <institution><institution_name>Open Development &amp; Education</institution_name></institution>
	                  <doi_data>
	                    <doi>10.53832/opendeved.1205</doi>
	                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.submitPublication(publicationInput({
      environment: 'production',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
	      filename: 'doi-sync-batch-1.xml',
	      metadata: {
	        doi: '10.53832/opendeved.1205',
	        itemType: 'Report',
	        title: 'Evidence report',
	        publicationDate: '2026-05-20',
	        abstract: 'Original summary',
	        language: 'en',
	        publisher: 'Open Development & Education',
	        creators: [{
	          type: 'personal',
	          name: 'Lovelace, Ada',
	          creatorType: 'author',
	          givenName: 'Ada',
	          familyName: 'Lovelace',
	          affiliation: 'OpenDevEd',
	          orcid: '0000-0002-1825-0097'
	        }],
	        tags: []
	      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'succeeded',
      xmlVerification: {
        status: 'matched',
        record: {
          doi: '10.53832/opendeved.1205',
          publicationDate: '2026-05-20'
        }
      }
    });

    expect(calls[2]?.url).toBe('https://doi.crossref.org/openurl?pid=depositor%40example.org&id=doi%3A10.53832%2Fopendeved.1205&noredirect=true&format=unixref');
    expect(calls[2]?.init.method).toBe('GET');
  });

  it('verifies pending test deposits against the Crossref test XML API', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const fetch: CrossrefFetchLike = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-05-22 11:18:58">
            <crossref>
              <report-paper>
                <report-paper_metadata>
                  <titles><title>Evidence report</title></titles>
                  <publication_date media_type="online">
                    <month>05</month>
                    <day>20</day>
                    <year>2026</year>
                  </publication_date>
                  <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
                  <institution><institution_name>Open Development &amp; Education</institution_name></institution>
                  <doi_data>
                    <doi>10.53832/opendeved.1205</doi>
                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.verifyPublication(publicationInput({
      environment: 'test',
      emailAddress: 'depositor@example.org',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'matched'
    });

    expect(calls).toEqual([{
      url: 'https://test.crossref.org/openurl?pid=depositor%40example.org&id=doi%3A10.53832%2Fopendeved.1205&noredirect=true&format=unixref',
      init: { method: 'GET' }
    }]);
  });

  it('keeps production deposits pending when Crossref XML API has not caught up', async () => {
    const fetch: CrossrefFetchLike = (url) => {
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }

      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-04-28 12:37:40">
            <crossref>
              <report-paper>
                <report-paper_metadata>
                  <titles><title>Evidence report</title></titles>
                  <publication_date media_type="online">
                    <month>05</month>
                    <day>20</day>
                    <year>2025</year>
                  </publication_date>
                  <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
                  <institution><institution_name>Open Development &amp; Education</institution_name></institution>
                  <doi_data>
                    <doi>10.53832/opendeved.1205</doi>
                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.submitPublication(publicationInput({
      environment: 'production',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'pending',
      xmlVerification: {
        status: 'pending',
        reason: 'Crossref XML API metadata has not caught up: publicationDate=2025-05-20'
      }
    });
  });

  it('keeps production deposits pending when Crossref XML API still has a stale abstract', async () => {
    const fetch: CrossrefFetchLike = (url) => {
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }

      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-04-28 12:37:40">
            <crossref>
              <report-paper>
                <report-paper_metadata>
                  <titles><title>Evidence report</title></titles>
                  <abstract lang="en"><p>Original abstract.</p></abstract>
                  <publication_date media_type="online">
                    <month>05</month>
                    <day>20</day>
                    <year>2026</year>
                  </publication_date>
                  <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
                  <institution><institution_name>Open Development &amp; Education</institution_name></institution>
                  <doi_data>
                    <doi>10.53832/opendeved.1205</doi>
                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.submitPublication(publicationInput({
      environment: 'production',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        abstract: 'Updated abstract.',
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'pending',
      xmlVerification: {
        status: 'pending',
        reason: 'Crossref XML API metadata has not caught up: abstract, abstractLanguage, language'
      }
    });
  });

  it('does not accept stale abstract or creators after local metadata clears them', async () => {
    const fetch: CrossrefFetchLike = () => Promise.resolve(textResponse(`
      <doi_records>
        <doi_record>
          <crossref>
            <report-paper>
              <report-paper_metadata>
                <contributors>
                  <person_name contributor_role="author" sequence="first">
                    <given_name>Ada</given_name><surname>Lovelace</surname>
                  </person_name>
                </contributors>
                <titles><title>Evidence report</title></titles>
                <jats:abstract xml:lang="en"><jats:p>Stale abstract.</jats:p></jats:abstract>
                <publication_date media_type="online"><month>05</month><day>20</day><year>2026</year></publication_date>
                <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
                <institution><institution_name>Open Development &amp; Education</institution_name></institution>
                <doi_data>
                  <doi>10.53832/opendeved.1205</doi>
                  <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                </doi_data>
              </report-paper_metadata>
            </report-paper>
          </crossref>
        </doi_record>
      </doi_records>
    `));
    const client = new CrossrefApiClient({ fetch, poll: { maxAttempts: 1, delayMs: 0 } });

    await expect(client.verifyPublication(publicationInput({
      environment: 'test',
      emailAddress: 'depositor@example.org',
      metadata: {
        doi: '10.53832/opendeved.1205', itemType: 'Report', title: 'Evidence report',
        publicationDate: '2026-05-20', publisher: 'Open Development & Education', creators: [], tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'pending',
      reason: 'Crossref XML API metadata has not caught up: abstract, abstractLanguage, language, creators'
    });
  });

  it('keeps production deposits pending when Crossref XML API still has stale deposited contributors or publisher', async () => {
    const fetch: CrossrefFetchLike = (url) => {
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }

      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-04-28 12:37:40">
            <crossref>
              <report-paper>
                <report-paper_metadata>
                  <contributors>
                    <person_name contributor_role="author" sequence="first">
                      <given_name>Grace</given_name>
                      <surname>Hopper</surname>
                    </person_name>
                  </contributors>
                  <titles><title>Evidence report</title></titles>
                  <jats:abstract xml:lang="fr"><jats:p>Updated abstract.</jats:p></jats:abstract>
                  <publication_date media_type="online">
                    <month>05</month>
                    <day>20</day>
                    <year>2026</year>
                  </publication_date>
                  <publisher><publisher_name>Stale Publisher</publisher_name></publisher>
                  <institution><institution_name>Stale Publisher</institution_name></institution>
                  <doi_data>
                    <doi>10.53832/opendeved.1205</doi>
                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.submitPublication(publicationInput({
      environment: 'production',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Updated abstract.',
        language: 'fr',
        publisher: 'Open Development & Education',
        creators: [
          {
            type: 'personal',
            name: 'Lovelace, Ada',
            creatorType: 'author',
            givenName: 'Ada',
            familyName: 'Lovelace'
          },
          {
            type: 'organizational',
            name: 'Open Development & Education',
            creatorType: 'author'
          }
        ],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    }))).resolves.toMatchObject({
      status: 'pending',
      xmlVerification: {
        status: 'pending',
          reason: 'Crossref XML API metadata has not caught up: publisher, institution, creators'
      }
    });
  });

  it('verifies submitted relations against Crossref XML metadata without waiting for REST indexing', async () => {
    const calls: string[] = [];
    const fetch: CrossrefFetchLike = (url) => {
      calls.push(url);
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }
      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-05-22 11:18:58">
            <crossref>
              <report-paper>
                <report-paper_metadata>
                  <titles><title>Evidence report</title></titles>
                  <publication_date media_type="online">
                    <month>05</month>
                    <day>20</day>
                    <year>2026</year>
                  </publication_date>
                  <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
                  <institution><institution_name>Open Development &amp; Education</institution_name></institution>
                  <program>
                    <related_item>
                      <description>Archived file package</description>
                      <inter_work_relation relationship-type="isSupplementedBy" identifier-type="doi">10.5281/zenodo.20342806</inter_work_relation>
                    </related_item>
                  </program>
                  <doi_data>
                    <doi>10.53832/opendeved.1205</doi>
                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.submitPublication(publicationInput({
      environment: 'production',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      relation: {
        type: 'isSupplementedBy',
        identifierType: 'doi',
        identifier: '10.5281/zenodo.20342806',
        description: 'Archived file package'
      }
    }))).resolves.toMatchObject({
      status: 'succeeded',
      xmlVerification: {
        status: 'matched'
      }
    });
    expect(calls.some((url) => url.includes('api.crossref.org/works/'))).toBe(false);
  });

  it('keeps production deposits pending when a submitted relation is not visible in Crossref XML metadata', async () => {
    const fetch: CrossrefFetchLike = (url) => {
      if (url.includes('/servlet/deposit')) return Promise.resolve(textResponse('queued'));
      if (url.includes('/servlet/submissionDownload')) {
        return Promise.resolve(textResponse(`
          <doi_batch_diagnostic status="completed">
            <batch_data>
              <record_count>1</record_count>
              <success_count>1</success_count>
              <failure_count>0</failure_count>
            </batch_data>
          </doi_batch_diagnostic>
        `));
      }
      return Promise.resolve(textResponse(`
        <doi_records>
          <doi_record owner="10.53832" timestamp="2026-05-22 11:18:58">
            <crossref>
              <report-paper>
                <report-paper_metadata>
                  <titles><title>Evidence report</title></titles>
                  <publication_date media_type="online">
                    <month>05</month>
                    <day>20</day>
                    <year>2026</year>
                  </publication_date>
                  <publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>
                  <institution><institution_name>Open Development &amp; Education</institution_name></institution>
                  <doi_data>
                    <doi>10.53832/opendeved.1205</doi>
                    <resource>https://my.educationevidence.io/lib/record/ABC12345</resource>
                  </doi_data>
                </report-paper_metadata>
              </report-paper>
            </crossref>
          </doi_record>
        </doi_records>
      `));
    };
    const client = new CrossrefApiClient({
      fetch,
      poll: { maxAttempts: 1, delayMs: 0 }
    });

    await expect(client.submitPublication(publicationInput({
      environment: 'production',
      loginId: 'depositor@example.org:odel',
      password: 'secret',
      depositorName: 'OpenDevEd',
      emailAddress: 'depositor@example.org',
      registrant: 'Open Development & Education',
      batchId: 'batch-1',
      timestamp: '20260521000100000',
      filename: 'doi-sync-batch-1.xml',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'Report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        publisher: "Open Development & Education",
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      relation: {
        type: 'isSupplementedBy',
        identifierType: 'doi',
        identifier: '10.5281/zenodo.20342806',
        description: 'Archived file package'
      }
    }))).resolves.toMatchObject({
      status: 'pending',
      xmlVerification: {
        status: 'pending',
        reason: 'Crossref XML API metadata has not caught up: relation=missing'
      }
    });
  });
});
