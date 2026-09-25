/**
 * Redirection dashboard pour la configuration serveur (Phase 0.5).
 *
 * - Aucun write DB
 * - URL = SCRIM_OFFICIAL_SITE_URL (source unique du projet)
 * - Textes / boutons via i18n
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { SCRIM_OFFICIAL_SITE_URL } from '../services/scrimEmbedBuilder.js';
import { getEmbedColorForGame } from '../config/gameEmbedColors.js';
import { UI_PRIMARY_GAME_KEY } from '../config/games.js';
import { normalizeLocale, t } from '../i18n/index.js';

/**
 * URL dashboard ScrimRéseau (constante officielle du projet).
 * @returns {string}
 */
export function getScrimDashboardConfigUrl() {
  return SCRIM_OFFICIAL_SITE_URL;
}

/**
 * Payload Discord ephemeral : embed + bouton URL (0 write).
 *
 * @param {string | null | undefined} localeRaw
 * @param {{ titleKey?: string, descriptionKey?: string, buttonKey?: string }} [keys]
 * @returns {{ embeds: EmbedBuilder[], components: import('discord.js').ActionRowBuilder[], flags: number }}
 */
export function buildConfigDashboardRedirectPayload(localeRaw, keys = {}) {
  const locale = normalizeLocale(localeRaw);
  const titleKey = keys.titleKey ?? 'scrimConfig.redirectTitle';
  const descriptionKey = keys.descriptionKey ?? 'scrimConfig.redirectDescription';
  const buttonKey = keys.buttonKey ?? 'scrimConfig.redirectButton';
  const url = getScrimDashboardConfigUrl();

  const embed = new EmbedBuilder()
    .setColor(getEmbedColorForGame(UI_PRIMARY_GAME_KEY))
    .setTitle(t(locale, titleKey))
    .setDescription(t(locale, descriptionKey));

  const button = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel(t(locale, buttonKey))
    .setURL(url);

  const row = new ActionRowBuilder().addComponents(button);

  return {
    embeds: [embed],
    components: [row],
    flags: MessageFlags.Ephemeral,
  };
}
