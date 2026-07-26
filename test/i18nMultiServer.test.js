/**
 * Tests obligatoires — Annonces multi-serveurs avec locale par guilde (§15).
 *
 * Vérifie qu'une même recherche de scrim est rendue dans la langue du serveur destinataire :
 * - guilde A = fr → embed en français
 * - guilde B = en → embed en anglais
 *
 * Couvre :
 * - diffusion initiale (buildScrimEmbed)
 * - fermeture (buildScrimClosedMessageEditOptions)
 * - expiration (buildScrimClosedMessageEditOptions closed_expired)
 * - superseded/repost (buildScrimSupersededMessageEditOptions)
 * - même scrim_post_db_id, mêmes données métier, aucun mélange
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import {
  buildScrimEmbed,
  buildScrimClosedMessageEditOptions,
  buildScrimSupersededMessageEditOptions,
  buildScrimCommunityServerActionRows,
  scrimDbRowToEmbedPayload,
} from '../src/services/scrimEmbedBuilder.js';

// ─── Payload de test représentatif ──────────────────────────────────────────

const BASE_PAYLOAD = {
  gameKey: 'lol',
  rank: 'Diamant',
  dateStr: '23/07/2026',
  timeStr: '20h00',
  format: 'BO3',
  contactUserId: '111222333444555666',
  contactDisplayName: 'TestPlayer',
  multiOpggUrl: null,
  scheduledAtIso: null,
  scheduledAtEndIso: null,
  nombreDeGames: null,
  fearless: 'oui',
  eloPrecision: null,
  structureNameSnapshot: null,
  structureInviteUrl: null,
};

const BASE_DB_ROW = {
  id: 42,
  game_key: 'lol',
  rank_key: 'Diamant',
  scheduled_date: '23/07/2026',
  scheduled_time: '20h00',
  format_key: 'BO3',
  contact_user_id: '111222333444555666',
  multi_opgg_url: null,
  scheduled_at: null,
  scheduled_at_end: null,
  tags: '{"fearless":"oui"}',
  elo_precision: null,
  structure_name_snapshot: null,
  structure_invite_url_snapshot: null,
  status: 'closed_manual',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDescription(embed) {
  // EmbedBuilder toJSON().description
  return embed.toJSON().description ?? '';
}

// ─── Tests diffusion initiale ────────────────────────────────────────────────

describe('buildScrimEmbed — locale par serveur destinataire', () => {
  it('guilde A (fr) → texte Fearless en français', () => {
    const embed = buildScrimEmbed(BASE_PAYLOAD, 'fr');
    const desc = getDescription(embed);
    assert.match(desc, /Fearless : Oui/, 'Doit contenir "Fearless : Oui" (fr)');
  });

  it('guilde B (en) → texte Fearless en anglais', () => {
    const embed = buildScrimEmbed(BASE_PAYLOAD, 'en');
    const desc = getDescription(embed);
    assert.match(desc, /Fearless: Yes/, 'Doit contenir "Fearless: Yes" (en)');
  });

  it('mêmes données métier dans les deux langues', () => {
    const embedFr = buildScrimEmbed(BASE_PAYLOAD, 'fr');
    const embedEn = buildScrimEmbed(BASE_PAYLOAD, 'en');
    const descFr = getDescription(embedFr);
    const descEn = getDescription(embedEn);
    // FR affiche le rang en français, EN en anglais (même scrim, même rang DB)
    assert.match(descFr, /Diamant/, 'FR doit contenir "Diamant"');
    assert.match(descEn, /Diamond/, 'EN doit contenir "Diamond" (rang traduit)');
    assert.doesNotMatch(descEn, /Diamant/, 'EN ne doit pas contenir "Diamant"');
    // La date/heure identique
    assert.match(descFr, /23\/07\/2026/);
    assert.match(descEn, /23\/07\/2026/);
    // Le format BO3 identique
    assert.match(descFr, /BO3/);
    assert.match(descEn, /BO3/);
  });

  it('aucun mélange de langue dans les deux embeds', () => {
    const embedFr = buildScrimEmbed(BASE_PAYLOAD, 'fr');
    const embedEn = buildScrimEmbed(BASE_PAYLOAD, 'en');
    const descFr = getDescription(embedFr);
    const descEn = getDescription(embedEn);
    // FR ne doit pas contenir du texte anglais de Fearless
    assert.doesNotMatch(descFr, /Fearless: Yes/);
    // EN ne doit pas contenir du texte français de Fearless
    assert.doesNotMatch(descEn, /Fearless : Oui/);
  });
});

// ─── Tests contact hints ─────────────────────────────────────────────────────

describe('buildScrimEmbed — contact hints locale', () => {
  it('contact hints en français', () => {
    const embed = buildScrimEmbed(BASE_PAYLOAD, 'fr');
    const desc = getDescription(embed);
    assert.match(desc, /Si la mention du contact ci-dessus/);
  });

  it('contact hints en anglais', () => {
    const embed = buildScrimEmbed(BASE_PAYLOAD, 'en');
    const desc = getDescription(embed);
    assert.match(desc, /If the contact mention above/);
  });
});

// ─── Tests structure avec lien ───────────────────────────────────────────────

describe('buildScrimEmbed — structure label locale', () => {
  const payloadWithStructure = {
    ...BASE_PAYLOAD,
    structureNameSnapshot: 'Mon Équipe',
    structureInviteUrl: 'https://discord.gg/example',
  };

  it('structure fr → libellé français', () => {
    const embed = buildScrimEmbed(payloadWithStructure, 'fr');
    const desc = getDescription(embed);
    assert.match(desc, /🌐 Structure :/);
  });

  it('structure en → libellé anglais', () => {
    const embed = buildScrimEmbed(payloadWithStructure, 'en');
    const desc = getDescription(embed);
    assert.match(desc, /🌐 Structure:/);
  });
});

// ─── Tests bouton communauté ─────────────────────────────────────────────────

describe('buildScrimCommunityServerActionRows — locale', () => {
  const originalUrl = process.env.SCRIM_COMMUNITY_SERVER_URL;

  it('bouton en fr → label français', () => {
    process.env.SCRIM_COMMUNITY_SERVER_URL = 'https://discord.gg/test';
    try {
      const rows = buildScrimCommunityServerActionRows(null, 'fr');
      if (rows.length > 0) {
        const components = rows[0].toJSON().components;
        const btn = components?.[0];
        assert.match(btn?.label ?? '', /Rejoindre/);
      }
    } finally {
      if (originalUrl !== undefined) process.env.SCRIM_COMMUNITY_SERVER_URL = originalUrl;
      else delete process.env.SCRIM_COMMUNITY_SERVER_URL;
    }
  });

  it('bouton en en → label anglais', () => {
    process.env.SCRIM_COMMUNITY_SERVER_URL = 'https://discord.gg/test';
    try {
      const rows = buildScrimCommunityServerActionRows(null, 'en');
      if (rows.length > 0) {
        const components = rows[0].toJSON().components;
        const btn = components?.[0];
        assert.match(btn?.label ?? '', /Join/);
      }
    } finally {
      if (originalUrl !== undefined) process.env.SCRIM_COMMUNITY_SERVER_URL = originalUrl;
      else delete process.env.SCRIM_COMMUNITY_SERVER_URL;
    }
  });
});

// ─── Tests fermeture ────────────────────────────────────────────────────────

describe('buildScrimClosedMessageEditOptions — locale par serveur', () => {
  it('fermeture manuelle fr → embed en français', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr');
    const desc = opts.embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless : Oui/);
  });

  it('fermeture manuelle en → embed en anglais', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'en');
    const desc = opts.embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless: Yes/);
  });

  it('même scrim_db_row produit deux langues différentes', () => {
    const optsFr = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'fr');
    const optsEn = buildScrimClosedMessageEditOptions('closed_manual', BASE_DB_ROW, 'en');
    const descFr = optsFr.embeds[0].toJSON().description ?? '';
    const descEn = optsEn.embeds[0].toJSON().description ?? '';
    assert.notEqual(descFr, descEn, 'Les deux embeds doivent être différents (locales différentes)');
  });

  it('expiration fr → embed en français', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_expired', BASE_DB_ROW, 'fr');
    const desc = opts.embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless : Oui/);
  });

  it('expiration en → embed en anglais', () => {
    const opts = buildScrimClosedMessageEditOptions('closed_expired', BASE_DB_ROW, 'en');
    const desc = opts.embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless: Yes/);
  });
});

// ─── Tests superseded ───────────────────────────────────────────────────────

describe('buildScrimSupersededMessageEditOptions — locale par serveur', () => {
  it('superseded fr → embed en français', () => {
    const opts = buildScrimSupersededMessageEditOptions(BASE_DB_ROW, 'fr');
    const desc = opts.embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless : Oui/);
  });

  it('superseded en → embed en anglais', () => {
    const opts = buildScrimSupersededMessageEditOptions(BASE_DB_ROW, 'en');
    const desc = opts.embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless: Yes/);
  });
});

// ─── Test multi-guilde identique scrim_post_db_id ────────────────────────────

describe('multi-guilde — même scrim, langues différentes', () => {
  it('serveur fr et serveur en produisent deux embeds différents pour le même scrim', () => {
    // Simuler deux guildes avec le même scrim (même payload / db_row)
    const embedGuildeFr = buildScrimEmbed(BASE_PAYLOAD, 'fr');
    const embedGuildeEn = buildScrimEmbed(BASE_PAYLOAD, 'en');

    const descFr = getDescription(embedGuildeFr);
    const descEn = getDescription(embedGuildeEn);

    // Même scrim : FR montre le rang en français, EN en anglais
    assert.match(descFr, /Diamant/);
    assert.match(descEn, /Diamond/);

    // Langue différente sur le texte Fearless
    assert.match(descFr, /Fearless : Oui/);
    assert.match(descEn, /Fearless: Yes/);
    assert.notEqual(descFr, descEn);
  });

  it('serveur fr origin → serveur en destination : locale de destination appliquée', () => {
    // Même que ci-dessus : la locale du serveur destinataire prime
    const embedDest = buildScrimEmbed(BASE_PAYLOAD, 'en');
    const desc = getDescription(embedDest);
    assert.match(desc, /Fearless: Yes/);
    assert.doesNotMatch(desc, /Fearless : Oui/);
  });
});
