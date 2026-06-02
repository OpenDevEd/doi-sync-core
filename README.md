# @opendeved/doi-sync-core

Pure DOI sync logic for Zotero, Crossref, and Zenodo.

This package is intended to replace the reusable parts of the old `zotero-lib`,
`zenodo-lib`, and `zotzen-lib` packages. It deliberately does not own runtime
state.

## Boundary

This package owns:

- Zotero item/file parsing and managed Zotero decorations.
- Crossref XML, deposit request construction, and Crossref API clients.
- Zenodo metadata payloads, identifiers, record clients, and version flows.
- Pure sync planning, payload snapshots, intended diffs, and state settlement.

The worker owns:

- MEE database reads.
- Worker DB state storage, leases, and migrations.
- Clerk organization credential lookup.
- Cron/CLI execution.
- Discord notifications.
- Environment parsing.

## Verification

```bash
npm install
npm run verify
```
