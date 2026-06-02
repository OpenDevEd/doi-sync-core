import type { ZoteroChildItem } from './files.js';
import type { ZoteroParentItem } from './metadata.js';

export interface ZoteroReader {
  readonly readParentAndChildren: (input: {
    readonly groupId: string;
    readonly apiKey: string;
    readonly itemKey: string;
  }) => Promise<{
    readonly parent: ZoteroParentItem;
    readonly children: readonly ZoteroChildItem[];
  }>;
}

export interface CanonicalZoteroItemKeyResolver {
  readonly resolveCanonicalItemKey: (input: {
    readonly publicItemUrl: string;
    readonly originalItemKey: string;
  }) => Promise<{
    readonly itemKey: string;
    readonly publicItemUrl: string;
  } | null>;
}
