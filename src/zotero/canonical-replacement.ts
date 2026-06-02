import { normalizeDoi } from '../doi.js';
import type { ZoteroParentItem, ZoteroRelations } from '../metadata.js';

export function isDeletedZoteroItem(item: ZoteroParentItem): boolean {
  return item.data.deleted === true || item.data.deleted === 1;
}

export function isValidCanonicalZoteroReplacement(input: {
  readonly originalItemKey: string;
  readonly recordDoi: string;
  readonly replacement: ZoteroParentItem;
}): boolean {
  if (isDeletedZoteroItem(input.replacement)) return false;
  if (normalizeDoi(input.replacement.data.DOI ?? input.replacement.data.doi) !== normalizeDoi(input.recordDoi)) return false;
  return relationReferencesItemKey(input.replacement.data.relations, 'dc:replaces', input.originalItemKey);
}

export function withCanonicalPublicUrl(parent: ZoteroParentItem, publicItemUrl: string): ZoteroParentItem {
  return {
    ...parent,
    data: {
      ...parent.data,
      url: publicItemUrl
    }
  };
}

function relationReferencesItemKey(
  relations: ZoteroRelations | null | undefined,
  relationName: string,
  itemKey: string
): boolean {
  const relation = relations?.[relationName];
  const values: readonly string[] = typeof relation === 'string'
    ? [relation]
    : relation ?? [];
  return values.some((value) => new RegExp(`/items/${escapeRegExp(itemKey)}$`).test(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
