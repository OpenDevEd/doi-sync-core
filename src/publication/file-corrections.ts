import { z } from 'zod';

export const ZENODO_FILE_CORRECTION_START_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const ZENODO_FILE_CORRECTION_COMPLETE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

export interface ZenodoFileCorrectionApproval {
  readonly id: string;
  readonly kind: 'minor_correction';
  readonly recordKey: string;
  readonly doi: string;
  readonly fileManifestHash: string;
  readonly approvedAt: Date;
}

export const zenodoFileCorrectionApprovalSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('minor_correction'),
  recordKey: z.string().min(1),
  doi: z.string().min(1),
  fileManifestHash: z.string().min(1),
  approvedAt: z.coerce.date()
}).strict();

export function zenodoFileCorrectionStartDeadline(firstPublishedAt: Date): Date {
  return new Date(firstPublishedAt.getTime() + ZENODO_FILE_CORRECTION_START_WINDOW_MS);
}

export function zenodoFileCorrectionPublishDeadline(firstPublishedAt: Date): Date {
  return new Date(firstPublishedAt.getTime() + ZENODO_FILE_CORRECTION_COMPLETE_WINDOW_MS);
}
