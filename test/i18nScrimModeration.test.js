/**
 * Tests de /scrim-moderation (block/unblock) avec localisation FR et EN.
 * Vérifie que les messages sont traduits selon la langue de la guilde.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, prepareStatements, closeDb } from '../src/database/db.js';
import { executeBlockScrimUserCore } from '../src/commands/blockScrimUser.js';
import { executeUnblockScrimUserCore } from '../src/commands/unblockScrimUser.js';
import { scrimModeration } from '../src/commands/scrimModeration.js';
import { fr } from '../src/i18n/fr.js';
import { en } from '../src/i18n/en.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function withTempDbAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-mod-test-'));
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

/**
 * Crée un mock d'interaction pour les tests de block/unblock.
 * @param {{ guildId?: string, isAdmin?: boolean, userId?: string, targetTag?: string, targetId?: string, isGuild?: boolean }} opts
 */
function makeInteraction(opts = {}) {
  const {
    guildId = 'guild-test',
    isAdmin = true,
    userId = 'mod-user-id',
    targetTag = 'TargetUser#0001',
    targetId = 'target-user-id',
    isGuild = true,
  } = opts;

  const replies = [];
  return {
    replies,
    interaction: {
      guildId: isGuild ? guildId : null,
      guild: isGuild ? { id: guildId } : null,
      inGuild: () => isGuild,
      memberPermissions: { has: () => isAdmin },
      member: { permissions: { has: () => isAdmin } },
      user: { id: userId },
      client: { user: { id: 'bot-user-id' } },
      options: {
        getUser: () => ({ id: targetId, tag: targetTag }),
        getString: (key) => {
          if (key === 'action') return 'block';
          return null;
        },
        getSubcommand: () => 'user',
      },
      replied: false,
      deferred: false,
      reply: async (opts) => { replies.push(opts); },
      editReply: async (opts) => { replies.push(opts); },
      followUp: async (opts) => { replies.push(opts); },
    },
  };
}

function makeCtx(db, stmts) {
  return { db, stmts };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('/scrim-moderation — définition', () => {
  it('la commande s\'appelle scrim-moderation', () => {
    const d = scrimModeration.data.toJSON();
    assert.equal(d.name, 'scrim-moderation');
  });

  it('la sous-commande user est présente', () => {
    const d = scrimModeration.data.toJSON();
    const sub = d.options?.find(o => o.name === 'user');
    assert.ok(sub, 'sous-commande user manquante');
  });

  it('les options obligatoires sont avant les facultatives', () => {
    const d = scrimModeration.data.toJSON();
    const userSub = d.options?.find(o => o.name === 'user');
    let seenOpt = false;
    for (const o of (userSub?.options || [])) {
      if (seenOpt && o.required) assert.fail(`Option required après optional dans user : ${o.name}`);
      if (!o.required) seenOpt = true;
    }
  });
});

describe('/scrim-moderation — blocage FR', () => {
  it('blocage réussi → message en français', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-fr' });
      // Pas de langue configurée → français par défaut
      await executeBlockScrimUserCore(interaction, makeCtx(db, stmts), 'fr');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /ne seront plus diffusées/i);
      // Doit contenir le tag
      assert.ok(replies[0].content.includes('TargetUser#0001'));
    });
  });

  it('déjà bloqué → message ℹ️ en français', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-fr2', targetId: 'user-dup' });
      // Bloquer deux fois le même utilisateur
      stmts.blockUser.run('guild-fr2', 'user-dup', Date.now());
      await executeBlockScrimUserCore(interaction, makeCtx(db, stmts), 'fr');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /déjà bloqué/i);
    });
  });
});

describe('/scrim-moderation — blocage EN', () => {
  it('blocage réussi → message en anglais', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-en' });
      stmts.upsertGuildLanguage.run('guild-en', 'en');
      await executeBlockScrimUserCore(interaction, makeCtx(db, stmts), 'en');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /no longer be broadcast/i);
      assert.ok(replies[0].content.includes('TargetUser#0001'));
    });
  });

  it('déjà bloqué → message ℹ️ en anglais', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-en2', targetId: 'user-dup-en' });
      stmts.upsertGuildLanguage.run('guild-en2', 'en');
      stmts.blockUser.run('guild-en2', 'user-dup-en', Date.now());
      await executeBlockScrimUserCore(interaction, makeCtx(db, stmts), 'en');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /already blocked/i);
    });
  });
});

describe('/scrim-moderation — déblocage FR', () => {
  it('déblocage réussi → message en français', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-ub-fr', targetId: 'user-to-unblock' });
      stmts.blockUser.run('guild-ub-fr', 'user-to-unblock', Date.now());
      await executeUnblockScrimUserCore(interaction, makeCtx(db, stmts), 'fr');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /pourront à nouveau/i);
      assert.ok(replies[0].content.includes('TargetUser#0001'));
    });
  });

  it('utilisateur non bloqué → message ℹ️ en français', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-ub-fr2', targetId: 'user-not-blocked' });
      await executeUnblockScrimUserCore(interaction, makeCtx(db, stmts), 'fr');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /n'était pas bloqué/i);
    });
  });
});

describe('/scrim-moderation — déblocage EN', () => {
  it('déblocage réussi → message en anglais', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-ub-en', targetId: 'user-to-unblock-en' });
      stmts.upsertGuildLanguage.run('guild-ub-en', 'en');
      stmts.blockUser.run('guild-ub-en', 'user-to-unblock-en', Date.now());
      await executeUnblockScrimUserCore(interaction, makeCtx(db, stmts), 'en');
      assert.ok(replies.length > 0);
      // Le message anglais contient "broadcast" et "again"
      assert.match(replies[0].content, /broadcast/i);
      assert.match(replies[0].content, /again/i);
      assert.ok(replies[0].content.includes('TargetUser#0001'));
    });
  });

  it('utilisateur non bloqué → message ℹ️ en anglais', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ guildId: 'guild-ub-en2', targetId: 'user-not-blocked-en' });
      stmts.upsertGuildLanguage.run('guild-ub-en2', 'en');
      await executeUnblockScrimUserCore(interaction, makeCtx(db, stmts), 'en');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /was not blocked/i);
    });
  });
});

describe('/scrim-moderation — vérifications admin et guilde', () => {
  it('non-admin → message d\'erreur FR (locale par défaut)', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ isAdmin: false });
      const ctx = makeCtx(db, stmts);
      await scrimModeration.execute(interaction, ctx);
      assert.ok(replies.length > 0);
      const content = replies[0].content ?? '';
      // Doit refuser — pas de confirmation de blocage
      assert.doesNotMatch(content, /ne seront plus diffusées/i);
      assert.doesNotMatch(content, /no longer be broadcast/i);
    });
  });

  it('non-admin → message d\'erreur EN quand serveur configuré en anglais', async () => {
    await withTempDbAsync(async (db, stmts) => {
      stmts.upsertGuildLanguage.run('guild-nonadmin-en', 'en');
      const { replies, interaction } = makeInteraction({
        guildId: 'guild-nonadmin-en',
        isAdmin: false,
      });
      const ctx = makeCtx(db, stmts);
      await scrimModeration.execute(interaction, ctx);
      assert.ok(replies.length > 0);
      const content = replies[0].content ?? '';
      // Doit contenir un extrait du message adminOnly en anglais
      assert.match(content, /reserved for server administrators/i);
    });
  });

  it('bloquer le bot lui-même → message d\'erreur FR', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ targetId: 'bot-user-id' });
      await executeBlockScrimUserCore(interaction, makeCtx(db, stmts), 'fr');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /ne pouvez pas bloquer le bot/i);
    });
  });

  it('bloquer le bot lui-même → message d\'erreur EN', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const { replies, interaction } = makeInteraction({ targetId: 'bot-user-id' });
      await executeBlockScrimUserCore(interaction, makeCtx(db, stmts), 'en');
      assert.ok(replies.length > 0);
      assert.match(replies[0].content, /cannot block the bot/i);
    });
  });

  it('aucune modification de la logique métier', async () => {
    await withTempDbAsync(async (db, stmts) => {
      const guildId = 'guild-logic-test';
      const userId = 'target-logic';

      // Bloquer
      const { interaction: intBlock } = makeInteraction({ guildId, targetId: userId });
      await executeBlockScrimUserCore(intBlock, makeCtx(db, stmts), 'fr');

      // Vérifier que l'utilisateur est bien en DB (table correcte : guild_blocked_users)
      const row = db.prepare(
        `SELECT * FROM guild_blocked_users WHERE guild_id = ? AND user_id = ?`
      ).get(guildId, userId);
      assert.ok(row, 'L\'utilisateur bloqué doit être en DB');

      // Débloquer
      const { interaction: intUnblock } = makeInteraction({ guildId, targetId: userId });
      await executeUnblockScrimUserCore(intUnblock, makeCtx(db, stmts), 'fr');

      // Vérifier que l'utilisateur n'est plus en DB
      const rowAfter = db.prepare(
        `SELECT * FROM guild_blocked_users WHERE guild_id = ? AND user_id = ?`
      ).get(guildId, userId);
      assert.equal(rowAfter, undefined, 'L\'utilisateur débloqué ne doit plus être en DB');
    });
  });
});

describe('/scrim-moderation — cohérence des clés i18n', () => {
  it('toutes les clés scrimModeration sont présentes en fr et en', () => {
    const keys = [
      'scrimModeration.blockBot',
      'scrimModeration.alreadyBlocked',
      'scrimModeration.blockSuccess',
      'scrimModeration.notBlocked',
      'scrimModeration.unblockSuccess',
    ];
    for (const key of keys) {
      assert.ok(fr[key], `Clé manquante dans fr.js : ${key}`);
      assert.ok(en[key], `Clé manquante dans en.js : ${key}`);
    }
  });

  it('les traductions contiennent {tag} pour interpolation', () => {
    const keysWithTag = [
      'scrimModeration.alreadyBlocked',
      'scrimModeration.blockSuccess',
      'scrimModeration.notBlocked',
      'scrimModeration.unblockSuccess',
    ];
    for (const key of keysWithTag) {
      assert.ok(fr[key]?.includes('{tag}'), `fr.js clé ${key} doit contenir {tag}`);
      assert.ok(en[key]?.includes('{tag}'), `en.js clé ${key} doit contenir {tag}`);
    }
  });
});
