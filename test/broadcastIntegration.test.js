/**
 * Test d'intégration — broadcastScrimRequest → getGuildLocale depuis DB → embeds par guilde
 *
 * But : démontrer que la locale est résolue par le SERVICE depuis la DB,
 * et non injectée par le test. Un test de mutation (getGuildLocale forcé à 'fr')
 * doit faire échouer ce fichier.
 *
 * Scénario :
 *   - guilde A configurée 'fr' → embed français
 *   - guilde B configurée 'en' → embed anglais
 *   - guilde C sans ligne guild_languages → fallback français
 *
 * Architecture traversée :
 *   DB temporaire
 *   → stmts.upsertGuildLanguage (config initiale)
 *   → broadcastScrimRequest (service de production)
 *   → getGuildLocale(row.guild_id, stmts) [appelé DANS le service, pas injecté]
 *   → buildScrimEmbed(payload, guildLocale)
 *   → channel.send(payload)   [capturé par mock]
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after, describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { broadcastScrimRequest } from '../src/services/broadcast.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';

// ---------------------------------------------------------------------------
// Identifiants stables de test
// ---------------------------------------------------------------------------

const GUILD_FR  = '111000000000000001'; // configurée fr
const GUILD_EN  = '222000000000000002'; // configurée en
const GUILD_DEF = '333000000000000003'; // pas de ligne → fallback fr
const CHAN_FR    = '444000000000000001';
const CHAN_EN    = '444000000000000002';
const CHAN_DEF   = '444000000000000003';
const AUTHOR_ID  = '999888777666555444';

/**
 * Payload de test : Platine + Fearless oui + juillet (CEST).
 * Les valeurs internes ne sont pas modifiées — seul le rendu change.
 */
const SCRIM_PAYLOAD = {
  gameKey:              'lol',
  rank:                 'Platine',
  dateStr:              '27/07/2026',
  timeStr:              '21h00',
  format:               'BO3',
  nombreDeGames:        null,
  fearless:             'oui',
  eloPrecision:         null,
  contactUserId:        '555444333222111000',
  contactDisplayName:   'TestContact',
  multiOpggUrl:         null,
  scheduledAtIso:       '2026-07-27T19:00:00.000Z', // → 21:00 Paris CEST
  scheduledAtEndIso:    null,
  structureNameSnapshot: null,
  structureInviteUrl:   null,
};

// ---------------------------------------------------------------------------
// Helpers de mock Discord
// ---------------------------------------------------------------------------

/** Construit un mock de salon qui capture les payloads envoyés. */
function buildMockChannel(channelId, captureArray) {
  const perms = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return {
    id: channelId,
    type: ChannelType.GuildText,
    permissionsFor: () => perms,
    send: async (payload) => {
      captureArray.push(payload);
      return { id: `msg-${channelId}-${Date.now()}` };
    },
  };
}

/** Construit un mock de guilde contenant un seul salon. */
function buildMockGuild(guildId, channelId, captureArray) {
  const channel = buildMockChannel(channelId, captureArray);
  const botMember = { id: 'bot-scrim-000' };
  return {
    id: guildId,
    channels: { cache: new Map([[channelId, channel]]) },
    members: {
      me: botMember,
      fetchMe: async () => botMember,
    },
  };
}

// ---------------------------------------------------------------------------
// Suite principale
// ---------------------------------------------------------------------------

describe('broadcastScrimRequest — intégration DB → getGuildLocale → embeds localisés', () => {
  let tempDir;
  let prevSqlitePath;
  let prevQueueDelay;

  // Captures : un tableau par guilde
  const sentFr  = [];
  const sentEn  = [];
  const sentDef = [];

  before(async () => {
    // ── DB temporaire ────────────────────────────────────────────────────────
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-broadcast-int-'));
    prevSqlitePath = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = path.join(tempDir, 'test.db');

    const db = getDb();
    const stmts = prepareStatements(db);

    // Configurer les langues dans la DB (pas dans le test → dans le service)
    stmts.upsertGuildLanguage.run(GUILD_FR, 'fr');
    stmts.upsertGuildLanguage.run(GUILD_EN, 'en');
    // GUILD_DEF : aucune ligne insérée intentionnellement → fallback français

    // ── File Discord : délai 0 pour les tests ───────────────────────────────
    prevQueueDelay = process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();

    // ── Mock Discord client ──────────────────────────────────────────────────
    const guildFr  = buildMockGuild(GUILD_FR,  CHAN_FR,  sentFr);
    const guildEn  = buildMockGuild(GUILD_EN,  CHAN_EN,  sentEn);
    const guildDef = buildMockGuild(GUILD_DEF, CHAN_DEF, sentDef);

    const guildCache = new Map([
      [GUILD_FR,  guildFr],
      [GUILD_EN,  guildEn],
      [GUILD_DEF, guildDef],
    ]);

    const client = {
      guilds: { cache: { get: (id) => guildCache.get(id) ?? null } },
    };

    // ── Appel au service de production ──────────────────────────────────────
    // IMPORTANT : aucun paramètre "locale" n'est passé aux rows.
    // La locale est résolue par broadcastScrimRequest via getGuildLocale(row.guild_id, stmts).
    const rows = [
      { guild_id: GUILD_FR,  channel_id: CHAN_FR  },
      { guild_id: GUILD_EN,  channel_id: CHAN_EN  },
      { guild_id: GUILD_DEF, channel_id: CHAN_DEF },
    ];

    await broadcastScrimRequest({
      client,
      rows,
      stmts,
      authorUserId:  AUTHOR_ID,
      scrimPostDbId: 42,
      payload:       SCRIM_PAYLOAD,
    });
  });

  after(async () => {
    await stopDiscordTaskQueue();
    closeDb();
    if (prevSqlitePath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prevSqlitePath;
    if (prevQueueDelay === undefined) delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    else process.env.DISCORD_TASK_QUEUE_DELAY_MS = prevQueueDelay;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Vérification du volume d'envoi ────────────────────────────────────────

  it('chaque guilde reçoit exactement un message (pas de double diffusion)', () => {
    assert.strictEqual(sentFr.length,  1, 'guilde FR doit recevoir 1 message');
    assert.strictEqual(sentEn.length,  1, 'guilde EN doit recevoir 1 message');
    assert.strictEqual(sentDef.length, 1, 'guilde sans config doit recevoir 1 message');
  });

  // ── Guilde FR ─────────────────────────────────────────────────────────────

  it('guilde FR → rang "Platine" en français', () => {
    const desc = sentFr[0].embeds[0].toJSON().description ?? '';
    assert.match(desc, /Platine/, 'FR doit contenir "Platine"');
    assert.doesNotMatch(desc, /Platinum/, 'FR ne doit pas contenir "Platinum"');
  });

  it('guilde FR → Fearless "Oui" en français', () => {
    const desc = sentFr[0].embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless : Oui/, 'FR doit contenir "Fearless : Oui"');
    assert.doesNotMatch(desc, /Fearless: Yes/, 'FR ne doit pas contenir "Fearless: Yes"');
  });

  // ── Guilde EN ─────────────────────────────────────────────────────────────

  it('guilde EN → rang "Platinum" en anglais (locale lue depuis DB)', () => {
    const desc = sentEn[0].embeds[0].toJSON().description ?? '';
    assert.match(desc, /Platinum/, 'EN doit contenir "Platinum" (résolu via getGuildLocale → DB)');
    assert.doesNotMatch(desc, /Platine/, 'EN ne doit pas contenir "Platine"');
  });

  it('guilde EN → Fearless "Yes" en anglais (locale lue depuis DB)', () => {
    const desc = sentEn[0].embeds[0].toJSON().description ?? '';
    assert.match(desc, /Fearless: Yes/, 'EN doit contenir "Fearless: Yes"');
    assert.doesNotMatch(desc, /Fearless : Oui/, 'EN ne doit pas contenir "Fearless : Oui"');
  });

  // ── Guilde sans configuration ─────────────────────────────────────────────

  it('guilde sans ligne guild_languages → fallback français par défaut', () => {
    const desc = sentDef[0].embeds[0].toJSON().description ?? '';
    assert.match(desc, /Platine/, 'guilde sans config doit contenir "Platine" (fallback fr)');
    assert.match(desc, /Fearless : Oui/, 'guilde sans config doit contenir "Fearless : Oui"');
    assert.doesNotMatch(desc, /Platinum/, 'guilde sans config ne doit pas contenir "Platinum"');
  });

  // ── Parité des données métier ─────────────────────────────────────────────

  it('même format BO3 pour les trois destinations', () => {
    const descFr  = sentFr[0].embeds[0].toJSON().description  ?? '';
    const descEn  = sentEn[0].embeds[0].toJSON().description  ?? '';
    const descDef = sentDef[0].embeds[0].toJSON().description ?? '';
    assert.match(descFr,  /BO3/, 'FR doit contenir "BO3"');
    assert.match(descEn,  /BO3/, 'EN doit contenir "BO3"');
    assert.match(descDef, /BO3/, 'DEF doit contenir "BO3"');
  });

  it('même date 27/07/2026 pour les trois destinations', () => {
    const descFr  = sentFr[0].embeds[0].toJSON().description  ?? '';
    const descEn  = sentEn[0].embeds[0].toJSON().description  ?? '';
    const descDef = sentDef[0].embeds[0].toJSON().description ?? '';
    assert.match(descFr,  /27\/07\/2026/, 'FR date identique');
    assert.match(descEn,  /27\/07\/2026/, 'EN date identique');
    assert.match(descDef, /27\/07\/2026/, 'DEF date identique');
  });

  it('même heure numérique 21 et même fuseau CEST pour les trois destinations', () => {
    const descFr  = sentFr[0].embeds[0].toJSON().description  ?? '';
    const descEn  = sentEn[0].embeds[0].toJSON().description  ?? '';
    const descDef = sentDef[0].embeds[0].toJSON().description ?? '';
    // Heure numérique : 21h00 (FR) / 21:00 (EN) — "21" présent dans les deux
    assert.match(descFr,  /21/, 'FR doit contenir "21" (heure Paris)');
    assert.match(descEn,  /21/, 'EN doit contenir "21" (même heure)');
    assert.match(descDef, /21/, 'DEF doit contenir "21"');
    // Fuseau CEST (juillet)
    assert.match(descFr,  /CEST/, 'FR doit contenir "CEST"');
    assert.match(descEn,  /CEST/, 'EN doit contenir "CEST"');
    assert.match(descDef, /CEST/, 'DEF doit contenir "CEST"');
  });

  it('heure FR et EN sont identiques numériquement (pas de double décalage)', () => {
    const descFr = sentFr[0].embeds[0].toJSON().description ?? '';
    const descEn = sentEn[0].embeds[0].toJSON().description ?? '';
    // FR : "21h00" / EN : "21:00" — les deux contiennent "21"
    // Vérification inversée : FR ne doit pas contenir "22" et EN non plus
    assert.doesNotMatch(descFr, /22h|22:/, 'FR ne doit pas afficher 22h (double décalage)');
    assert.doesNotMatch(descEn, /22h|22:/, 'EN ne doit pas afficher 22h (double décalage)');
  });

  // ── Preuve que la locale n'est PAS injectée par le test ──────────────────

  it('la locale EN vient de la DB — les rows ne contiennent pas de champ locale', () => {
    // Ce test prouve structurellement que broadcastScrimRequest a résolu la locale.
    // Si getGuildLocale était forcé à 'fr', la guilde EN recevrait du français
    // et les assertions 'Platinum' / 'Fearless: Yes' échoueraient.
    const descEn = sentEn[0].embeds[0].toJSON().description ?? '';
    assert.match(
      descEn,
      /Platinum/,
      'Platinum présent → locale EN correctement lue depuis la DB par le service',
    );
  });
});
