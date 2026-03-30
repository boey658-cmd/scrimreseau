/** Identifiant développeur Discord attendu dans BOT_DEV_ID (snowflake numérique). */
const BOT_DEV_SNOWFLAKE_RE = /^\d{17,22}$/;

export const MSG_BOT_DEV_UNCONFIGURED =
  '❌ Commande indisponible : BOT_DEV_ID n’est pas configuré.';

export const MSG_BOT_DEV_FORBIDDEN =
  '❌ Cette commande est réservée au développeur du bot.';

/**
 * @returns {{ ok: true, devId: string } | { ok: false, reason: 'missing' | 'invalid' }}
 */
export function resolveBotDevId() {
  const raw = process.env.BOT_DEV_ID;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { ok: false, reason: 'missing' };
  }
  if (!BOT_DEV_SNOWFLAKE_RE.test(trimmed)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, devId: trimmed };
}
