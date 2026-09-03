import type { CaptureTime } from '../../../shared/contracts';

export function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export function stringValue(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}

export function nullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  // SQLite hands back an untyped column value; coercing defensively is the point of this
  // helper, and a schema mismatch should surface as a visible string rather than throw.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return value === null || value === undefined ? null : String(value);
}

export function nullableNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : Number(value);
}

export function captureTimeFromRow(row: Record<string, unknown>): CaptureTime | null {
  const localDateTime = nullableString(row, 'capture_time_local');
  const source = nullableString(row, 'capture_time_source');
  if (localDateTime === null || (source !== 'metadata' && source !== 'user')) return null;
  return {
    localDateTime,
    offsetMinutes: nullableNumber(row, 'capture_time_offset_minutes'),
    source,
  };
}
