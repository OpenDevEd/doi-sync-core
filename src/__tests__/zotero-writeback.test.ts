import { describe, expect, it } from 'vitest';
import { parseManagedExtraIdentifiers, planZoteroDoiDriftAutofix, planZoteroWriteback } from '../zotero/writeback.js';

describe('Zotero writeback planning', () => {
  it('can intentionally overwrite drifted managed Zotero DOI fields for autofix mode', () => {
    const plan = planZoteroDoiDriftAutofix({
      itemVersion: 7,
      publicResourceUrl: 'https://docs.opendeved.net/lib/ABC12345',
      data: {
        DOI: '10.9999/wrong',
        extra: [
          'DOI: 10.9999/wrong',
          'previousDOI: 10.1111/old',
          'Notes: keep me'
        ].join('\n'),
        url: ''
      },
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205'
      }
    });

    expect(plan).toEqual({
      type: 'patch',
      ifUnmodifiedSinceVersion: 7,
      patch: {
        DOI: '10.53832/opendeved.1205',
        extra: [
          'Notes: keep me',
          'DOI: 10.53832/opendeved.1205',
          'previousDOI: 10.9999/wrong',
          'previousDOI: 10.1111/old',
          'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 10.9999/wrong 10.1111/old'
        ].join('\n'),
        url: 'https://docs.opendeved.net/lib/ABC12345'
      }
    });
  });

  it('preserves unrelated Extra lines and writes only managed identifiers', () => {
    const plan = planZoteroWriteback({
      itemVersion: 42,
      publicResourceUrl: 'my.educationevidence.io/lib/record/ABC12345',
      data: {
        DOI: '',
        extra: 'Reviewed by: Someone\nZenodoArchiveID: 500000\nNotes: keep',
        url: ''
      },
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '15043088',
        zenodoParentId: 'abcde-12345'
      }
    });

    expect(plan).toEqual({
      type: 'patch',
      ifUnmodifiedSinceVersion: 42,
      patch: {
        DOI: '10.53832/opendeved.1205',
        extra: [
          'Reviewed by: Someone',
          'Notes: keep',
          'DOI: 10.53832/opendeved.1205',
          'ZenodoArchiveID: 15043088',
          'previousZenodoArchiveID: 500000',
          'ZenodoArchiveConcept: abcde-12345',
          'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205'
        ].join('\n'),
        url: 'https://my.educationevidence.io/lib/record/ABC12345'
      }
    });
  });

  it('does not remove or rewrite worker-only Extra fields because old packages do not own them', () => {
    const plan = planZoteroWriteback({
      itemVersion: 42,
      data: {
        DOI: '10.53832/opendeved.1205',
        extra: [
          'ZenodoConceptDOI: 10.5281/zenodo.15043087',
          'ZenodoVersionDOI: 10.5281/zenodo.15043088',
          'MEEExternalSync: old-worker',
          'DOI: 10.53832/opendeved.old',
          'previousDOI: 10.53832/opendeved.older',
          'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.external',
          'ZenodoArchiveID: 500000',
          'ZenodoArchiveConcept: old'
        ].join('\n')
      },
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205',
        zenodoLatestRecordId: '15043088',
        zenodoParentId: '15043087'
      }
    });

    expect(plan).toEqual({
      type: 'patch',
      ifUnmodifiedSinceVersion: 42,
      patch: {
        extra: [
          'ZenodoConceptDOI: 10.5281/zenodo.15043087',
          'ZenodoVersionDOI: 10.5281/zenodo.15043088',
          'MEEExternalSync: old-worker',
          'DOI: 10.53832/opendeved.1205',
          'previousDOI: 10.53832/opendeved.old',
          'previousDOI: 10.53832/opendeved.older',
          'ZenodoArchiveID: 15043088',
          'previousZenodoArchiveID: 500000',
          'ZenodoArchiveConcept: 15043087',
          'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 10.53832/opendeved.old 10.53832/opendeved.older 10.53832/opendeved.external'
        ].join('\n')
      }
    });
  });

  it('preserves every DOI token from a multi-value previousDOI line', () => {
    const plan = planZoteroWriteback({
      itemVersion: 42,
      data: {
        DOI: '10.53832/opendeved.1205',
        extra: 'previousDOI: 10.53832/opendeved.old 10.53832/opendeved.older'
      },
      identifiers: {
        crossrefDoi: '10.53832/opendeved.1205'
      }
    });

    expect(plan).toEqual({
      type: 'patch',
      ifUnmodifiedSinceVersion: 42,
      patch: {
        extra: [
          'DOI: 10.53832/opendeved.1205',
          'previousDOI: 10.53832/opendeved.old',
          'previousDOI: 10.53832/opendeved.older',
          'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 10.53832/opendeved.old 10.53832/opendeved.older'
        ].join('\n')
      }
    });
  });

  it('parses old-package Zenodo archive identifiers from Zotero Extra for crash recovery', () => {
    expect(parseManagedExtraIdentifiers([
      'Reviewed by: Someone',
      'ZenodoArchiveID: 502441',
      'ZenodoArchiveConcept: 502439',
      'DOI: 10.53832/opendeved.1205'
    ].join('\n'))).toEqual({
      zenodoLatestRecordId: '502441',
      zenodoParentId: '502439'
    });
  });

  describe('Invalid ZenodoArchiveID handling', () => {
    it('drops a junk ZenodoArchiveID: 0 instead of demoting it to previousZenodoArchiveID', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '',
          extra: 'ZenodoArchiveID: 0\nDOI: 10.53832/opendeved.1205',
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205',
          zenodoLatestRecordId: '700000'
        }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : '';
      const lines = extra.split('\n');
      expect(lines).toContain('ZenodoArchiveID: 700000');
      expect(lines.some((line) => line.startsWith('previousZenodoArchiveID:'))).toBe(false);
    });

    it('also drops non-numeric or negative legacy ZenodoArchiveID values', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '',
          extra: 'ZenodoArchiveID: not-an-id\npreviousZenodoArchiveID: -42\nDOI: 10.53832/opendeved.1205',
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205',
          zenodoLatestRecordId: '700000'
        }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : '';
      const lines = extra.split('\n');
      expect(lines.some((line) => line.startsWith('previousZenodoArchiveID:'))).toBe(false);
    });

    it('parser ignores ZenodoArchiveID: 0 and uses legacy fallback when present', () => {
      expect(parseManagedExtraIdentifiers([
        'ZenodoArchiveID: 0',
        'Archive: https://zenodo.org/record/12345'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '12345' });
    });

    it('parser also rejects ZenodoArchiveConcept: 0', () => {
      expect(parseManagedExtraIdentifiers([
        'ZenodoArchiveID: 700000',
        'ZenodoArchiveConcept: 0'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '700000' });
    });
  });

  describe('ZenodoArchiveID history preservation', () => {
    it('demotes a prior ZenodoArchiveID to previousZenodoArchiveID when a newer one is written', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '',
          extra: 'ZenodoArchiveID: 502441\nDOI: 10.53832/opendeved.1205',
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205',
          zenodoLatestRecordId: '700000'
        }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : '';
      expect(extra.split('\n')).toEqual(expect.arrayContaining([
        'ZenodoArchiveID: 700000',
        'previousZenodoArchiveID: 502441'
      ]));
    });

    it('preserves the full previous-archive history across multiple version bumps', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '',
          extra: [
            'DOI: 10.53832/opendeved.1205',
            'ZenodoArchiveID: 800000',
            'previousZenodoArchiveID: 500000',
            'previousZenodoArchiveID: 600000'
          ].join('\n'),
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205',
          zenodoLatestRecordId: '900000'
        }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : '';
      const lines = extra.split('\n');
      expect(lines).toContain('ZenodoArchiveID: 900000');
      expect(lines).toContain('previousZenodoArchiveID: 800000');
      expect(lines).toContain('previousZenodoArchiveID: 500000');
      expect(lines).toContain('previousZenodoArchiveID: 600000');
    });

    it('converts a legacy Archive URL into previousZenodoArchiveID when writing a newer Zenodo id', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '',
          extra: [
            'Archive: https://zenodo.org/record/502441',
            'DOI: 10.53832/opendeved.1205'
          ].join('\n'),
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205',
          zenodoLatestRecordId: '700000'
        }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : '';
      const lines = extra.split('\n');
      expect(lines).toContain('ZenodoArchiveID: 700000');
      expect(lines).toContain('previousZenodoArchiveID: 502441');
      expect(lines.some((line) => line.startsWith('Archive:'))).toBe(false);
    });

    it('does not duplicate the current ZenodoArchiveID into previousZenodoArchiveID on no-op rewrites', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '10.53832/opendeved.1205',
          extra: [
            'DOI: 10.53832/opendeved.1205',
            'ZenodoArchiveID: 700000',
            'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205'
          ].join('\n'),
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205',
          zenodoLatestRecordId: '700000'
        }
      });

      expect(plan.type).toBe('noop');
    });
  });

  describe('KerkoCite non-DOI token preservation', () => {
    it('preserves existing groupId:itemKey tokens (and unknown tokens) in the KerkoCite line', () => {
      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: {
          DOI: '',
          extra: 'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 2129771:ABCD1234 some-opaque-token',
          url: ''
        },
        identifiers: {
          crossrefDoi: '10.53832/opendeved.1205'
        }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : '';
      const kerkoLine = extra.split('\n').find((line) => line.startsWith('KerkoCite.ItemAlsoKnownAs:'));
      expect(kerkoLine).toBe('KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 2129771:ABCD1234 some-opaque-token');
    });

    it('does not duplicate existing non-DOI tokens on rewrite', () => {
      const initialExtra = [
        'DOI: 10.53832/opendeved.1205',
        'KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 2129771:ABCD1234'
      ].join('\n');

      const plan = planZoteroWriteback({
        itemVersion: 1,
        data: { DOI: '', extra: initialExtra, url: '' },
        identifiers: { crossrefDoi: '10.53832/opendeved.1205' }
      });

      const extra = plan.type === 'patch' ? plan.patch.extra : initialExtra;
      const kerkoLines = extra.split('\n').filter((line) => line.startsWith('KerkoCite.ItemAlsoKnownAs:'));
      expect(kerkoLines).toEqual(['KerkoCite.ItemAlsoKnownAs: 10.53832/opendeved.1205 2129771:ABCD1234']);
    });
  });

  describe('legacy Extra-line Zenodo identifier recovery', () => {
    it('falls back to `Archive: https://zenodo.org/record/<N>` when ZenodoArchiveID is absent', () => {
      expect(parseManagedExtraIdentifiers([
        'Reviewed by: Someone',
        'Archive: https://zenodo.org/record/502441',
        'DOI: 10.53832/opendeved.1205'
      ].join('\n'))).toEqual({
        zenodoLatestRecordId: '502441'
      });
    });

    it('recognizes sandbox Archive URLs (sandbox.zenodo.org and /records/ plural)', () => {
      expect(parseManagedExtraIdentifiers([
        'Archive: https://sandbox.zenodo.org/records/123456'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '123456' });
    });

    it('falls back to Zenodo DOI (10.5281/zenodo.<N>) in DOI: line', () => {
      expect(parseManagedExtraIdentifiers([
        'DOI: 10.5281/zenodo.700000'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '700000' });
    });

    it('recognizes sandbox Zenodo DOIs (10.5072/zenodo.<N>)', () => {
      expect(parseManagedExtraIdentifiers([
        'DOI: 10.5072/zenodo.42'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '42' });
    });

    it('selects the maximum Zenodo id across DOI:, previousDOI:, and Archive: lines', () => {
      expect(parseManagedExtraIdentifiers([
        'DOI: 10.5281/zenodo.100',
        'previousDOI: 10.5281/zenodo.500',
        'Archive: https://zenodo.org/record/300'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '500' });
    });

    it('prefers explicit ZenodoArchiveID over legacy fallbacks', () => {
      expect(parseManagedExtraIdentifiers([
        'ZenodoArchiveID: 999',
        'Archive: https://zenodo.org/record/500',
        'DOI: 10.5281/zenodo.700'
      ].join('\n'))).toEqual({ zenodoLatestRecordId: '999' });
    });

    it('ignores non-Zenodo DOIs in DOI/previousDOI lines', () => {
      expect(parseManagedExtraIdentifiers([
        'DOI: 10.53832/opendeved.1205',
        'previousDOI: 10.1000/example.42'
      ].join('\n'))).toEqual({});
    });
  });
});
