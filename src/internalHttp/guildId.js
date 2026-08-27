/** Snowflake Discord — toujours traité comme string. */
export const GUILD_ID_PATTERN = /^\d{17,20}$/;

/**
 * @param {string | undefined | null} raw
 * @returns {string | null} guild id valide ou null
 */
export function parseGuildIdParam(raw) {
  if (raw == null || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!GUILD_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}
