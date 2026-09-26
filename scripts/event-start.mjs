// Accept only complete timestamps with an explicit offset; never guess a timezone.
export function canonicalStart(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error('Event start must include a time and timezone offset.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid event start timestamp.');
  return parsed.toISOString();
}

export function importedStart(row, dateOnly) {
  return canonicalStart(row.starts_at) || (dateOnly ? `${dateOnly}T00:00:00Z` : null);
}
