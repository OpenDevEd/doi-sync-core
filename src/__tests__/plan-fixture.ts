import {
	planPublicationSync as planPublicationSyncAt,
	type PlanPublicationSyncInput
} from '../planner.js';

export const TEST_OBSERVED_AT = new Date('2026-05-20T00:00:00.000Z');

export function planPublicationSync(
	input: Omit<PlanPublicationSyncInput, 'observedAt'> & { readonly observedAt?: Date }
) {
	return planPublicationSyncAt({
		...input,
		observedAt: input.observedAt ?? TEST_OBSERVED_AT
	});
}
