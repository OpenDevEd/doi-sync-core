import { describe, expect, it } from 'vitest';
import { buildCrossrefReportPaperXml } from '../crossref/xml.js';

describe('Crossref XML', () => {
  it('builds report-paper XML with a direct related_item relation', () => {
    const xml = buildCrossrefReportPaperXml({
      batchId: 'doi-sync-rec-1-abc',
      timestamp: '20260520123001000',
      depositorName: 'bjoern@example.org:odel',
      emailAddress: 'bjoern@example.org',
      registrant: 'OpenDevEd',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence & impact',
        publicationDate: '2026-05-20',
        abstract: 'Short summary.',
        publisher: 'Open Development & Education',
        creators: [{ type: 'personal', name: 'Lovelace, Ada', givenName: 'Ada', familyName: 'Lovelace' }],
        tags: ['evidence']
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      relation: {
        type: 'isSupplementedBy',
        identifierType: 'doi',
        identifier: '10.5281/zenodo.15043088',
        description: 'Archived file package'
      }
    });

    expect(xml).toContain('<doi_batch version="5.4.0"');
    expect(xml).toContain('<report-paper>');
    expect(xml).toContain('<title>Evidence &amp; impact</title>');
    expect(xml).toContain('<registrant>OpenDevEd</registrant>');
    expect(xml).toContain('<jats:abstract xml:lang="en"><jats:p>Short summary.</jats:p></jats:abstract>');
    expect(xml).toContain('<publisher><publisher_name>Open Development &amp; Education</publisher_name></publisher>');
    expect(xml).toContain('<institution><institution_name>Open Development &amp; Education</institution_name></institution>');
    expect(xml).toContain('<related_item>');
    expect(xml).toContain('<inter_work_relation relationship-type="isSupplementedBy" identifier-type="doi">10.5281/zenodo.15043088</inter_work_relation>');
    expect(xml).not.toContain('<intra_work_relation');
    expect(xml).not.toContain('<publisher_item>');
    expect(xml.indexOf('<contributors>')).toBeLessThan(xml.indexOf('<titles>'));
    expect(xml.indexOf('<titles>')).toBeLessThan(xml.indexOf('<jats:abstract'));
    expect(xml.indexOf('<jats:abstract')).toBeLessThan(xml.indexOf('<publication_date'));
    expect(xml.indexOf('<month>05</month>')).toBeLessThan(xml.indexOf('<day>20</day>'));
    expect(xml.indexOf('<day>20</day>')).toBeLessThan(xml.indexOf('<year>2026</year>'));
    expect(xml.indexOf('<institution>')).toBeLessThan(xml.indexOf('<program xmlns="http://www.crossref.org/relations.xsd">'));
    expect(xml.indexOf('<program xmlns="http://www.crossref.org/relations.xsd">')).toBeLessThan(xml.indexOf('<doi_data>'));
  });

  it('can build a blank relationship program for Crossref relationship deletion redeposits', () => {
    const xml = buildCrossrefReportPaperXml({
      batchId: 'doi-sync-rec-1-delete-relation',
      timestamp: '20260520123001000',
      depositorName: 'bjoern@example.org:odel',
      emailAddress: 'bjoern@example.org',
      registrant: 'OpenDevEd',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence & impact',
        publicationDate: '2026-05-20',
        creators: [],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345',
      relation: 'delete-all'
    });

    expect(xml).toContain('<program xmlns="http://www.crossref.org/relations.xsd"/>');
    expect(xml).not.toContain('<related_item>');
    expect(xml).not.toContain('<inter_work_relation');
    expect(xml.indexOf('<program xmlns="http://www.crossref.org/relations.xsd"/>')).toBeLessThan(xml.indexOf('<doi_data>'));
  });

  it('removes XML 1.0 control characters from text fields before serializing', () => {
    const xml = buildCrossrefReportPaperXml({
      batchId: 'doi-sync-rec-1-abc',
      timestamp: '20260520123001000',
      depositorName: 'Open\u0001DevEd',
      emailAddress: 'bjoern@example.org',
      registrant: 'Open Development \u0002 Education',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence\u0001 impact',
        publicationDate: '2026-05-20',
        abstract: 'Short\u0002 summary.',
        creators: [{ type: 'organizational', name: 'Org\u0003 Name' }],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(xml).not.toContain('\u0001');
    expect(xml).not.toContain('\u0002');
    expect(xml).not.toContain('\u0003');
    expect(xml).toContain('<title>Evidence impact</title>');
    expect(xml).toContain('<organization contributor_role="author" sequence="first">Org Name</organization>');
  });

  it('normalizes schema-sensitive attributes before serializing', () => {
    const xml = buildCrossrefReportPaperXml({
      batchId: 'doi-sync-rec-1-abc',
      timestamp: '20260520123001000',
      depositorName: 'OpenDevEd',
      emailAddress: 'bjoern@example.org',
      registrant: 'Open Development & Education',
      metadata: {
        doi: '10.53832/opendeved.1205',
        itemType: 'report',
        title: 'Evidence report',
        publicationDate: '2026-05-20',
        abstract: 'Short summary.',
        language: 'english invalid',
        creators: [{
          type: 'personal',
          name: 'Lovelace, Ada',
          givenName: 'Ada',
          familyName: 'Lovelace',
          creatorType: 'bad local role'
        }],
        tags: []
      },
      resourceUrl: 'https://my.educationevidence.io/lib/record/ABC12345'
    });

    expect(xml).toContain('<jats:abstract xml:lang="en"><jats:p>Short summary.</jats:p></jats:abstract>');
    expect(xml).toContain('<person_name contributor_role="author" sequence="first">');
    expect(xml).not.toContain('english invalid');
    expect(xml).not.toContain('bad local role');
  });
});
