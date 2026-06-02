const CROSSREF_CONTRIBUTOR_ROLES = new Set([
  'author',
  'chair',
  'editor',
  'reader',
  'review-assistant',
  'reviewer',
  'reviewer-external',
  'stats-reviewer',
  'translator'
]);

export function crossrefContributorRole(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? '';
  return CROSSREF_CONTRIBUTOR_ROLES.has(normalized) ? normalized : 'author';
}
