export function buildZoteroGroupSelectUrl(input: {
  readonly groupId: string;
  readonly itemKey: string;
}): string {
  return `zotero://select/groups/${encodeURIComponent(input.groupId)}/items/${encodeURIComponent(input.itemKey)}`;
}
