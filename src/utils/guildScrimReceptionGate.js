/**
 * Règle : configuration du salon de **réception** des scrims (pas /find-scrim).
 * Autorisation uniquement via validation manuelle (`guild_scrim_reception_bypass`).
 */

import { t } from '../i18n/index.js';

const SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK = 150;

const DEFAULT_TICKET_URL = 'https://discord.gg/dcjhQq5Ur9';

/**
 * Compatibilité — n'est plus utilisé pour autoriser la configuration réception.
 * Seuil effectif : `SCRIM_RECEPTION_MIN_MEMBERS` (entier > 0) ou 150 si absent / invalide.
 */
export function getScrimReceptionMinMembers() {
  const raw = process.env.SCRIM_RECEPTION_MIN_MEMBERS;
  if (raw === undefined || raw === null) return SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK;
  const s = String(raw).trim();
  if (!s) return SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return SCRIM_RECEPTION_MIN_MEMBERS_FALLBACK;
  }
  return n;
}

/**
 * @param {{ bypass_member_minimum?: number | null } | undefined} row
 */
export function isGuildReceptionBypassActive(row) {
  return Boolean(row && Number(row.bypass_member_minimum) === 1);
}

/**
 * @param {number | null | undefined} _memberCount Conservé pour compatibilité d'appel ; ignoré.
 * @param {{ bypass_member_minimum?: number | null } | undefined} bypassRow
 */
export function mayConfigureScrimReceptionChannel(_memberCount, bypassRow) {
  return isGuildReceptionBypassActive(bypassRow);
}

/**
 * Contenu du message de refus d'accès à la réception scrim.
 * Accepte optionnellement un traducteur (ex. createTranslator(locale)) pour localiser le message.
 * Si absent, utilise le français (fallback).
 *
 * @param {((key: string) => string) | undefined} [T] - Traducteur optionnel
 * @returns {string}
 */
export function buildScrimReceptionConfigRefusalContent(T) {
  const url = process.env.SCRIM_RECEPTION_TICKET_URL?.trim();
  const linkLine = url && /^https?:\/\//i.test(url) ? url : DEFAULT_TICKET_URL;
  const locale = T ? undefined : 'fr';
  const refusalBody = T
    ? T('gate.refusalBody')
    : t('fr', 'gate.refusalBody');
  return `${refusalBody}\n\n${linkLine}`;
}
