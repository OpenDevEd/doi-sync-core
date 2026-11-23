import { describe, expect, it } from 'vitest';
import { DocidApiClient, type DocidFetchLike, type DocidResponseLike } from '../docid/client.js';
import { buildDocidDeposit, type DocidRecordInput } from '../docid/deposit.js';
import { ProviderHttpError } from '../resilience/errors.js';
import type { ProviderOperationRunner } from '../resilience/provider-runner.js';

// Replies as DOCiD's production API gave them on 2026-11-23, or as its source builds them (Africa-PID-Alliance/DOCiD 962837a).
const LOGIN = { status: true, message: 'Login successful', user_id: 203, user_name: 'openscholar', token: 'jwt-access', refresh_token: 'jwt-refresh' };
const MINTED = { success: true, message: 'PID registry operation completed', id: '20.500.14351/9f2c1e', data: { id: '20.500.14351/9f2c1e' } };
const PUBLISHED = { message: 'Publication created successfully', publication_id: 4321, publication: { id: 4321, document_docid: '20.500.14351/9f2c1e' } };

function reply(body: unknown, status = 200): DocidResponseLike {
  return { ok: status < 400, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

function recording(...replies: DocidResponseLike[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: DocidFetchLike = (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(next);
  };
  return { calls, fetch };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

const record: DocidRecordInput = {
  title: 'Monthly cash transfers to older people in Lusaka',
  abstract: 'We interviewed 42 recipients.',
  doi: '10.53832/openscholar-reports.r100700',
  creators: [
    { name: 'Phiri, Mwila', givenName: 'Mwila', familyName: 'Phiri', orcid: '0000-0002-1825-0097', affiliations: [{ name: 'University of Zambia', ror: '03gh19d69', country: 'ZM' }, { name: 'Zambia Social Policy Institute' }] },
    { name: 'Chanda Mulenga', affiliations: [{ name: 'University of Zambia', ror: '03gh19d69', country: 'ZM' }] }
  ],
  funding: [{ funderName: 'Wellcome Trust', funderRor: '029chgv08' }]
};

describe('buildDocidDeposit', () => {
  it('names every field as DOCiD reads it', () => {
    const pdf = { filename: 'report.pdf', contentType: 'application/pdf', bytes: new Uint8Array([37, 80]) };
    const { fields, files } = buildDocidDeposit(record, { docid: '20.500.14351/9f2c1e', resourceTypeId: 18, publicationTypeId: 5, funderTypeId: 1, file: pdf });
    expect(Object.fromEntries(fields)).toEqual({
      documentDocid: '20.500.14351/9f2c1e',
      documentTitle: record.title,
      documentDescription: record.abstract,
      resourceType: '18',
      doi: record.doi,
      'creators[0][family_name]': 'Phiri',
      'creators[0][given_name]': 'Mwila',
      'creators[0][role]': '8',
      'creators[0][identifier]': 'orcid',
      'creators[0][orcid]': '0000-0002-1825-0097',
      'creators[0][affiliation]': 'University of Zambia',
      // A creator with one name is split on its last word, since DOCiD stops at the first creator without a family name.
      'creators[1][family_name]': 'Mulenga',
      'creators[1][given_name]': 'Chanda',
      'creators[1][role]': '8',
      'creators[1][affiliation]': 'University of Zambia',
      // Each organization once, and each list counted from 0, as DOCiD reads each prefix until a gap.
      'organizationRor[0][name]': 'University of Zambia',
      'organizationRor[0][country]': 'ZM',
      'organizationRor[0][ror_id]': '03gh19d69',
      'organization[0][name]': 'Zambia Social Policy Institute',
      'funders[0][name]': 'Wellcome Trust',
      'funders[0][type]': '1',
      'funders[0][ror_id]': '029chgv08',
      'filesPublications[0][title]': record.title,
      'filesPublications[0][description]': 'Full text',
      'filesPublications[0][publication_type]': '5',
      'filesPublications[0][file_type]': 'application/pdf'
    });
    expect(files).toEqual([['filesPublications_0_file', pdf]]);
  });

  it('sends the title as the description DOCiD requires when there is no abstract', () => {
    const { fields } = buildDocidDeposit({ title: 'A report', creators: [] }, { docid: 'x', resourceTypeId: 1 });
    expect(Object.fromEntries(fields)['documentDescription']).toBe('A report');
  });

  it('refuses funders or a file without the type ids DOCiD requires for them', () => {
    expect(() => buildDocidDeposit(record, { docid: 'x', resourceTypeId: 1 })).toThrow(/funderTypeId/);
    const file = { filename: 'a.pdf', contentType: 'application/pdf', bytes: new Uint8Array() };
    expect(() => buildDocidDeposit({ ...record, funding: [] }, { docid: 'x', resourceTypeId: 1, file })).toThrow(/publicationTypeId/);
  });
});

describe('DocidApiClient', () => {
  it('signs in and renews the token under the names DOCiD gives them', async () => {
    const { calls, fetch } = recording(reply(LOGIN), reply({ access_token: 'jwt-renewed' }));
    const client = new DocidApiClient({ fetch, endpoint: 'https://docid.example/' });
    await expect(client.signIn({ email: 'a@b.c', password: 'p' })).resolves.toEqual({ token: 'jwt-access', refreshToken: 'jwt-refresh' });
    await expect(client.refresh({ refreshToken: 'jwt-refresh' })).resolves.toBe('jwt-renewed');
    expect(calls.map((call) => call.url)).toEqual(['https://docid.example/api/v1/auth/login', 'https://docid.example/api/v1/auth/refresh']);
    expect(header(calls[1]!.init, 'Authorization')).toBe('Bearer jwt-refresh');
  });

  it('mints with an idempotency key and reads the Handle from the reply', async () => {
    const { calls, fetch } = recording(reply(MINTED));
    const docid = await new DocidApiClient({ fetch }).mint({ token: 't', title: 'T', description: 'D', idempotencyKey: 'report-R100700' });
    expect(docid).toBe('20.500.14351/9f2c1e');
    expect(calls[0]!.url).toBe('https://docid.africapidalliance.org/api/v1/cordoi/assign-doi/container-id');
    expect(header(calls[0]!.init, 'Idempotency-Key')).toBe('report-R100700');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ title: 'T', description: 'D' });
  });

  it('deposits as multipart, once, and returns the publication id and DOCiD', async () => {
    const { calls, fetch } = recording(reply(PUBLISHED));
    const ran: string[] = [];
    const runner: ProviderOperationRunner = {
      run: (_provider, operation) => { ran.push('run'); return operation(); },
      runOnce: (_provider, operation) => { ran.push('once'); return operation(); },
      close: () => Promise.resolve()
    };
    const deposit = buildDocidDeposit({ title: 'T', creators: [] }, { docid: '20.500.14351/9f2c1e', resourceTypeId: 18 });
    await expect(new DocidApiClient({ fetch, operationRunner: runner }).deposit({ token: 't', deposit })).resolves.toEqual({ publicationId: 4321, docid: '20.500.14351/9f2c1e' });
    expect(ran).toEqual(['once']);
    const form = calls[0]!.init.body as FormData;
    expect(form.get('documentDocid')).toBe('20.500.14351/9f2c1e');
    expect(form.get('resourceType')).toBe('18');
  });

  it('adds a DOI, withdraws and reinstates at the record routes', async () => {
    const { calls, fetch } = recording(reply({ message: 'ok' }), reply({ message: 'retired' }), reply({ message: 'restored' }));
    const client = new DocidApiClient({ fetch });
    await client.addDoi({ token: 't', publicationId: 4321, doi: '10.53832/x' });
    await client.withdraw({ token: 't', publicationId: 4321, reason: 'Withdrawn by its authors' });
    await client.reinstate({ token: 't', publicationId: 4321 });
    expect(calls.map((call) => `${call.init.method} ${call.url.replace('https://docid.africapidalliance.org/api/v1', '')}`)).toEqual([
      'PUT /publications/update-publication/4321',
      'POST /publications/4321/delete',
      'POST /publications/4321/restore'
    ]);
    expect((calls[0]!.init.body as FormData).get('doi')).toBe('10.53832/x');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ reason: 'Withdrawn by its authors' });
  });

  it('raises what DOCiD said, retryable only when it is busy or down', async () => {
    const { fetch } = recording(reply({ message: 'Resource type not permitted for your account' }, 403), reply({ error_code: 'PID_MINTING_DISABLED' }, 503));
    const client = new DocidApiClient({ fetch });
    const refused = await client.deposit({ token: 't', deposit: { fields: [], files: [] } }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderHttpError);
    expect(refused).toMatchObject({ provider: 'docid', status: 403, retryable: false });
    expect((refused as Error).message).toContain('Resource type not permitted');
    await expect(client.mint({ token: 't', title: 'T', description: 'D', idempotencyKey: 'k1234567' })).rejects.toMatchObject({ status: 503, retryable: true });
  });
});
