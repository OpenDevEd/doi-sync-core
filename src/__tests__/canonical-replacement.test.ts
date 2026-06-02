import { describe, expect, it } from 'vitest';
import { isDeletedZoteroItem, isValidCanonicalZoteroReplacement, withCanonicalPublicUrl } from '../zotero/canonical-replacement.js';
import type { ZoteroParentItem } from '../metadata.js';

const replacement: ZoteroParentItem = {
  key: 'NEWITEM1',
  version: 3,
  data: {
    itemType: 'report',
    DOI: '10.53832/opendeved.1205',
    relations: {
      'dc:replaces': 'https://api.zotero.org/groups/123/items/OLDITEM1'
    }
  }
};

describe('canonical Zotero replacement helpers', () => {
  it('accepts a non-deleted replacement that keeps the same DOI and replaces the original item', () => {
    expect(isValidCanonicalZoteroReplacement({
      originalItemKey: 'OLDITEM1',
      recordDoi: 'https://doi.org/10.53832/OpenDevEd.1205',
      replacement
    })).toBe(true);
  });

  it('rejects deleted replacements and unrelated replacement relations', () => {
    expect(isDeletedZoteroItem({ ...replacement, data: { ...replacement.data, deleted: 1 } })).toBe(true);
    expect(isValidCanonicalZoteroReplacement({
      originalItemKey: 'OTHER123',
      recordDoi: '10.53832/opendeved.1205',
      replacement
    })).toBe(false);
  });

  it('applies the canonical public URL without changing provider fields', () => {
    expect(withCanonicalPublicUrl(replacement, 'https://my.educationevidence.io/lib/NEWITEM1')).toMatchObject({
      key: 'NEWITEM1',
      version: 3,
      data: {
        DOI: '10.53832/opendeved.1205',
        url: 'https://my.educationevidence.io/lib/NEWITEM1'
      }
    });
  });
});
