import { buildCrossrefDepositRequest, type CrossrefDepositRequest, type CrossrefEnvironment } from './deposit.js';
import {
  parseCrossrefDiagnosticXml,
  parseCrossrefRestWorkJson,
  parseCrossrefUnixrefXml,
  type CrossrefDiagnosticResult,
  type CrossrefRestWork,
  type CrossrefUnixrefRecord
} from './response.js';
import { crossrefContributorRole } from './contributors.js';
import { buildCrossrefReportPaperXml, type CrossrefDepositRelation, type CrossrefRelation } from './xml.js';
import type { CanonicalCreator, CanonicalMetadataSnapshot } from '../metadata.js';
import { ProviderHttpError, retryAfterMsFromHeaders, type ProviderResponseHeaders } from '../resilience/errors.js';
import { DirectProviderOperationRunner, type ProviderOperationRunner } from '../resilience/provider-runner.js';
import { compareCodeUnits } from '../sort.js';

export interface CrossrefResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: ProviderResponseHeaders;
  readonly text: () => Promise<string>;
}

export type CrossrefFetchLike = (url: string, init: RequestInit) => Promise<CrossrefResponseLike>;

export interface CrossrefPollOptions {
  readonly maxAttempts: number;
  readonly delayMs: number;
}

export interface CrossrefXmlApiVerification {
  readonly status: 'matched' | 'pending';
  readonly record?: CrossrefUnixrefRecord;
  readonly reason?: string;
}

export interface CrossrefApiClientOptions {
  readonly fetch?: CrossrefFetchLike;
  readonly operationRunner?: ProviderOperationRunner;
  readonly poll?: Partial<CrossrefPollOptions>;
}

export interface CrossrefReportPaperDepositInput {
  readonly environment: CrossrefEnvironment;
  readonly loginId: string;
  readonly password: string;
  readonly depositorName: string;
  readonly emailAddress: string;
  readonly registrant: string;
  readonly batchId: string;
  readonly timestamp: string;
  readonly filename: string;
  readonly metadata: CanonicalMetadataSnapshot;
  readonly resourceUrl: string;
  readonly relation?: CrossrefDepositRelation;
  /** Called after Crossref accepts the upload and before submissionDownload polling begins. */
  readonly onSubmitted?: () => Promise<void>;
}

export interface CrossrefReportPaperVerifyInput {
  readonly environment: CrossrefEnvironment;
  readonly emailAddress: string;
  readonly metadata: CanonicalMetadataSnapshot;
  readonly resourceUrl: string;
  readonly relation?: CrossrefRelation;
}

export interface CrossrefReadWorkInput {
  readonly doi: string;
  readonly emailAddress?: string;
}

export type CrossrefDepositOutcome =
  | {
      readonly status: 'succeeded';
      readonly filename: string;
      readonly diagnostic: CrossrefDiagnosticResult;
      readonly xmlVerification?: CrossrefXmlApiVerification;
    }
  | {
      readonly status: 'pending';
      readonly filename: string;
      readonly diagnostic?: CrossrefDiagnosticResult;
      readonly xmlVerification?: CrossrefXmlApiVerification;
    }
  | {
      readonly status: 'failed';
      readonly filename: string;
      readonly diagnostic: CrossrefDiagnosticResult;
    };

const defaultPoll: CrossrefPollOptions = {
  maxAttempts: 20,
  delayMs: 3000
};

/** Submits and verifies Crossref XML deposits through the Crossref servlet APIs. */
export class CrossrefApiClient {
  private readonly fetch: CrossrefFetchLike;
  private readonly operationRunner: ProviderOperationRunner;
  private readonly poll: CrossrefPollOptions;

  constructor(options: CrossrefApiClientOptions = {}) {
    this.fetch = options.fetch ?? fetch;
    this.operationRunner = options.operationRunner ?? new DirectProviderOperationRunner();
    this.poll = {
      ...defaultPoll,
      ...options.poll
    };
  }

  async submitReportPaper(input: CrossrefReportPaperDepositInput): Promise<CrossrefDepositOutcome> {
    const xml = buildCrossrefReportPaperXml({
      batchId: input.batchId,
      timestamp: input.timestamp,
      depositorName: input.depositorName,
      emailAddress: input.emailAddress,
      registrant: input.registrant,
      metadata: input.metadata,
      resourceUrl: input.resourceUrl,
      ...(input.relation ? { relation: input.relation } : {})
    });
    const loginId = crossrefLoginId(input.loginId);
    const request = buildCrossrefDepositRequest({
      environment: input.environment,
      loginId,
      password: input.password,
      filename: input.filename,
      xml
    });

    await this.uploadDeposit(request);
    await input.onSubmitted?.();

    const outcome = await this.operationRunner.run('crossref', () => this.pollSubmission({
      environment: input.environment,
      loginId,
      password: input.password,
      filename: input.filename
    }));
    if (outcome.status !== 'succeeded' || input.environment !== 'production') return outcome;

    const verificationRelation = input.relation === 'delete-all' ? undefined : input.relation;
    const verification = await this.operationRunner.run('crossref', () => this.pollXmlApiVerification({
      environment: input.environment,
      pid: input.emailAddress,
      metadata: input.metadata,
      resourceUrl: input.resourceUrl,
      ...(verificationRelation ? { relation: verificationRelation } : {})
    }));
    if (verification.status === 'matched') {
      return {
        ...outcome,
        xmlVerification: verification
      };
    }

    return {
      status: 'pending',
      filename: outcome.filename,
      diagnostic: outcome.diagnostic,
      xmlVerification: verification
    };
  }

  private async uploadDeposit(request: CrossrefDepositRequest): Promise<void> {
    await runProviderOnce(this.operationRunner, 'crossref', async () => {
      const form = new FormData();
      form.set('operation', request.fields.operation);
      form.set('login_id', request.fields.login_id);
      form.set('login_passwd', request.fields.login_passwd);
      form.set('fname', new File([request.fields.fname.body], request.fields.fname.filename, {
        type: request.fields.fname.contentType
      }));

      const response = await this.fetch(request.endpoint, {
        method: request.method,
        body: form
      });
      await assertCrossrefOk(response);
    });
  }

  async verifyReportPaper(input: CrossrefReportPaperVerifyInput): Promise<CrossrefXmlApiVerification> {
    return this.operationRunner.run('crossref', () => this.pollXmlApiVerification({
      environment: input.environment,
      pid: input.emailAddress,
      metadata: input.metadata,
      resourceUrl: input.resourceUrl,
      ...(input.relation ? { relation: input.relation } : {})
    }));
  }

  async readWork(input: CrossrefReadWorkInput): Promise<CrossrefRestWork | null> {
    return this.operationRunner.run('crossref', async () => {
      const response = await this.fetch(buildRestWorkLookupUrl(input), {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });
      if (response.status === 404) return null;
      await assertCrossrefOk(response);
      return parseCrossrefRestWorkJson(JSON.parse(await response.text()));
    });
  }

  private async pollSubmission(input: {
    readonly environment: CrossrefEnvironment;
    readonly loginId: string;
    readonly password: string;
    readonly filename: string;
  }): Promise<CrossrefDepositOutcome> {
    let lastDiagnostic: CrossrefDiagnosticResult | undefined;
    for (let attempt = 0; attempt < this.poll.maxAttempts; attempt++) {
      if (attempt > 0 && this.poll.delayMs > 0) await sleep(this.poll.delayMs);

      const request = buildSubmissionDownloadRequest(input);
      const response = await this.fetch(request.endpoint, {
        method: 'POST',
        body: request.body
      });
      await assertCrossrefOk(response);
      const body = await response.text();
      const diagnostic = parseCrossrefDiagnosticXml(body);
      lastDiagnostic = diagnostic;
      if (diagnostic.status === 'success') {
        return {
          status: 'succeeded',
          filename: input.filename,
          diagnostic
        };
      }
      if (diagnostic.status === 'failed') {
        return {
          status: 'failed',
          filename: input.filename,
          diagnostic
        };
      }
    }

    return {
      status: 'pending',
      filename: input.filename,
      ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {})
    };
  }

  private async pollXmlApiVerification(input: {
    readonly environment: CrossrefEnvironment;
    readonly pid: string;
    readonly metadata: CanonicalMetadataSnapshot;
    readonly resourceUrl: string;
    readonly relation?: CrossrefRelation;
  }): Promise<CrossrefXmlApiVerification> {
    let lastVerification: CrossrefXmlApiVerification | undefined;
    for (let attempt = 0; attempt < this.poll.maxAttempts; attempt++) {
      if (attempt > 0 && this.poll.delayMs > 0) await sleep(this.poll.delayMs);

      const response = await this.fetch(buildXmlApiLookupUrl(input), {
        method: 'GET'
      });
      await assertCrossrefOk(response);
      const record = parseCrossrefUnixrefXml(await response.text());
      const metadataVerification = verifyXmlApiRecord({
        record,
        metadata: input.metadata,
        resourceUrl: input.resourceUrl
      });
      lastVerification = metadataVerification;
      if (metadataVerification.status !== 'matched') continue;
      if (!input.relation) return metadataVerification;
      if (!metadataVerification.record) continue;

      lastVerification = verifyXmlApiRelation({
        record: metadataVerification.record,
        relation: input.relation
      });
      if (lastVerification.status === 'matched') return lastVerification;
    }

    return lastVerification ?? {
      status: 'pending',
      reason: 'Crossref XML API did not return deposited metadata'
    };
  }
}

function runProviderOnce<T>(
  runner: ProviderOperationRunner,
  provider: 'crossref',
  operation: () => Promise<T>
): Promise<T> {
  return runner.runOnce ? runner.runOnce(provider, operation) : operation();
}

export function crossrefLoginId(value: string): string {
  return value.replace(/:/g, '/');
}

function buildSubmissionDownloadRequest(input: {
  readonly environment: CrossrefEnvironment;
  readonly loginId: string;
  readonly password: string;
  readonly filename: string;
}): { readonly endpoint: string; readonly body: FormData } {
  const endpoint = input.environment === 'production'
    ? 'https://doi.crossref.org/servlet/submissionDownload'
    : 'https://test.crossref.org/servlet/submissionDownload';
  const body = new FormData();
  body.set('usr', input.loginId);
  body.set('pwd', input.password);
  body.set('file_name', input.filename);
  body.set('type', 'result');
  return { endpoint, body };
}

function buildXmlApiLookupUrl(input: {
  readonly environment: CrossrefEnvironment;
  readonly pid: string;
  readonly metadata: CanonicalMetadataSnapshot;
}): string {
  const params = new URLSearchParams({
    pid: input.pid,
    id: `doi:${input.metadata.doi}`,
    noredirect: 'true',
    format: 'unixref'
  });
  const host = input.environment === 'production' ? 'doi.crossref.org' : 'test.crossref.org';
  return `https://${host}/openurl?${params.toString()}`;
}

function buildRestWorkLookupUrl(input: CrossrefReadWorkInput): string {
  const params = new URLSearchParams();
  if (input.emailAddress) params.set('mailto', input.emailAddress);
  const query = params.toString();
  return `https://api.crossref.org/works/${encodeURIComponent(input.doi.trim())}${query ? `?${query}` : ''}`;
}

function verifyXmlApiRecord(input: {
  readonly record: CrossrefUnixrefRecord | null;
  readonly metadata: CanonicalMetadataSnapshot;
  readonly resourceUrl: string;
}): CrossrefXmlApiVerification {
  if (!input.record) {
    return {
      status: 'pending',
      reason: 'Crossref XML API did not return a report-paper record'
    };
  }

  const expected = {
    doi: normalizeDoi(input.metadata.doi),
    title: normalizeText(input.metadata.title),
    abstract: normalizeText(input.metadata.abstract),
    abstractLanguage: input.metadata.abstract ? normalizeLanguage(input.metadata.language) : null,
    publicationDate: input.metadata.publicationDate,
    publisher: normalizeText(input.metadata.publisher),
    creators: crossrefCreatorSignatures(input.metadata.creators),
    resourceUrl: normalizeUrl(input.resourceUrl)
  };
  const actual = {
    doi: normalizeDoi(input.record.doi),
    title: normalizeText(input.record.title),
    abstract: normalizeText(input.record.abstract),
    abstractLanguage: normalizeLanguage(input.record.abstractLanguage),
    publicationDate: input.record.publicationDate,
    publisher: normalizeText(input.record.publisher),
    institution: normalizeText(input.record.institution),
    creators: crossrefCreatorSignatures(input.record.creators ?? []),
    resourceUrl: normalizeUrl(input.record.resourceUrl)
  };

  const mismatches = [
    actual.doi !== expected.doi ? `doi=${actual.doi ?? 'missing'}` : null,
    actual.title !== expected.title ? 'title' : null,
    expected.abstract !== null && actual.abstract !== expected.abstract ? 'abstract' : null,
    expected.abstractLanguage !== null && actual.abstractLanguage !== expected.abstractLanguage ? 'abstractLanguage' : null,
    actual.publicationDate !== expected.publicationDate ? `publicationDate=${actual.publicationDate ?? 'missing'}` : null,
    expected.publisher !== null && (actual.publisher !== expected.publisher || actual.institution !== expected.publisher) ? 'publisher' : null,
    expected.creators.length > 0 && !sameStringArray(actual.creators, expected.creators) ? 'creators' : null,
    actual.resourceUrl !== expected.resourceUrl ? 'resourceUrl' : null
  ].filter((entry): entry is string => Boolean(entry));

  if (mismatches.length === 0) {
    return {
      status: 'matched',
      record: input.record
    };
  }

  return {
    status: 'pending',
    record: input.record,
    reason: `Crossref XML API metadata has not caught up: ${mismatches.join(', ')}`
  };
}

function verifyXmlApiRelation(input: {
  readonly record: CrossrefUnixrefRecord;
  readonly relation: CrossrefRelation;
}): CrossrefXmlApiVerification {
  if (hasExpectedRelation(input.record.relations ?? [], input.relation)) {
    return {
      status: 'matched',
      record: input.record
    };
  }

  return {
    status: 'pending',
    record: input.record,
    reason: 'Crossref XML API metadata has not caught up: relation=missing'
  };
}

function hasExpectedRelation(
  relations: NonNullable<CrossrefUnixrefRecord['relations']>,
  expected: CrossrefRelation
): boolean {
  return relations.some((relation) => (
    relation.type === expected.type
    && relation.identifierType?.toLowerCase() === expected.identifierType
    && normalizeRelationIdentifier(relation.identifier, expected.identifierType) === normalizeRelationIdentifier(expected.identifier, expected.identifierType)
  ));
}

function normalizeRelationIdentifier(value: string | null | undefined, identifierType: CrossrefRelation['identifierType']): string | null {
  return identifierType === 'doi' ? normalizeDoi(value) : normalizeText(value);
}

function normalizeDoi(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function normalizeLanguage(value: string | null | undefined): string | null {
  const text = normalizeText(value);
  return text ? text.toLowerCase() : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function crossrefCreatorSignatures(creators: readonly CanonicalCreator[] | NonNullable<CrossrefUnixrefRecord['creators']>): readonly string[] {
  return creators
    .map((creator) => {
      const creatorType = crossrefContributorRole(creator.creatorType);
      if (creator.type === 'personal') {
        const givenName = normalizeText(creator.givenName);
        const familyName = normalizeText(creator.familyName) ?? normalizeText(creator.name);
        const name = [familyName, givenName].filter((part): part is string => Boolean(part)).join(', ');
        return ['personal', creatorType, normalizeText(name) ?? '', givenName ?? '', familyName ?? ''].join('\u001F');
      }

      return ['organizational', creatorType, normalizeText(creator.name) ?? ''].join('\u001F');
    })
    .sort(compareCodeUnits);
}

async function assertCrossrefOk(response: CrossrefResponseLike): Promise<void> {
  if (response.ok) return;
  throw new ProviderHttpError({
    provider: 'crossref',
    status: response.status,
    body: await response.text(),
    retryAfterMs: retryAfterMsFromHeaders(response.headers)
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
