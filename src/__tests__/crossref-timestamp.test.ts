import { describe, expect, it } from 'vitest';
import { crossrefDepositTimestamp } from '../crossref/timestamp.js';

describe('crossrefDepositTimestamp', () => {
  it('formats UTC timestamps with milliseconds so redeposits advance existing Crossref versions', () => {
    expect(crossrefDepositTimestamp(new Date('2026-05-21T15:22:26.123Z'))).toBe('20260521152226123');
  });

  it('keeps millisecond precision for multiple deposits in the same second', () => {
    expect(crossrefDepositTimestamp(new Date('2026-05-21T15:22:26.001Z'))).toBe('20260521152226001');
    expect(crossrefDepositTimestamp(new Date('2026-05-21T15:22:26.999Z'))).toBe('20260521152226999');
  });
});
