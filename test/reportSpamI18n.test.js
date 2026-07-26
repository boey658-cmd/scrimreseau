/**
 * Test de régression — localisation de /report-spam (spammer.js)
 *
 * Bug corrigé : spammer.js n'importait pas getGuildLocale ni t(). Tous les
 * messages utilisateurs étaient hardcodés en français, ignorant la langue
 * configurée sur le serveur.
 *
 * Ce test appelle le vrai execute() et vérifie que chaque réponse éphémère
 * utilise la bonne langue selon la configuration de la guilde.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { t } from '../src/i18n/index.js';
import { spammer } from '../src/commands/spammer.js';

// ---------------------------------------------------------------------------
// Helper DB temporaire
// ---------------------------------------------------------------------------

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-spam-i18n-test-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    await fn(db, stmts);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers de mock
// ---------------------------------------------------------------------------

/**
 * Construit un mock d'interaction pour /report-spam.
 *
 * @param {{ guildId: string, userId: string, targetId: string, targetBot?: boolean,
 *           isAdmin?: boolean, isInGuild?: boolean }} opts
 * @returns {{ interaction: object, captured: () => string | null }}
 */
function buildInteraction({ guildId, userId, targetId, targetBot = false, isAdmin = true, isInGuild = true }) {
  let capturedContent = null;

  const interaction = {
    guildId: isInGuild ? guildId : null,
    guild: isInGuild ? { id: guildId, name: 'Test Guild' } : null,
    inGuild: () => isInGuild,
    user: { id: userId, tag: `user-${userId}` },
    deferred: false,
    replied: false,
    memberPermissions: {
      has: (perm) => isAdmin && perm === PermissionFlagsBits.Administrator,
    },
    options: {
      getUser: (_name, _req) => ({
        id: targetId,
        tag: `target-${targetId}`,
        bot: targetBot,
      }),
    },
    client: {
      channels: {
        fetch: async () => null,
      },
    },
    reply: async (payload) => {
      capturedContent = typeof payload === 'string' ? payload : payload.content;
      interaction.replied = true;
    },
    editReply: async (payload) => {
      capturedContent = typeof payload === 'string' ? payload : payload.content;
    },
    followUp: async (payload) => {
      capturedContent = typeof payload === 'string' ? payload : payload.content;
    },
    deferReply: async () => { interaction.deferred = true; },
  };

  return { interaction, captured: () => capturedContent };
}

// ---------------------------------------------------------------------------
// Cas de test : selfReport en FR et EN
// ---------------------------------------------------------------------------

describe('/report-spam — régression i18n : messages localisés via t(locale, ...)', () => {

  it('FR : selfReport retourne le texte français (pas hardcodé)', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-spam-fr-001';
      // Aucune ligne guild_languages → français par défaut
      const { interaction, captured } = buildInteraction({
        guildId,
        userId: 'user-001',
        targetId: 'user-001', // même utilisateur → selfReport
        isAdmin: true,
      });

      await spammer.execute(interaction, { stmts });

      const content = captured();
      assert.ok(content, 'Une réponse doit être envoyée');

      // La réponse doit correspondre à la traduction FR
      const expected = t('fr', 'reportSpam.selfReport');
      assert.equal(content, expected, `FR selfReport attendu "${expected}", obtenu "${content}"`);

      // Ne doit PAS être une clé brute
      assert.ok(!content.startsWith('reportSpam.'), `Le contenu ne doit pas être une clé brute : "${content}"`);
    });
  });

  it('EN : selfReport retourne le texte anglais (pas le texte français)', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-spam-en-001';
      // Configurer la langue EN pour ce serveur
      stmts.upsertGuildLanguage.run(guildId, 'en');

      const { interaction, captured } = buildInteraction({
        guildId,
        userId: 'user-002',
        targetId: 'user-002', // même utilisateur → selfReport
        isAdmin: true,
      });

      await spammer.execute(interaction, { stmts });

      const content = captured();
      assert.ok(content, 'Une réponse doit être envoyée');

      // Doit correspondre à la traduction EN
      const expectedEn = t('en', 'reportSpam.selfReport');
      const expectedFr = t('fr', 'reportSpam.selfReport');
      assert.equal(content, expectedEn, `EN selfReport attendu "${expectedEn}", obtenu "${content}"`);

      // Ne doit PAS être le texte français
      assert.notEqual(content, expectedFr, `EN selfReport ne doit pas être en français : "${content}"`);
    });
  });

  it('FR : botReport retourne le texte français', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-spam-fr-bot';
      const { interaction, captured } = buildInteraction({
        guildId,
        userId: 'user-003',
        targetId: 'bot-001',
        targetBot: true,
        isAdmin: true,
      });

      await spammer.execute(interaction, { stmts });

      const content = captured();
      const expected = t('fr', 'reportSpam.botReport');
      assert.equal(content, expected, `FR botReport : attendu "${expected}", obtenu "${content}"`);
    });
  });

  it('EN : botReport retourne le texte anglais (pas le texte français)', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-spam-en-bot';
      stmts.upsertGuildLanguage.run(guildId, 'en');

      const { interaction, captured } = buildInteraction({
        guildId,
        userId: 'user-004',
        targetId: 'bot-002',
        targetBot: true,
        isAdmin: true,
      });

      await spammer.execute(interaction, { stmts });

      const content = captured();
      const expectedEn = t('en', 'reportSpam.botReport');
      const expectedFr = t('fr', 'reportSpam.botReport');
      assert.equal(content, expectedEn, `EN botReport : attendu "${expectedEn}", obtenu "${content}"`);
      assert.notEqual(content, expectedFr, `EN botReport ne doit pas être en français`);
    });
  });

  it('EN : non-admin reçoit le texte anglais (pas le texte français)', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-spam-en-noadmin';
      stmts.upsertGuildLanguage.run(guildId, 'en');

      const { interaction, captured } = buildInteraction({
        guildId,
        userId: 'user-005',
        targetId: 'target-005',
        isAdmin: false,
      });

      await spammer.execute(interaction, { stmts });

      const content = captured();
      const expectedEn = t('en', 'reportSpam.adminOnly');
      const expectedFr = t('fr', 'reportSpam.adminOnly');
      assert.equal(content, expectedEn, `EN adminOnly : attendu "${expectedEn}", obtenu "${content}"`);
      assert.notEqual(content, expectedFr, `EN adminOnly ne doit pas être en français`);
    });
  });

  it('FR sans config langue → français par défaut', async () => {
    await withTempDb(async (db, stmts) => {
      const guildId = 'guild-spam-no-lang';
      // Aucune ligne guild_languages → doit tomber sur français

      const { interaction, captured } = buildInteraction({
        guildId,
        userId: 'user-006',
        targetId: 'user-006', // selfReport
        isAdmin: true,
      });

      await spammer.execute(interaction, { stmts });

      const content = captured();
      const expectedFr = t('fr', 'reportSpam.selfReport');
      assert.equal(content, expectedFr, `Sans config langue : doit retourner FR. obtenu "${content}"`);
    });
  });

  it('Aucun message ne ressemble à une clé i18n brute en FR ou EN', async () => {
    const UNRESOLVED = /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+$/;
    const keys = [
      'reportSpam.guildOnly', 'reportSpam.adminOnly', 'reportSpam.selfReport',
      'reportSpam.botReport', 'reportSpam.alreadyReported', 'reportSpam.alreadyBlacklisted',
      'reportSpam.noChannel', 'reportSpam.channelInaccessible', 'reportSpam.modFail',
      'reportSpam.success', 'reportSpam.error',
    ];
    for (const locale of ['fr', 'en']) {
      for (const key of keys) {
        const val = t(locale, key);
        assert.ok(val && val.length > 0, `[${locale}] ${key} retourne vide`);
        assert.ok(!UNRESOLVED.test(val), `[${locale}] ${key} ressemble à une clé brute : "${val}"`);
        assert.notEqual(val, key, `[${locale}] ${key} retourne la clé elle-même`);
      }
    }
  });
});
