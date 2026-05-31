/**
 * Configuration salon réception Recherche Joueur — même validation manuelle que les scrims
 * (`guild_scrim_reception_bypass`, géré via `/scrim-dev guild-access`).
 */
import { isGuildReceptionBypassActive } from './guildScrimReceptionGate.js';

const DEFAULT_TICKET_URL = 'https://discord.gg/dcjhQq5Ur9';

const REFUSAL_BODY =
  '🔒 La réception des recherches joueur ScrimRéseau est activée manuellement afin de garder un réseau propre et actif.\n\n' +
  'Pour demander l\'accès :\n' +
  '• ouvrez un ticket sur le Discord ScrimRéseau\n' +
  '• envoyez le lien de votre serveur\n' +
  '• indiquez le salon prévu pour les recherches joueur\n\n' +
  'Une fois validé, votre serveur pourra recevoir automatiquement les recherches joueur du réseau directement chez vous 🙂';

/**
 * @param {{ bypass_member_minimum?: number | null } | undefined} bypassRow
 * @returns {boolean}
 */
export function mayConfigurePlayerSearchReceptionChannel(bypassRow) {
  return isGuildReceptionBypassActive(bypassRow);
}

/**
 * Dernière ligne : `PLAYER_SEARCH_RECEPTION_TICKET_URL` si défini (HTTPS),
 * sinon `SCRIM_RECEPTION_TICKET_URL`, sinon invite par défaut.
 */
export function buildPlayerSearchReceptionConfigRefusalContent() {
  const playerUrl = process.env.PLAYER_SEARCH_RECEPTION_TICKET_URL?.trim();
  if (playerUrl && /^https?:\/\//i.test(playerUrl)) {
    return `${REFUSAL_BODY}\n\n${playerUrl}`;
  }
  const scrimUrl = process.env.SCRIM_RECEPTION_TICKET_URL?.trim();
  if (scrimUrl && /^https?:\/\//i.test(scrimUrl)) {
    return `${REFUSAL_BODY}\n\n${scrimUrl}`;
  }
  return `${REFUSAL_BODY}\n\n${DEFAULT_TICKET_URL}`;
}
