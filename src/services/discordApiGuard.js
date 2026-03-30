import { logger } from '../utils/logger.js';
import {
  classifyDiscordEditError,
  getDiscordRetryWaitMs,
} from './discordRetryPolicy.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Logs détaillés file / API Discord (voir `.env` DISCORD_REQUEST_DEBUG).
 */
export function isDiscordRequestDebug() {
  const v = process.env.DISCORD_REQUEST_DEBUG?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 */
function parseMaxAttempts(raw, fallback) {
  const n = Number(raw?.trim());
  if (!Number.isFinite(n) || n < 1 || n > 10) return fallback;
  return Math.floor(n);
}

/**
 * Exécute une opération Discord avec retries bornés (429, 5xx, réseau, etc.).
 * Les erreurs « terminal » (permissions, ressource inconnue, etc.) ne sont pas reprises.
 *
 * @param {() => Promise<T>} fn
 * @param {{
 *   kind?: string,
 *   metadata?: Record<string, unknown>,
 *   maxAttempts?: number,
 * }} [opts]
 * @returns {Promise<T>}
 * @template T
 */
export async function runTransientDiscord(fn, opts = {}) {
  const {
    kind = 'discord_api',
    metadata = {},
    maxAttempts: maxAttemptsOpt,
  } = opts;

  const maxAttempts =
    maxAttemptsOpt
    ?? parseMaxAttempts(process.env.DISCORD_API_MAX_ATTEMPTS, 4);

  const debug = isDiscordRequestDebug();
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const t0 = Date.now();
    if (debug) {
      try {
        logger.info('discord_request_debug: début', {
          kind,
          attempt,
          max_attempts: maxAttempts,
          ...metadata,
        });
      } catch {
        /* ignore */
      }
    }
    try {
      const result = await fn();
      if (debug) {
        try {
          logger.info('discord_request_debug: succès', {
            kind,
            attempt,
            duration_ms: Date.now() - t0,
            ...metadata,
          });
        } catch {
          /* ignore */
        }
      }
      return result;
    } catch (err) {
      lastErr = err;
      const c = classifyDiscordEditError(err);
      if (c.kind === 'terminal') {
        if (debug) {
          try {
            logger.warn('discord_request_debug: erreur terminal', {
              kind,
              attempt,
              code: c.code,
              ...metadata,
            });
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
      if (attempt >= maxAttempts) {
        if (debug) {
          try {
            logger.warn('discord_request_debug: abandon après max tentatives', {
              kind,
              attempt,
              code: c.code,
              ...metadata,
            });
          } catch {
            /* ignore */
          }
        }
        throw err;
      }

      const explicit = getDiscordRetryWaitMs(err);
      const backoff = explicit ?? Math.min(1500 * (2 ** (attempt - 1)), 60_000);
      const is429 =
        c.code === 'RATE_LIMIT'
        || (typeof err === 'object'
          && err !== null
          && 'status' in err
          && /** @type {{ status?: number }} */ (err).status === 429);

      if (debug) {
        try {
          logger.warn('discord_request_debug: retry planifié', {
            kind,
            attempt,
            next_attempt: attempt + 1,
            wait_ms: backoff,
            retry_after_ms: explicit ?? null,
            rate_limit_429: is429,
            classified_code: c.code,
            ...metadata,
          });
        } catch {
          /* ignore */
        }
      }
      await sleep(backoff);
    }
  }
  throw lastErr;
}
