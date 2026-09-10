import type { JsonValue } from '../hash.js';
import type {
  PublicationCreator,
  PublicationRecordSnapshot
} from '../publication/record.js';
import { CROSSREF_LANGUAGE_CODES } from './languages.js';
import { crossrefContributorRole } from './contributors.js';

type CrossrefRecordInput = Omit<PublicationRecordSnapshot, 'recordKey' | 'canonicalRevision'>;

export type CrossrefPostedContentType = 'preprint' | 'blog' | 'letter' | 'other' | 'poster';
export type CrossrefBookComponentType = 'chapter' | 'reference_entry';

export interface CrossrefPages {
  readonly first: string;
  readonly last?: string | undefined;
}

interface CrossrefMappedRecordBase {
  readonly metadata: CrossrefMappedMetadata;
  readonly landingUrl: string;
}

export interface CrossrefMappedMetadata {
  readonly title: string;
  readonly publicationDate: string;
  readonly abstract?: string | undefined;
  readonly language?: string | undefined;
  readonly creators: readonly PublicationCreator[];
  readonly doi: string;
}

export type CrossrefMappedRecord =
  | (CrossrefMappedRecordBase & {
      readonly kind: 'journal-article';
      readonly journalTitle: string;
      readonly issns: readonly string[];
      readonly volume?: string | undefined;
      readonly issue?: string | undefined;
      readonly pages?: CrossrefPages | undefined;
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'book';
      readonly publisher: string;
      readonly isbns: readonly string[];
      readonly edition?: string | undefined;
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'book-component';
      readonly bookTitle: string;
      readonly publisher: string;
      readonly componentType: CrossrefBookComponentType;
      readonly isbns: readonly string[];
      readonly edition?: string | undefined;
      readonly componentNumber?: string | undefined;
      readonly pages?: CrossrefPages | undefined;
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'conference-paper';
      readonly conferenceName: string;
      readonly proceedingsTitle: string;
      readonly publisher: string;
      readonly isbns: readonly string[];
      readonly conferenceAcronym?: string | undefined;
      readonly conferenceLocation?: string | undefined;
      readonly conferenceDate?: string | undefined;
      readonly pages?: CrossrefPages | undefined;
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'dissertation';
      readonly institution: string;
      readonly degree?: string | undefined;
      readonly isbns: readonly string[];
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'report';
      readonly publisher?: string;
      readonly institution?: string;
      readonly edition?: string | undefined;
      readonly isbns: readonly string[];
      readonly itemNumber?: string | undefined;
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'standard';
      readonly standardsBody: string;
      readonly standardsBodyAcronym: string;
      readonly designator: string;
      readonly publisher?: string | undefined;
      readonly edition?: string | undefined;
      readonly isbns: readonly string[];
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'dataset';
      readonly databaseTitle: string;
      readonly publisher?: string;
      readonly institution?: string;
      readonly version?: string | undefined;
    })
  | (CrossrefMappedRecordBase & {
      readonly kind: 'posted-content';
      readonly postedContentType: CrossrefPostedContentType;
      readonly hostingIdentity: string;
      readonly itemNumber?: string | undefined;
    });

export interface CrossrefRecordValidationIssue {
  readonly code:
    | 'UNSUPPORTED_ITEM_TYPE'
    | 'MISSING_REQUIRED_FIELD'
    | 'INVALID_FIELD_VALUE';
  readonly path: string;
  readonly message: string;
}

export type CrossrefRecordMappingResult =
  | { readonly ok: true; readonly record: CrossrefMappedRecord }
  | { readonly ok: false; readonly issues: readonly CrossrefRecordValidationIssue[] };

export function mapCrossrefRecord(record: CrossrefRecordInput, doi: string): CrossrefRecordMappingResult {
  return inspectCrossrefRecord(record, doi);
}

/** Validate metadata before a DOI is reserved, using the same mapper as deposits. */
export function validateCrossrefPublicationRecord(record: Omit<CrossrefRecordInput, 'landingUrl'>): readonly CrossrefRecordValidationIssue[] {
  const mapped = inspectCrossrefRecord({...record, landingUrl: ''});
  return mapped.ok ? [] : mapped.issues;
}

function inspectCrossrefRecord(record: CrossrefRecordInput, doi?: string): CrossrefRecordMappingResult {
  const mapped = mapCrossrefItem(record, doi ?? '');
  const issues = [...validateCommonFields(record, doi), ...validateTypeFields(record), ...(mapped.ok ? [] : mapped.issues)];
  return issues.length ? {ok: false, issues} : mapped;
}

function mapCrossrefItem(record: CrossrefRecordInput, doi: string): CrossrefRecordMappingResult {
  const metadata: CrossrefMappedMetadata = {
    title: record.title,
    publicationDate: record.publicationDate,
    ...(record.abstract ? { abstract: record.abstract } : {}),
    ...(record.language ? { language: record.language.toLowerCase() } : {}),
    creators: mapCreators(record.creators),
    doi
  };
  const base = { metadata, landingUrl: record.landingUrl };
  const organization = record.publisher ?? record.institution;

  switch (record.itemType) {
    case 'JournalArticle':
      return requiredString(record.fields['publicationTitle'], 'fields.publicationTitle', 'journal title', (journalTitle) => ({
        ok: true,
        record: {
          ...base, kind: 'journal-article', journalTitle,
          issns: identifierList(record.fields['ISSN']),
          ...optionalField('volume', record.fields['volume']),
          ...optionalField('issue', record.fields['issue']),
          ...optionalPages(record.fields['pages'])
        }
      }));
    case 'Book':
      return requiredValue(record.publisher, 'publisher', 'publisher', (publisher) => ({
        ok: true,
        record: {
          ...base, kind: 'book', publisher,
          isbns: identifierList(record.fields['ISBN']),
          ...optionalField('edition', record.fields['edition'])
        }
      }));
    case 'BookSection':
      return mapBookComponent(base, record, 'bookTitle', 'chapter');
    case 'DictionaryEntry':
      return mapBookComponent(base, record, 'dictionaryTitle', 'reference_entry');
    case 'EncyclopediaArticle':
      return mapBookComponent(base, record, 'encyclopediaTitle', 'reference_entry');
    case 'ConferencePaper': {
      const conferenceName = fieldString(record.fields['conferenceName'])
        ?? fieldString(record.fields['proceedingsTitle']);
      const proceedingsTitle = fieldString(record.fields['proceedingsTitle']) ?? conferenceName;
      const issues = [
        ...missingValue(conferenceName, 'fields.conferenceName', 'conference or proceedings title'),
        ...missingValue(organization, 'publisher', 'conference proceedings publisher')
      ];
      return issues.length > 0 || !conferenceName || !proceedingsTitle || !organization
        ? { ok: false, issues }
        : {
            ok: true,
            record: {
              ...base, kind: 'conference-paper', conferenceName, proceedingsTitle, publisher: organization,
              isbns: identifierList(record.fields['ISBN']),
              ...optionalField('conferenceAcronym', record.fields['conferenceAcronym']),
              ...optionalField('conferenceLocation', record.fields['place']),
              ...optionalField('conferenceDate', record.fields['conferenceDate']),
              ...optionalPages(record.fields['pages'])
            }
          };
    }
    case 'Thesis': {
      const issues = [
        ...missingValue(record.institution, 'institution', 'awarding institution'),
        ...(record.creators.length === 0
          ? [{ code: 'MISSING_REQUIRED_FIELD' as const, path: 'creators', message: 'Crossref dissertation requires at least one creator' }]
          : [])
      ];
      return issues.length > 0 || !record.institution
        ? { ok: false, issues }
        : {
            ok: true,
            record: {
              ...base, kind: 'dissertation', institution: record.institution,
              isbns: identifierList(record.fields['ISBN']),
              ...optionalField('degree', record.fields['degree'] ?? record.fields['thesisType'])
            }
          };
    }
    case 'Report':
      return requiredValue(organization, 'publisher', 'institution or publisher', () => ({
        ok: true,
        record: {
          ...base,
          kind: 'report',
          ...(record.publisher ? { publisher: record.publisher } : {}),
          ...(record.institution ? { institution: record.institution } : {}),
          isbns: identifierList(record.fields['ISBN']),
          ...optionalField('edition', record.fields['edition']),
          ...optionalField('itemNumber', record.fields['reportNumber'] ?? record.fields['number'])
        }
      }));
    case 'Standard': {
      const standardsBody = record.institution ?? record.publisher;
      const designator = fieldString(record.fields['number']) ?? fieldString(record.fields['standardNumber']);
      const issues = [
        ...missingValue(standardsBody, 'institution', 'standards body or issuing authority'),
        ...missingValue(designator, 'fields.number', 'standard designator')
      ];
      return issues.length > 0 || !standardsBody || !designator
        ? { ok: false, issues }
        : {
            ok: true,
            record: {
              ...base,
              kind: 'standard',
              standardsBody,
              standardsBodyAcronym: fieldString(record.fields['acronym']) ?? acronym(standardsBody),
              designator,
              isbns: identifierList(record.fields['ISBN']),
              ...(record.publisher ? { publisher: record.publisher } : {}),
              ...optionalField('edition', record.fields['edition'])
            }
          };
    }
    case 'Dataset':
      return requiredValue(organization, 'publisher', 'dataset publisher or institution', () => ({
        ok: true,
        record: {
          ...base,
          kind: 'dataset',
          databaseTitle: fieldString(record.fields['databaseTitle']) ?? record.title,
          ...(record.publisher ? { publisher: record.publisher } : {}),
          ...(record.institution ? { institution: record.institution } : {}),
          ...optionalField('version', record.fields['version'])
        }
      }));
    case 'Preprint':
      return mapPostedContent(base, record, 'preprint');
    case 'BlogPost':
      return mapPostedContent(base, record, 'blog');
    case 'Letter':
      return mapPostedContent(base, record, 'letter');
    case 'Document':
    case 'Manuscript':
      if (record.fields['postedContentConfirmed'] !== true) {
        return {
          ok: false,
          issues: [{
            code: 'INVALID_FIELD_VALUE', path: 'fields.postedContentConfirmed',
            message: `${record.itemType} requires explicit posted-content confirmation`
          }]
        };
      }
      return mapPostedContent(base, record, 'other');
    case 'Presentation': {
      const presentationType = fieldString(record.fields['presentationType']);
      if (presentationType?.toLowerCase() !== 'poster') {
        return {
          ok: false,
          issues: [{
            code: 'INVALID_FIELD_VALUE', path: 'fields.presentationType',
            message: 'Presentation is Crossref-supported only when presentationType is poster'
          }]
        };
      }
      return mapPostedContent(base, record, 'poster');
    }
    default:
      return {
        ok: false,
        issues: [{
          code: 'UNSUPPORTED_ITEM_TYPE', path: 'itemType',
          message: `Crossref does not support Evidence Library item type ${record.itemType}`
        }]
      };
  }
}

function validateCommonFields(record: CrossrefRecordInput, doi?: string): readonly CrossrefRecordValidationIssue[] {
  const issues: CrossrefRecordValidationIssue[] = [];
  if (doi !== undefined && !/^10\.\d{4,9}\/.{1,200}$/u.test(doi)) {
    issues.push({
      code: 'INVALID_FIELD_VALUE', path: 'identifiers.managedCrossrefDoi',
      message: 'Crossref DOI must have a 4-9 digit prefix and a suffix of no more than 200 characters'
    });
  }
  if (!isCrossrefDate(record.publicationDate)) {
    issues.push({
      code: 'INVALID_FIELD_VALUE',
      path: 'publicationDate',
      message: 'Crossref requires a real ISO date with a year from 1400 through 2200'
    });
  }
  if (record.language && !CROSSREF_LANGUAGE_CODES.has(record.language.toLowerCase())) {
    issues.push({
      code: 'INVALID_FIELD_VALUE',
      path: 'language',
      message: 'Crossref language must be a supported ISO 639-1 or ISO 639-3 code'
    });
  }
  record.creators.forEach((creator, index) => {
    if (creator.orcid && !isValidOrcid(creator.orcid)) {
      issues.push({
        code: 'INVALID_FIELD_VALUE',
        path: `creators.${index}.orcid`,
        message: 'Crossref ORCID must contain a valid 16-character ORCID identifier'
      });
    }
  });
  return issues;
}

function validateTypeFields(record: CrossrefRecordInput): readonly CrossrefRecordValidationIssue[] {
  const issues: CrossrefRecordValidationIssue[] = [];
  const addInvalid = (path: string, message: string): void => {
    issues.push({ code: 'INVALID_FIELD_VALUE', path, message });
  };
  const validateLength = (path: string, value: JsonValue | undefined, maximum: number, minimum = 1): void => {
    const text = fieldString(value);
    if (text && (text.length < minimum || text.length > maximum)) {
      addInvalid(path, `Crossref requires ${path} to contain ${minimum}-${maximum} characters`);
    }
  };
  const validateIdentifiers = (
    path: 'fields.ISSN' | 'fields.ISBN',
    value: JsonValue | undefined,
    pattern: RegExp,
    label: string,
    minimumLength: number,
    maximumLength: number
  ): void => {
    for (const identifier of identifierList(value)) {
      const semanticallyValid = path === 'fields.ISSN'
        ? isValidIssn(identifier)
        : isValidIsbn(identifier);
      if (!pattern.test(identifier)
        || identifier.length < minimumLength
        || identifier.length > maximumLength
        || !semanticallyValid) {
        addInvalid(path, `Crossref requires a valid ${label}`);
      }
    }
  };

  if (record.itemType === 'JournalArticle') {
    validateIdentifiers('fields.ISSN', record.fields['ISSN'], /^\d{4}-?\d{3}[\dX]$/iu, 'ISSN', 8, 9);
    validateLength('fields.volume', record.fields['volume'], 32);
    validateLength('fields.issue', record.fields['issue'], 32);
  }
  if (['Book', 'BookSection', 'DictionaryEntry', 'EncyclopediaArticle', 'ConferencePaper', 'Thesis', 'Report', 'Standard'].includes(record.itemType)) {
    validateIdentifiers('fields.ISBN', record.fields['ISBN'], /^(?:97[89]-?)?\d[\d -]+[\dX]$/iu, 'ISBN', 10, 17);
  }
  if (['Book', 'BookSection', 'DictionaryEntry', 'EncyclopediaArticle', 'Report', 'Standard'].includes(record.itemType)) {
    validateLength('fields.edition', record.fields['edition'], 15);
  }
  if (record.itemType === 'ConferencePaper') {
    validateLength('fields.conferenceAcronym', record.fields['conferenceAcronym'], 127);
    validateLength('fields.place', record.fields['place'], 255, 2);
    validateLength('fields.conferenceDate', record.fields['conferenceDate'], 100);
  }
  if (record.itemType === 'Dataset') validateLength('fields.version', record.fields['version'], 100);
  if (record.itemType === 'Report') {
    validateLength('fields.reportNumber', record.fields['reportNumber'] ?? record.fields['number'], 32);
  }
  if (['Preprint', 'BlogPost', 'Letter', 'Document', 'Manuscript', 'Presentation'].includes(record.itemType)) {
    validateLength('fields.number', record.fields['number'], 32);
  }
  return issues;
}

function isValidIssn(value: string): boolean {
  const compact = value.replace('-', '').toUpperCase();
  if (!/^\d{7}[\dX]$/u.test(compact)) return false;
  const sum = compact.slice(0, 7).split('').reduce((total, digit, index) => (
    total + Number(digit) * (8 - index)
  ), 0);
  const check = (11 - (sum % 11)) % 11;
  return compact[7] === (check === 10 ? 'X' : String(check));
}

function isValidIsbn(value: string): boolean {
  const compact = value.replace(/[ -]/gu, '').toUpperCase();
  if (/^\d{9}[\dX]$/u.test(compact)) {
    const sum = compact.split('').reduce((total, digit, index) => (
      total + (digit === 'X' ? 10 : Number(digit)) * (10 - index)
    ), 0);
    return sum % 11 === 0;
  }
  if (!/^\d{13}$/u.test(compact)) return false;
  const sum = compact.slice(0, 12).split('').reduce((total, digit, index) => (
    total + Number(digit) * (index % 2 === 0 ? 1 : 3)
  ), 0);
  return Number(compact[12]) === (10 - (sum % 10)) % 10;
}

function isValidOrcid(value: string): boolean {
  const match = /^(?:https?:\/\/orcid\.org\/)?([0-9]{4})-([0-9]{4})-([0-9]{4})-([0-9]{3}[X0-9])$/iu.exec(value);
  if (!match) return false;
  const compact = match.slice(1).join('').toUpperCase();
  let total = 0;
  for (const digit of compact.slice(0, 15)) total = (total + Number(digit)) * 2;
  const result = (12 - (total % 11)) % 11;
  const expected = result === 10 ? 'X' : String(result);
  return compact[15] === expected;
}

function mapCreators(creators: readonly PublicationCreator[]): readonly PublicationCreator[] {
  return creators.map((creator) => {
    const creatorType = crossrefContributorRole(creator.creatorType);
    if (creator.type === 'organizational') {
      return { type: 'organizational', name: creator.name, creatorType };
    }
    const familyName = creator.familyName ?? creator.name;
    return {
      type: 'personal', name: familyName, familyName, creatorType,
      ...(creator.givenName ? { givenName: creator.givenName } : {}),
      ...(creator.affiliation ? { affiliation: creator.affiliation } : {}),
      ...(creator.orcid ? { orcid: normalizeOrcidValue(creator.orcid) } : {})
    };
  });
}

function normalizeOrcidValue(value: string): string {
  const identifier = value.replace(/^https?:\/\/orcid\.org\//iu, '').toUpperCase();
  return `https://orcid.org/${identifier}`;
}

function isCrossrefDate(value: string): boolean {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(value);
  if (!match?.[1]) return false;
  const year = Number(match[1]);
  if (year < 1400 || year > 2200) return false;
  if (!match[2]) return true;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  if (!match[3]) return true;
  const day = Number(match[3]);
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function mapBookComponent(
  base: CrossrefMappedRecordBase,
  record: CrossrefRecordInput,
  titleField: 'bookTitle' | 'dictionaryTitle' | 'encyclopediaTitle',
  componentType: CrossrefBookComponentType
): CrossrefRecordMappingResult {
  const bookTitle = fieldString(record.fields[titleField]);
  const issues = [
    ...missingValue(bookTitle, `fields.${titleField}`, 'parent book title'),
    ...missingValue(record.publisher, 'publisher', 'parent book publisher')
  ];
  return issues.length > 0 || !bookTitle || !record.publisher
    ? { ok: false, issues }
    : {
        ok: true,
        record: {
          ...base, kind: 'book-component', bookTitle, publisher: record.publisher, componentType,
          isbns: identifierList(record.fields['ISBN']),
          ...optionalField('edition', record.fields['edition']),
          ...optionalField('componentNumber', record.fields['section'] ?? record.fields['bookSection']),
          ...optionalPages(record.fields['pages'])
        }
      };
}

function mapPostedContent(
  base: CrossrefMappedRecordBase,
  record: CrossrefRecordInput,
  postedContentType: CrossrefPostedContentType
): CrossrefRecordMappingResult {
  const hostingIdentity = record.institution
    ?? record.publisher
    ?? fieldString(record.fields['websiteTitle']);
  return requiredValue(hostingIdentity, 'institution', 'posted-content hosting identity', (value) => ({
    ok: true,
    record: {
      ...base, kind: 'posted-content', postedContentType, hostingIdentity: value,
      ...optionalField('itemNumber', record.fields['number'])
    }
  }));
}

function requiredString<T extends CrossrefRecordMappingResult>(
  value: JsonValue | undefined,
  path: string,
  label: string,
  build: (value: string) => T
): T | CrossrefRecordMappingResult {
  return requiredValue(fieldString(value), path, label, build);
}

function requiredValue<T extends CrossrefRecordMappingResult>(
  value: string | undefined,
  path: string,
  label: string,
  build: (value: string) => T
): T | CrossrefRecordMappingResult {
  return value ? build(value) : { ok: false, issues: missingValue(value, path, label) };
}

function missingValue(
  value: string | undefined,
  path: string,
  label: string
): readonly CrossrefRecordValidationIssue[] {
  return value
    ? []
    : [{ code: 'MISSING_REQUIRED_FIELD', path, message: `Crossref requires ${label}` }];
}

function fieldString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalField<Key extends string>(
  key: Key,
  value: JsonValue | undefined
): Partial<Readonly<Record<Key, string>>> {
  const text = fieldString(value);
  return text ? { [key]: text } as Readonly<Record<Key, string>> : {};
}

function identifierList(value: JsonValue | undefined): readonly string[] {
  const text = fieldString(value);
  return text
    ? [...new Set(text.split(/[;,]\s*/u).map((entry) => entry.trim()).filter(Boolean))]
    : [];
}

function optionalPages(value: JsonValue | undefined): { readonly pages?: CrossrefPages } {
  const text = fieldString(value);
  if (!text) return {};
  const [first, last] = text.split(/\s*[-–—]\s*/u, 2);
  if (!first) return {};
  return { pages: { first, ...(last ? { last } : {}) } };
}

function acronym(value: string): string {
  const initials = value.split(/\s+/u).map((word) => word[0]).filter(Boolean).join('').toUpperCase();
  return initials.length >= 2 ? initials.slice(0, 20) : value.slice(0, 20);
}
