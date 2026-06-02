import { buildIntendedDiff, type IntendedDiff } from './intended-diff.js';
import type { ExternalSyncState, DoiSyncRecord, SyncPlan, SyncPolicy } from './planner.js';
import { planRecordSync } from './planner.js';
import type { ZoteroChildItem } from './files.js';
import type { ZoteroParentItem } from './metadata.js';
import { buildZoteroGroupSelectUrl } from './zotero/select-link.js';

export interface PrepareDoiSyncInput {
  readonly record: DoiSyncRecord;
  readonly zoteroItem: ZoteroParentItem;
  readonly zoteroChildren: readonly ZoteroChildItem[];
  readonly state?: ExternalSyncState;
  readonly policy: SyncPolicy;
  readonly resourceUrl: string;
  readonly zenodoBaseUrl: string;
  readonly zoteroGroupId?: string;
}

export interface PreparedDoiSync {
  readonly plan: SyncPlan;
  readonly intendedDiff: IntendedDiff;
  readonly zoteroSelectUrl?: string;
}

/** Prepares a sync plan, intended diff, and optional Zotero select URL for one record. */
export function prepareDoiSync(input: PrepareDoiSyncInput): PreparedDoiSync {
  const zoteroSelectUrl = input.zoteroGroupId
    ? buildZoteroGroupSelectUrl({ groupId: input.zoteroGroupId, itemKey: input.record.zoteroItemKey })
    : undefined;

  const plan = planRecordSync({
    record: input.record,
    zoteroItem: input.zoteroItem,
    zoteroChildren: input.zoteroChildren,
    policy: input.policy,
    resourceUrl: input.resourceUrl,
    zenodoBaseUrl: input.zenodoBaseUrl,
    ...(input.state ? { state: input.state } : {}),
    ...(zoteroSelectUrl ? { zoteroSelectUrl } : {})
  });

  const intendedDiff = buildIntendedDiff({
    plan,
    ...(input.state ? { state: input.state } : {}),
    record: input.record,
    resourceUrl: input.resourceUrl,
    zoteroParent: input.zoteroItem,
    zoteroChildren: input.zoteroChildren,
    doiPolicy: input.policy.doiPolicy,
    zenodoBaseUrl: input.zenodoBaseUrl,
    ...(zoteroSelectUrl ? { zoteroSelectUrl } : {})
  });

  return {
    plan,
    intendedDiff,
    ...(zoteroSelectUrl ? { zoteroSelectUrl } : {})
  };
}
