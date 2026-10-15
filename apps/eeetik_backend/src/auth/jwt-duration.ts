const UNIT_MULTIPLIERS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
};

/**
 * Parses JWT expiry expressions like `7d`, `12h`, `30m`, `3600` into
 * whole seconds. Falls back to `fallbackSeconds` for anything unparsable.
 */
export function parseJwtExpiresInSeconds(
  raw: string | undefined,
  fallbackSeconds: number,
): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallbackSeconds;
  }

  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw.trim());
  if (!match) {
    return fallbackSeconds;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallbackSeconds;
  }

  const unit = (match[2] ?? 's').toLowerCase();
  return value * (UNIT_MULTIPLIERS[unit] ?? 1);
}
