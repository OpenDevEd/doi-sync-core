import { describe, expect, it } from 'vitest';
import { buildZoteroGroupSelectUrl } from '../zotero/select-link.js';

describe('Zotero select links', () => {
  it('builds a group-library Zotero select URI for a parent item', () => {
    expect(buildZoteroGroupSelectUrl({
      groupId: '5724422',
      itemKey: 'XIABTVMX'
    })).toBe('zotero://select/groups/5724422/items/XIABTVMX');
  });

  it('encodes URI path components defensively', () => {
    expect(buildZoteroGroupSelectUrl({
      groupId: 'group/1',
      itemKey: 'ITEM 1'
    })).toBe('zotero://select/groups/group%2F1/items/ITEM%201');
  });
});
