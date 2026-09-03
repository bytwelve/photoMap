function padded(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function formatFileCreatedAt(fileCreatedAtMs?: number): string {
  if (fileCreatedAtMs === undefined || !Number.isFinite(fileCreatedAtMs)) return '—';
  const createdAt = new Date(fileCreatedAtMs);
  if (Number.isNaN(createdAt.getTime())) return '—';
  return [
    `${padded(createdAt.getFullYear(), 4)}-${padded(createdAt.getMonth() + 1)}-${padded(createdAt.getDate())}`,
    `${padded(createdAt.getHours())}:${padded(createdAt.getMinutes())}`,
  ].join(' ');
}
