export function crossrefDepositTimestamp(date: Date): string {
  return date.toISOString().replace(/\D/g, '').slice(0, 17);
}
