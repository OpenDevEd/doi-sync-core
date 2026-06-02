import { describe, expect, it } from 'vitest';
import { auditCrossrefDepositMetadata, auditZenodoWritePayloadMetadata } from '../metadata-audit.js';
import type { CanonicalMetadataSnapshot } from '../metadata.js';
import type { CrossrefRestWork } from '../crossref/response.js';
import type { ZenodoRecordSnapshot } from '../zenodo/records.js';

const planned: CanonicalMetadataSnapshot = {
  doi: '10.53832/edtechhub.1152',
  itemType: 'report',
  title: "How Is AI Transforming Teachers' Roles in Low- and Middle-Income Countries?",
  publicationDate: '2026-04-01',
  abstract: 'This learning brief maps where AI use can transform teachers roles.',
  language: 'en',
  publisher: 'EdTech Hub',
  creators: [{
    type: 'personal',
    name: 'Adam, Taskeen',
    creatorType: 'author',
    givenName: 'Taskeen',
    familyName: 'Adam'
  }],
  tags: []
};

describe('provider metadata audit', () => {
  it('accepts equivalent Crossref metadata when the REST top-level URL is only the DOI resolver', () => {
    const findings = auditCrossrefDepositMetadata({
      current: crossrefWork({
        URL: 'https://doi.org/10.53832/edtechhub.1152',
        resource: { primary: { URL: 'https://docs.edtechhub.org/lib/95DU3BRT' } }
      }),
      planned,
      plannedResourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT'
    });

    expect(findings).toEqual([]);
  });

  it('flags the real April-2026-to-January-2026 date regression as unsafe', () => {
    const findings = auditCrossrefDepositMetadata({
      current: crossrefWork(),
      planned: {
        ...planned,
        publicationDate: '2026-01-01'
      },
      plannedResourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT'
    });

    expect(findings).toContainEqual({
      provider: 'crossref',
      severity: 'unsafe',
      field: 'publicationDate',
      current: '2026-04-01',
      planned: '2026-01-01',
      message: 'planned Crossref publication date appears to lose month precision from the current provider record'
    });
  });

  it('flags destructive Crossref metadata loss before a deposit can be treated as safe', () => {
    const findings = auditCrossrefDepositMetadata({
      current: crossrefWork({
        author: [
          { given: 'Taskeen', family: 'Adam' },
          { given: 'Alex', family: 'Researcher' }
        ]
      }),
      planned: {
        doi: planned.doi,
        itemType: planned.itemType,
        title: planned.title,
        publicationDate: planned.publicationDate,
        language: 'en',
        creators: [],
        tags: planned.tags
      },
      plannedResourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT'
    });

    expect(findings.filter((finding) => finding.severity === 'unsafe')).toEqual([
      {
        provider: 'crossref',
        severity: 'unsafe',
        field: 'publisher',
        current: 'EdTech Hub',
        planned: undefined,
        message: 'planned Crossref metadata would remove the current publisher'
      },
      {
        provider: 'crossref',
        severity: 'unsafe',
        field: 'abstract',
        current: 'This learning brief maps where AI use can transform teachers roles.',
        planned: undefined,
        message: 'planned Crossref metadata would remove the current abstract'
      },
      {
        provider: 'crossref',
        severity: 'unsafe',
        field: 'creators',
        current: ['Adam, Taskeen', 'Researcher, Alex'],
        planned: [],
        message: 'planned Crossref metadata would drop creator entries from the current provider record'
      }
    ]);
  });

  it('keeps canonical Zotero metadata changes visible for review without classifying them as destructive', () => {
    const findings = auditCrossrefDepositMetadata({
      current: crossrefWork(),
      planned: {
        ...planned,
        title: "How Is AI Transforming Teachers' Roles in LMICs?"
      },
      plannedResourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT'
    });

    expect(findings).toEqual([{
      provider: 'crossref',
      severity: 'review',
      field: 'title',
      current: "How Is AI Transforming Teachers' Roles in Low- and Middle-Income Countries?",
      planned: "How Is AI Transforming Teachers' Roles in LMICs?",
      message: 'planned Crossref title differs from the current provider record; review against Zotero canonical metadata'
    }]);
  });

  it('audits Crossref type against the report-paper payload shape instead of raw Zotero itemType', () => {
    const findings = auditCrossrefDepositMetadata({
      current: crossrefWork(),
      planned: {
        ...planned,
        itemType: 'blogPost'
      },
      plannedResourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT'
    });

    expect(findings).toEqual([]);
  });

  it('accepts equivalent Zenodo record metadata and Zotero back-link identifiers', () => {
    const findings = auditZenodoWritePayloadMetadata({
      current: zenodoSnapshot(),
      planned: {
        metadata: {
          title: planned.title,
          publication_date: planned.publicationDate,
          description: `${planned.abstract ?? ''}\n\n<p>Available from <a href="https://docs.edtechhub.org/lib/95DU3BRT">https://docs.edtechhub.org/lib/95DU3BRT</a></p>`,
          doi: planned.doi,
          creators: [{ name: 'Adam, Taskeen' }],
          related_identifiers: [{
            identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
            relation: 'isAlternateIdentifier',
            scheme: 'url',
            resource_type: 'other'
          }]
        }
      }
    });

    expect(findings).toEqual([]);
  });

  it('flags destructive Zenodo metadata loss before publishing a draft', () => {
    const findings = auditZenodoWritePayloadMetadata({
      current: zenodoSnapshot(),
      planned: {
        metadata: {
          title: planned.title,
          publication_date: '2026-01-01',
          doi: planned.doi,
          creators: []
        }
      }
    });

    expect(findings.filter((finding) => finding.severity === 'unsafe')).toEqual([
      {
        provider: 'zenodo',
        severity: 'unsafe',
        field: 'publicationDate',
        current: '2026-04-01',
        planned: '2026-01-01',
        message: 'planned Zenodo publication date appears to lose month precision from the current provider record'
      },
      {
        provider: 'zenodo',
        severity: 'unsafe',
        field: 'description',
        current: 'This learning brief maps where AI use can transform teachers roles.',
        planned: undefined,
        message: 'planned Zenodo metadata would remove the current description'
      },
      {
        provider: 'zenodo',
        severity: 'unsafe',
        field: 'creators',
        current: ['Adam, Taskeen'],
        planned: [],
        message: 'planned Zenodo metadata would drop creator entries from the current provider record'
      }
    ]);
  });
});

function crossrefWork(overrides: Record<string, unknown> = {}): CrossrefRestWork {
  const raw = {
    DOI: '10.53832/edtechhub.1152',
    type: 'report',
    title: ["How Is AI Transforming Teachers' Roles in Low- and Middle-Income Countries?"],
    publisher: 'EdTech Hub',
    abstract: '<jats:p>This learning brief maps where AI use can transform teachers roles.</jats:p>',
    author: [{ given: 'Taskeen', family: 'Adam' }],
    issued: { 'date-parts': [[2026, 4, 1]] },
    resource: { primary: { URL: 'https://docs.edtechhub.org/lib/95DU3BRT' } },
    ...overrides
  };
  return {
    doi: '10.53832/edtechhub.1152',
    title: ["How Is AI Transforming Teachers' Roles in Low- and Middle-Income Countries?"],
    resourceUrl: 'https://docs.edtechhub.org/lib/95DU3BRT',
    type: 'report',
    relations: [],
    raw
  };
}

function zenodoSnapshot(): ZenodoRecordSnapshot {
  return {
    identifiers: {
      latestRecordId: '17585570',
      parentId: '17585569',
      versionDoi: '10.53832/edtechhub.1152',
      links: {}
    },
    metadata: {
      title: planned.title,
      publication_date: '2026-04-01',
      description: planned.abstract ?? '',
      creators: [{
        person_or_org: {
          name: 'Adam, Taskeen'
        }
      }],
      identifiers: [{
        identifier: 'zotero://select/groups/2405685/items/95DU3BRT',
        scheme: 'url'
      }]
    },
    files: [{
      key: "Adam - 2026 - How Is AI Transforming Teachers' Roles in Low- and Middle-Income Countries.pdf",
      checksum: 'md5:673c7527e9b3a78a9324d8314a3d47e4',
      size: 1403885,
      contentType: 'application/pdf'
    }]
  };
}
