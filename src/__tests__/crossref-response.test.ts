import { describe, expect, it } from 'vitest';
import { parseCrossrefDiagnosticXml, parseCrossrefRestRelations, parseCrossrefRestWorkJson, parseCrossrefUnixrefXml } from '../crossref/response.js';

describe('Crossref diagnostic response parsing', () => {
  it('parses a fully successful Crossref batch diagnostic response', () => {
    expect(parseCrossrefDiagnosticXml(`
      <doi_batch_diagnostic status="completed">
        <batch_data>
          <record_count>1</record_count>
          <success_count>1</success_count>
          <failure_count>0</failure_count>
        </batch_data>
      </doi_batch_diagnostic>
    `)).toEqual({
      status: 'success',
      batchStatus: 'completed',
      recordCount: 1,
      successCount: 1,
      failureCount: 0
    });
  });

  it('parses a Crossref failure without false positives from other counts', () => {
    expect(parseCrossrefDiagnosticXml(`
      <doi_batch_diagnostic status="completed">
        <batch_data>
          <record_count>1</record_count>
          <success_count>0</success_count>
          <failure_count>1</failure_count>
        </batch_data>
      </doi_batch_diagnostic>
    `).status).toBe('failed');
  });

  it('treats missing success count as pending', () => {
    expect(parseCrossrefDiagnosticXml(`
      <doi_batch_diagnostic status="submitted">
        <batch_data>
          <record_count>1</record_count>
        </batch_data>
      </doi_batch_diagnostic>
    `)).toEqual({
      status: 'pending',
      batchStatus: 'submitted',
      recordCount: 1,
      successCount: null,
      failureCount: 0
    });
  });

  it('parses UNIXREF report-paper metadata used to verify deposited Crossref state', () => {
    expect(parseCrossrefUnixrefXml(`
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
                  <organization contributor_role="editor" sequence="additional">Open Development &amp; Education</organization>
                </contributors>
                <titles>
                  <title>Evidence report</title>
                </titles>
                <jats:abstract xml:lang="fr">
                  <jats:p>An output of the Open Development &amp; Education, https://opendeved.net/.</jats:p>
                </jats:abstract>
                <publication_date media_type="online">
                  <month>04</month>
                  <day>09</day>
                  <year>2026</year>
                </publication_date>
                <publisher>
                  <publisher_name>Open Development &amp; Education</publisher_name>
                </publisher>
                <institution>
                  <institution_name>Open Development &amp; Education</institution_name>
                </institution>
                <doi_data>
                  <doi>10.53832/opendeved.1205</doi>
                  <resource>https://docs.opendeved.net/lib/ABC12345</resource>
                </doi_data>
              </report-paper_metadata>
            </report-paper>
          </crossref>
        </doi_record>
      </doi_records>
    `)).toEqual({
		kind: 'report',
      doi: '10.53832/opendeved.1205',
      title: 'Evidence report',
      abstract: 'An output of the Open Development & Education, https://opendeved.net/.',
      abstractLanguage: 'fr',
      publicationDate: '2026-04-09',
      publisher: 'Open Development & Education',
      institution: 'Open Development & Education',
      creators: [
        {
          type: 'personal',
          name: 'Lovelace, Ada',
          creatorType: 'author',
          givenName: 'Ada',
          familyName: 'Lovelace',
          affiliation: 'OpenDevEd',
          orcid: 'https://orcid.org/0000-0002-1825-0097'
        },
        {
          type: 'organizational',
          name: 'Open Development & Education',
          creatorType: 'editor'
        }
      ],
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      depositTimestamp: '2026-05-22 11:18:58'
    });
  });

  it('parses UNIXREF Crossref relation metadata', () => {
    expect(parseCrossrefUnixrefXml(`
      <doi_records>
        <doi_record owner="10.53832" timestamp="2026-05-22 11:18:58">
          <crossref>
            <report-paper>
              <report-paper_metadata>
                <titles><title>Evidence report</title></titles>
                <publication_date media_type="online"><year>2026</year></publication_date>
                <program xmlns="http://www.crossref.org/relations.xsd">
                  <related_item>
                    <description>Archived file package</description>
                    <inter_work_relation relationship-type="isSupplementedBy" identifier-type="doi">10.5281/zenodo.20342806</inter_work_relation>
                  </related_item>
                </program>
                <doi_data>
                  <doi>10.53832/opendeved.1205</doi>
                  <resource>https://docs.opendeved.net/lib/ABC12345</resource>
                </doi_data>
              </report-paper_metadata>
            </report-paper>
          </crossref>
        </doi_record>
      </doi_records>
    `)?.relations).toEqual([{
      type: 'isSupplementedBy',
      identifierType: 'doi',
      identifier: '10.5281/zenodo.20342806',
      description: 'Archived file package'
    }]);
  });

  it('parses Crossref REST relation metadata', () => {
    expect(parseCrossrefRestRelations(JSON.stringify({
      status: 'ok',
      message: {
        relation: {
          'is-supplemented-by': [{
            'id-type': 'doi',
            id: '10.5281/zenodo.20342806',
            'asserted-by': 'subject'
          }]
        }
      }
    }))).toEqual([{
      type: 'is-supplemented-by',
      idType: 'doi',
      id: '10.5281/zenodo.20342806'
    }]);
  });

  it('parses Crossref REST work metadata with raw message JSON for fixture capture', () => {
    const work = parseCrossrefRestWorkJson({
      status: 'ok',
      message: {
        DOI: '10.53832/opendeved.1205',
        type: 'report',
        title: ['Evidence report'],
        URL: 'https://docs.opendeved.net/lib/ABC12345',
        relation: {
          'is-supplemented-by': [{
            'id-type': 'doi',
            id: '10.5281/zenodo.20342806',
            'asserted-by': 'subject'
          }]
        }
      }
    });

    expect(work).toEqual({
      doi: '10.53832/opendeved.1205',
      type: 'report',
      title: ['Evidence report'],
      resourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      relations: [{
        type: 'is-supplemented-by',
        idType: 'doi',
        id: '10.5281/zenodo.20342806'
      }],
      raw: {
        DOI: '10.53832/opendeved.1205',
        type: 'report',
        title: ['Evidence report'],
        URL: 'https://docs.opendeved.net/lib/ABC12345',
        relation: {
          'is-supplemented-by': [{
            'id-type': 'doi',
            id: '10.5281/zenodo.20342806',
            'asserted-by': 'subject'
          }]
        }
      }
    });
  });
});
