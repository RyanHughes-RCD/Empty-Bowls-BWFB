/** Minimal RFC 4180 CSV writer with spreadsheet formula-injection protection. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Prevent CSV/formula injection when opened in Excel / Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: { key: string; label: string }[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map((h) => cell(h.label)).join(',')];
  for (const row of rows) lines.push(headers.map((h) => cell(row[h.key])).join(','));
  // BOM so Excel opens UTF-8 correctly
  return '﻿' + lines.join('\r\n') + '\r\n';
}
