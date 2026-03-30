import { DiscordAPIError, RateLimitError } from '@discordjs/rest';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';

const MAX_RETRY_WAIT_MS = 120_000;

/**
 * Délai d’attente avant une nouvelle tentative (429 / RateLimitError / corps API).
 * @param {unknown} err
 * @returns {number | null} ms, ou null pour utiliser un backoff par défaut
 */
export function getDiscordRetryWaitMs(err) {
  if (err instanceof RateLimitError && typeof err.retryAfter === 'number') {
    return Math.min(Math.max(err.retryAfter, 0), MAX_RETRY_WAIT_MS);
  }
  if (typeof err === 'object' && err !== null && 'rawError' in err) {
    const raw = /** @type {{ rawError?: { retry_after?: unknown } }} */ (err).rawError;
    if (
      raw
      && typeof raw === 'object'
      && 'retry_after' in raw
      && typeof raw.retry_after === 'number'
    ) {
      return Math.min(Math.ceil(raw.retry_after * 1000), MAX_RETRY_WAIT_MS);
    }
  }
  const st =
    typeof err === 'object' && err !== null && 'status' in err
      ? /** @type {{ status?: unknown }} */ (err).status
      : undefined;
  if (st === 429) return Math.min(5000, MAX_RETRY_WAIT_MS);
  return null;
}

/**
 * Délais entre tentatives (ms) : index = nombre d’échecs déjà enregistrés pour cette ligne.
 * - 0 : première mise en file (avant la 1re exécution du job)
 * - 1–4 : après chaque échec d’édition dans le job
 * - ≥5 : abandon (retour null)
 */
const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  60 * 60_000,
];

/**
 * @param {number} attemptCountAfterFailure
 * @returns {number | null} délai avant la prochaine tentative, ou null si abandon
 */
export function computeNextRetryDelayMs(attemptCountAfterFailure) {
  if (attemptCountAfterFailure >= 5) return null;
  return RETRY_DELAYS_MS[attemptCountAfterFailure];
}

/**
 * @typedef {{ kind: 'terminal' | 'retryable', code: string, message: string }} ClassifiedDiscordError
 */

/**
 * @param {unknown} err
 * @returns {ClassifiedDiscordError}
 */
export function classifyDiscordEditError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  const shortMsg = msg.slice(0, 500);

  if (err instanceof RateLimitError) {
    return {
      kind: 'retryable',
      code: 'RATE_LIMIT',
      message: shortMsg,
    };
  }

  /** JSON corrompu / parse invalide : erreur locale, pas de retry Discord. */
  if (err instanceof SyntaxError) {
    return {
      kind: 'terminal',
      code: 'JSON_SYNTAX',
      message: shortMsg,
    };
  }

  const rawCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? /** @type {{ code?: unknown }} */ (err).code
      : undefined;
  const numCode = typeof rawCode === 'number' ? rawCode : null;

  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? /** @type {{ status?: unknown }} */ (err).status
      : undefined;
  const numStatus = typeof status === 'number' ? status : null;

  const terminalCodes = new Set([
    RESTJSONErrorCodes.UnknownMessage,
    RESTJSONErrorCodes.UnknownChannel,
    RESTJSONErrorCodes.MissingAccess,
    RESTJSONErrorCodes.MissingPermissions,
  ]);

  if (numCode !== null && terminalCodes.has(numCode)) {
    return {
      kind: 'terminal',
      code: String(numCode),
      message: shortMsg,
    };
  }

  if (numCode === 429 || numStatus === 429) {
    return {
      kind: 'retryable',
      code: 'RATE_LIMIT',
      message: shortMsg,
    };
  }

  if (numStatus !== null && numStatus >= 500 && numStatus < 600) {
    return {
      kind: 'retryable',
      code: `HTTP_${numStatus}`,
      message: shortMsg,
    };
  }

  if (
    rawCode === 'ECONNRESET'
    || rawCode === 'ETIMEDOUT'
    || rawCode === 'ENOTFOUND'
    || rawCode === 'ECONNREFUSED'
    || rawCode === 'EAI_AGAIN'
  ) {
    return {
      kind: 'retryable',
      code: String(rawCode),
      message: shortMsg,
    };
  }

  if (err instanceof DiscordAPIError) {
    return {
      kind: 'retryable',
      code: numCode != null ? String(numCode) : 'DISCORD_API',
      message: shortMsg,
    };
  }

  return {
    kind: 'retryable',
    code: 'UNKNOWN',
    message: shortMsg,
  };
}
