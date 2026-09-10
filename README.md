# @opendeved/doi-sync-core

Provider-neutral Crossref and Zenodo publication planning, execution, and settlement for OpenDevEd services.

## Boundary

The core owns:

- normalized publication records, identifiers, target policies, and SHA-256 file manifests;
- independent Crossref and Zenodo planning;
- deterministic provider payload and file snapshots;
- provider clients, retries, journals, and last-success settlement; and
- browser-safe DOI display helpers on the `./display` export.

Host applications own:

- source adapters such as Zotero, Mendeley, or native database records;
- canonical records and published-file storage;
- file byte access through `PublicationFileReader`;
- durable jobs, leases, state persistence, credentials, scheduling, and UI; and
- source-system writeback after provider settlement.

The package does not infer source metadata, download from a specific storage provider, or perform source writeback.

## Minimal flow

1. Parse a canonical `PublicationRecordSnapshot`, `PublicationFileManifest`, and `PublicationTargetPolicy`.
2. Call `planPublicationSync` with the environment-scoped last-success state.
3. Provide durable `CrossrefSubmissionJournalWriter` and `ZenodoPublishJournalWriter` adapters whose callbacks commit before their promises resolve.
4. Render `describeDryRun`, or execute a write-required plan with `executeLivePublicationSyncPlan`; provider writes do not proceed past their journal boundary until that durable callback succeeds.
5. Apply the state patch returned by `settlePublicationSyncState` after execution. Published Zenodo journal identifiers and any orphan-cleanup marker must be exposed in the next `ProviderSyncState` until settlement clears them.

## Verification

Prerequisites are Node.js 22 or newer and [`uv`](https://docs.astral.sh/uv/getting-started/installation/). The XSD gate uses `uvx` to run the pinned `xmlschema==4.3.2` validator because the official Crossref 5.5 schema requires XSD 1.1.

```bash
npm install
npm run verify
```

Zenodo license validation uses a generated snapshot of the official Zenodo license vocabulary. Refresh it directly from Zenodo when that vocabulary changes:

```bash
npm run zenodo:licenses:generate
```
