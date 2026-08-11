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
import type { CrossrefMappedRecord } from './record-mapper.js';
import { buildCrossrefPublicationXml, type CrossrefDepositRelation, type CrossrefRelation } from './xml.js';
import type { PublicationCreator } from '../publication/record.js';
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

export interface CrossrefPublicationDepositInput {
  readonly environment: CrossrefEnvironment;
  readonly loginId: string;
  readonly password: string;
  readonly depositorName: string;
  readonly emailAddress: string;
  readonly registrant: string;
  readonly batchId: string;
  readonly timestamp: string;
  readonly filename: string;
  readonly record: CrossrefMappedRecord;
  readonly relation?: CrossrefDepositRelation;
  /** Called after Crossref accepts the upload and before submissionDownload polling begins. */
  readonly onSubmitted?: () => Promise<void>;
}

export interface CrossrefPublicationVerifyInput {
  readonly environment: CrossrefEnvironment;
  readonly emailAddress: string;
  readonly record: CrossrefMappedRecord;
  readonly relation?: CrossrefDepositRelation;
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

  async submitPublication(input: CrossrefPublicationDepositInput): Promise<CrossrefDepositOutcome> {
    const xml = buildCrossrefPublicationXml({
      batchId: input.batchId,
      timestamp: input.timestamp,
      depositorName: input.depositorName,
      emailAddress: input.emailAddress,
      registrant: input.registrant,
      record: input.record,
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
    if (outcome.status !== 'succeeded') return outcome;
    if (input.environment === 'test') {
      return {
        status: 'pending',
        filename: outcome.filename,
        diagnostic: outcome.diagnostic,
        xmlVerification: {
          status: 'pending',
          reason: 'Crossref test submission was accepted and requires XML API verification'
        }
      };
    }

    const verification = await this.operationRunner.run('crossref', () => this.pollXmlApiVerification({
      environment: input.environment,
      pid: input.emailAddress,
      record: input.record,
      ...(input.relation ? { relation: input.relation } : {})
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

  async verifyPublication(input: CrossrefPublicationVerifyInput): Promise<CrossrefXmlApiVerification> {
    return this.operationRunner.run('crossref', () => this.pollXmlApiVerification({
      environment: input.environment,
      pid: input.emailAddress,
      record: input.record,
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
    readonly record: CrossrefMappedRecord;
    readonly relation?: CrossrefDepositRelation;
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
        expected: input.record
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
  readonly record: CrossrefMappedRecord;
}): string {
  const params = new URLSearchParams({
    pid: input.pid,
    id: `doi:${input.record.metadata.doi}`,
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
  readonly expected: CrossrefMappedRecord;
}): CrossrefXmlApiVerification {
  if (!input.record) {
    return {
      status: 'pending',
      reason: 'Crossref XML API did not return the deposited publication record'
    };
  }

  const expected = {
    kind: input.expected.kind,
    doi: normalizeDoi(input.expected.metadata.doi),
    title: normalizeText(input.expected.metadata.title),
    abstract: normalizeText(input.expected.metadata.abstract),
    abstractLanguage: input.expected.metadata.abstract && input.expected.kind !== 'dataset'
      ? normalizeLanguage(input.expected.metadata.language)
      : null,
    language: normalizeLanguage(input.expected.metadata.language),
    publicationDate: input.expected.metadata.publicationDate,
    publisher: normalizeText(expectedPublisher(input.expected)),
    institution: normalizeText(expectedInstitution(input.expected)),
    containerTitle: normalizeText(expectedContainerTitle(input.expected)),
    componentType: input.expected.kind === 'book-component' ? input.expected.componentType : null,
    postedContentType: input.expected.kind === 'posted-content' ? input.expected.postedContentType : null,
    creators: crossrefCreatorSignatures(input.expected.metadata.creators),
    resourceUrl: normalizeUrl(input.expected.landingUrl),
    ...expectedTypeDetails(input.expected)
  };
  const actual = {
    doi: normalizeDoi(input.record.doi),
    kind: input.record.kind,
    title: normalizeText(input.record.title),
    abstract: normalizeText(input.record.abstract),
    abstractLanguage: normalizeLanguage(input.record.abstractLanguage),
    language: normalizeLanguage(input.record.language ?? input.record.abstractLanguage),
    publicationDate: input.record.publicationDate,
    publisher: normalizeText(input.record.publisher),
    institution: normalizeText(input.record.institution),
    containerTitle: normalizeText(input.record.containerTitle),
    componentType: normalizeText(input.record.componentType),
    postedContentType: normalizeText(input.record.postedContentType),
    creators: crossrefCreatorSignatures(input.record.creators ?? []),
    resourceUrl: normalizeUrl(input.record.resourceUrl),
    issns: normalizeStringArray(input.record.issns ?? []),
    isbns: normalizeStringArray(input.record.isbns ?? []),
    volume: normalizeText(input.record.volume),
    issue: normalizeText(input.record.issue),
    pages: normalizePages(input.record.pages),
    edition: normalizeText(input.record.edition),
    componentNumber: normalizeText(input.record.componentNumber),
    conferenceName: normalizeText(input.record.conferenceName),
    conferenceAcronym: normalizeText(input.record.conferenceAcronym),
    conferenceLocation: normalizeText(input.record.conferenceLocation),
    conferenceDate: normalizeText(input.record.conferenceDate),
    degree: normalizeText(input.record.degree),
    itemNumber: normalizeText(input.record.itemNumber),
    version: normalizeText(input.record.version),
    standardsBodyAcronym: normalizeText(input.record.standardsBodyAcronym),
    designator: normalizeText(input.record.designator),
    groupTitle: normalizeText(input.record.groupTitle)
  };

  const mismatches = [
    actual.kind !== expected.kind ? `kind=${actual.kind ?? 'missing'}` : null,
    actual.doi !== expected.doi ? `doi=${actual.doi ?? 'missing'}` : null,
    actual.title !== expected.title ? 'title' : null,
    actual.abstract !== expected.abstract ? 'abstract' : null,
    actual.abstractLanguage !== expected.abstractLanguage ? 'abstractLanguage' : null,
    actual.language !== expected.language ? 'language' : null,
    actual.publicationDate !== expected.publicationDate ? `publicationDate=${actual.publicationDate ?? 'missing'}` : null,
    actual.publisher !== expected.publisher ? 'publisher' : null,
    actual.institution !== expected.institution ? 'institution' : null,
    expected.containerTitle !== null && actual.containerTitle !== expected.containerTitle ? 'containerTitle' : null,
    expected.componentType !== null && actual.componentType !== expected.componentType ? 'componentType' : null,
    expected.postedContentType !== null && actual.postedContentType !== expected.postedContentType ? 'postedContentType' : null,
    !sameStringArray(actual.creators, expected.creators) ? 'creators' : null,
    actual.resourceUrl !== expected.resourceUrl ? 'resourceUrl' : null,
    !sameStringArray(actual.issns, expected.issns) ? 'issns' : null,
    !sameStringArray(actual.isbns, expected.isbns) ? 'isbns' : null,
    actual.volume !== expected.volume ? 'volume' : null,
    actual.issue !== expected.issue ? 'issue' : null,
    actual.pages !== expected.pages ? 'pages' : null,
    actual.edition !== expected.edition ? 'edition' : null,
    actual.componentNumber !== expected.componentNumber ? 'componentNumber' : null,
    actual.conferenceName !== expected.conferenceName ? 'conferenceName' : null,
    actual.conferenceAcronym !== expected.conferenceAcronym ? 'conferenceAcronym' : null,
    actual.conferenceLocation !== expected.conferenceLocation ? 'conferenceLocation' : null,
    actual.conferenceDate !== expected.conferenceDate ? 'conferenceDate' : null,
    actual.degree !== expected.degree ? 'degree' : null,
    actual.itemNumber !== expected.itemNumber ? 'itemNumber' : null,
    actual.version !== expected.version ? 'version' : null,
    actual.standardsBodyAcronym !== expected.standardsBodyAcronym ? 'standardsBodyAcronym' : null,
    actual.designator !== expected.designator ? 'designator' : null,
    actual.groupTitle !== expected.groupTitle ? 'groupTitle' : null
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

function expectedPublisher(record: CrossrefMappedRecord): string | undefined {
  switch (record.kind) {
    case 'book':
    case 'book-component':
    case 'conference-paper':
      return record.publisher;
    case 'report':
    case 'dataset':
      return record.publisher;
    case 'standard':
      return record.publisher;
    default:
      return undefined;
  }
}

function expectedTypeDetails(record: CrossrefMappedRecord): {
  readonly issns: readonly string[];
  readonly isbns: readonly string[];
  readonly volume: string | null;
  readonly issue: string | null;
  readonly pages: string | null;
  readonly edition: string | null;
  readonly componentNumber: string | null;
  readonly conferenceName: string | null;
  readonly conferenceAcronym: string | null;
  readonly conferenceLocation: string | null;
  readonly conferenceDate: string | null;
  readonly degree: string | null;
  readonly itemNumber: string | null;
  readonly version: string | null;
  readonly standardsBodyAcronym: string | null;
  readonly designator: string | null;
  readonly groupTitle: string | null;
} {
  return {
    issns: record.kind === 'journal-article' ? normalizeStringArray(record.issns) : [],
    isbns: 'isbns' in record ? normalizeStringArray(record.isbns) : [],
    volume: record.kind === 'journal-article' ? normalizeText(record.volume) : null,
    issue: record.kind === 'journal-article' ? normalizeText(record.issue) : null,
    pages: 'pages' in record ? normalizePages(record.pages) : null,
    edition: 'edition' in record ? normalizeText(record.edition) : null,
    componentNumber: record.kind === 'book-component' ? normalizeText(record.componentNumber) : null,
    conferenceName: record.kind === 'conference-paper' ? normalizeText(record.conferenceName) : null,
    conferenceAcronym: record.kind === 'conference-paper' ? normalizeText(record.conferenceAcronym) : null,
    conferenceLocation: record.kind === 'conference-paper' ? normalizeText(record.conferenceLocation) : null,
    conferenceDate: record.kind === 'conference-paper' ? normalizeText(record.conferenceDate) : null,
    degree: record.kind === 'dissertation' ? normalizeText(record.degree) : null,
    itemNumber: record.kind === 'report' || record.kind === 'posted-content'
      ? normalizeText(record.itemNumber)
      : null,
    version: record.kind === 'dataset' ? normalizeText(record.version) : null,
    standardsBodyAcronym: record.kind === 'standard' ? normalizeText(record.standardsBodyAcronym) : null,
    designator: record.kind === 'standard' ? normalizeText(record.designator) : null,
    groupTitle: record.kind === 'posted-content' ? normalizeText(record.hostingIdentity) : null
  };
}

function expectedInstitution(record: CrossrefMappedRecord): string | undefined {
  switch (record.kind) {
    case 'dissertation':
      return record.institution;
    case 'report':
    case 'dataset':
      return record.institution;
    case 'standard':
      return record.standardsBody;
    case 'posted-content':
      return record.hostingIdentity;
    case 'journal-article':
    case 'book':
    case 'book-component':
    case 'conference-paper':
      return undefined;
  }
}

function expectedContainerTitle(record: CrossrefMappedRecord): string | undefined {
  switch (record.kind) {
    case 'journal-article':
      return record.journalTitle;
    case 'book-component':
      return record.bookTitle;
    case 'conference-paper':
      return record.proceedingsTitle;
    case 'dataset':
      return record.databaseTitle;
    default:
      return undefined;
  }
}

function verifyXmlApiRelation(input: {
  readonly record: CrossrefUnixrefRecord;
  readonly relation: CrossrefDepositRelation;
}): CrossrefXmlApiVerification {
  if (input.relation === 'delete-all') {
    return (input.record.relations?.length ?? 0) === 0
      ? { status: 'matched', record: input.record }
      : {
          status: 'pending', record: input.record,
          reason: 'Crossref XML API metadata has not caught up: relations=not-cleared'
        };
  }
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
    && normalizeText(relation.description) === normalizeText(expected.description)
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

function normalizeStringArray(values: readonly string[]): readonly string[] {
  return values.map((value) => normalizeText(value) ?? '').filter(Boolean).sort(compareCodeUnits);
}

function normalizePages(value: { readonly first: string; readonly last?: string | undefined } | undefined): string | null {
  if (!value) return null;
  return [normalizeText(value.first), normalizeText(value.last)].filter(Boolean).join('-') || null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function crossrefCreatorSignatures(creators: readonly PublicationCreator[] | NonNullable<CrossrefUnixrefRecord['creators']>): readonly string[] {
  return creators
    .map((creator) => {
      const creatorType = crossrefContributorRole(creator.creatorType);
      if (creator.type === 'personal') {
        const givenName = normalizeText(creator.givenName);
        const familyName = normalizeText(creator.familyName) ?? normalizeText(creator.name);
        const name = [familyName, givenName].filter((part): part is string => Boolean(part)).join(', ');
        return [
          'personal', creatorType, normalizeText(name) ?? '', givenName ?? '', familyName ?? '',
          normalizeText(creator.affiliation) ?? '', normalizeOrcid(creator.orcid) ?? ''
        ].join('\u001F');
      }

      return ['organizational', creatorType, normalizeText(creator.name) ?? ''].join('\u001F');
    })
    .sort(compareCodeUnits);
}

function normalizeOrcid(value: string | null | undefined): string | null {
  const text = normalizeText(value)?.replace(/^https?:\/\/orcid\.org\//iu, '').toUpperCase();
  return text ?? null;
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
