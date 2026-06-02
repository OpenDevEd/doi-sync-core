/** Zotero tag marking an item or attachment whose DOI/archive sync has completed. */
export const ZOTERO_DOI_LIVE_TAG = '_DOILIVE';
/** Zotero tag marking an attachment uploaded to Zenodo. */
export const ZOTERO_ZENODO_UPLOADED_TAG = '_zenodo:uploaded';
/** Zotero tag marking a parent item submitted to Zenodo. */
export const ZOTERO_ZENODO_SUBMITTED_TAG = '_zenodo:submitted';

export interface ZoteroSuccessTagPlanInput {
  readonly parentItemKey: string;
  readonly zenodoSubmitted: boolean;
  readonly uploadedAttachmentKeys: readonly string[];
}

export interface ZoteroSuccessTagApplication {
  readonly itemKey: string;
  readonly tags: readonly string[];
}

/** Plans legacy-compatible Zotero success tags after successful provider operations. */
export function planZoteroSuccessTagApplications(input: ZoteroSuccessTagPlanInput): readonly ZoteroSuccessTagApplication[] {
  const applications: ZoteroSuccessTagApplication[] = [{
    itemKey: input.parentItemKey,
    tags: input.zenodoSubmitted
      ? [ZOTERO_DOI_LIVE_TAG, ZOTERO_ZENODO_SUBMITTED_TAG]
      : [ZOTERO_DOI_LIVE_TAG]
  }];

  for (const itemKey of uniqueStrings(input.uploadedAttachmentKeys)) {
    applications.push({
      itemKey,
      tags: [ZOTERO_DOI_LIVE_TAG, ZOTERO_ZENODO_UPLOADED_TAG]
    });
  }

  return applications;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
