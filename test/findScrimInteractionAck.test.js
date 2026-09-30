/**
 * Non-régression — /find-scrim ACK Discord (defer) + branches post-defer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { rechercheScrim } from '../src/commands/rechercheScrim.js';
import { beginScrimRequest, endScrimRequest } from '../src/utils/scrimRequestLock.js';
import { t } from '../src/i18n/index.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-scrim-ack-'));
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

function tomorrowDdMmYyyy() {
  const d = new Date(Date.now() + 36 * 3600 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * @param {{
 *   userId?: string,
 *   guildId?: string,
 *   inGuild?: boolean,
 *   options?: Record<string, unknown>,
 *   memberFetch?: () => Promise<unknown>,
 *   publicGuildId?: string | null,
 * }} [opts]
 */
function buildInteraction(opts = {}) {
  const userId = opts.userId ?? 'user-1';
  const guildId = opts.guildId ?? 'guild-origin';
  const inGuild = opts.inGuild !== false;
  /** @type {string[]} */
  const callOrder = [];
  /** @type {unknown[]} */
  const replies = [];
  /** @type {unknown[]} */
  const edits = [];
  let deferred = false;
  let replied = false;

  const defaultOptions = {
    rang: 'Platine',
    date: tomorrowDdMmYyyy(),
    heure: '20h',
    contact: { id: 'contact-1', username: 'Contact', bot: false },
    format: 'BO1',
    fearless: 'non',
    elo_precision: null,
    heure_max_debut: null,
    multi_opgg: null,
    structure: null,
    nombre_de_games: null,
    ...(opts.options ?? {}),
  };

  const publicGuildId = opts.publicGuildId ?? null;
  let memberFetchCalls = 0;

  const interaction = {
    commandName: 'find-scrim',
    user: { id: userId },
    guildId: inGuild ? guildId : null,
    guild: inGuild ? { id: guildId, name: 'Origin', roles: { cache: new Map() } } : null,
    channel: inGuild ? { id: 'ch-cmd', isThread: () => false } : null,
    member: inGuild
      ? {
          id: userId,
          roles: { cache: new Map() },
          permissions: { has: () => true },
        }
      : null,
    inGuild: () => inGuild,
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    options: {
      getString(name, _req) {
        const v = defaultOptions[name];
        return v == null ? null : String(v);
      },
      getUser(name, _req) {
        if (name === 'contact') return defaultOptions.contact;
        return null;
      },
      getInteger(name) {
        return defaultOptions[name] ?? null;
      },
    },
    client: {
      guilds: {
        cache: {
          get(id) {
            if (publicGuildId && id === publicGuildId) {
              return {
                id: publicGuildId,
                members: {
                  fetch: async () => {
                    memberFetchCalls += 1;
                    callOrder.push('members.fetch');
                    if (opts.memberFetch) return opts.memberFetch();
                    return { id: userId };
                  },
                },
              };
            }
            return { id, name: `Guild ${id}` };
          },
        },
        fetch: async (id) => {
          callOrder.push('guilds.fetch');
          return interaction.client.guilds.cache.get(id);
        },
      },
    },
    deferReply: async () => {
      callOrder.push('deferReply');
      deferred = true;
    },
    reply: async (payload) => {
      callOrder.push('reply');
      replies.push(payload);
      replied = true;
    },
    editReply: async (payload) => {
      callOrder.push('editReply');
      edits.push(payload);
    },
    followUp: async () => {
      callOrder.push('followUp');
    },
  };

  return {
    interaction,
    callOrder,
    replies,
    edits,
    getMemberFetchCalls: () => memberFetchCalls,
  };
}

describe('/find-scrim — defer ACK (10062 prevention)', () => {
  const prevPublic = process.env.SCRIMRESEAU_PUBLIC_GUILD_ID;

  beforeEach(() => {
    delete process.env.SCRIMRESEAU_PUBLIC_GUILD_ID;
  });

  afterEach(() => {
    if (prevPublic === undefined) delete process.env.SCRIMRESEAU_PUBLIC_GUILD_ID;
    else process.env.SCRIMRESEAU_PUBLIC_GUILD_ID = prevPublic;
    endScrimRequest('user-1');
    endScrimRequest('user-lock');
  });

  it('deferReply est appelé avant members.fetch du gate public', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.SCRIMRESEAU_PUBLIC_GUILD_ID = 'public-guild';
      const { interaction, callOrder } = buildInteraction({
        publicGuildId: 'public-guild',
        memberFetch: async () => {
          // simulate slow path after defer
          return { id: 'user-1' };
        },
      });
      stmts.upsertGuildChannel.run({
        guild_id: 'dest-g',
        channel_id: 'dest-c',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });

      await rechercheScrim.execute(interaction, { stmts, db });

      const deferIdx = callOrder.indexOf('deferReply');
      const fetchIdx = callOrder.indexOf('members.fetch');
      assert.ok(deferIdx >= 0, 'deferReply doit être appelé');
      assert.ok(fetchIdx >= 0, 'members.fetch doit être appelé');
      assert.ok(deferIdx < fetchIdx, 'deferReply avant members.fetch');
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0, 'pas de reply après defer');
    });
  });

  it('lock actif → reply immédiat, pas de defer', async () => {
    await withTempDb(async (db, stmts) => {
      beginScrimRequest('user-lock');
      const { interaction, callOrder, replies } = buildInteraction({ userId: 'user-lock' });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('reply'));
      assert.ok(!callOrder.includes('deferReply'));
      assert.match(String(replies[0]?.content ?? ''), /scrim/i);
      endScrimRequest('user-lock');
    });
  });

  it('hors guilde → reply, pas de defer', async () => {
    await withTempDb(async (db, stmts) => {
      const { interaction, callOrder } = buildInteraction({ inGuild: false });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('reply'));
      assert.ok(!callOrder.includes('deferReply'));
    });
  });

  it('refus gate serveur public → editReply après defer', async () => {
    await withTempDb(async (db, stmts) => {
      process.env.SCRIMRESEAU_PUBLIC_GUILD_ID = 'public-guild';
      const err = Object.assign(new Error('Unknown Member'), { code: 10007 });
      const { interaction, callOrder, edits } = buildInteraction({
        publicGuildId: 'public-guild',
        memberFetch: async () => {
          throw err;
        },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.ok(callOrder.includes('editReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.ok(String(edits[0]?.content ?? '').length > 0);
    });
  });

  it('blacklist → editReply après defer', async () => {
    await withTempDb(async (db, stmts) => {
      stmts.upsertGlobalBlacklist.run({
        user_id: 'user-1',
        reason: 'test',
        created_at: Date.now(),
        created_by: 'mod',
        expires_at: null,
      });
      const { interaction, callOrder, edits } = buildInteraction();
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.equal(edits.at(-1)?.content, t('fr', 'generic.blacklistedUser'));
    });
  });

  it('mauvais salon d’usage → editReply après defer', async () => {
    await withTempDb(async (db, stmts) => {
      stmts.upsertScrimUsageChannel.run({
        guild_id: 'guild-origin',
        channel_id: 'only-this-channel',
      });
      const { interaction, callOrder, edits } = buildInteraction();
      // channel id = ch-cmd ≠ only-this-channel
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.equal(edits.at(-1)?.content, t('fr', 'restrictions.wrongChannel'));
    });
  });

  it('validation rang invalide → editReply après defer', async () => {
    await withTempDb(async (db, stmts) => {
      const { interaction, callOrder, edits } = buildInteraction({
        options: { rang: 'NotARealRankXYZ' },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.match(String(edits.at(-1)?.content ?? ''), /❌|rang|rank/i);
    });
  });

  it('structure invalide → editReply après defer', async () => {
    await withTempDb(async (db, stmts) => {
      const { interaction, callOrder, edits } = buildInteraction({
        options: { structure: '999999999999999999' },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.equal(edits.at(-1)?.content, t('fr', 'findScrim.structureInvalid'));
    });
  });

  it('aucune cible → editReply après defer', async () => {
    await withTempDb(async (db, stmts) => {
      const { interaction, callOrder, edits } = buildInteraction();
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.equal(edits.at(-1)?.content, t('fr', 'findScrim.noTargets'));
    });
  });

  it('succès : defer + sending + résultat sans reply post-defer', async () => {
    await withTempDb(async (db, stmts) => {
      stmts.upsertGuildChannel.run({
        guild_id: 'dest-g',
        channel_id: 'dest-c',
        game_key: 'league_of_legends',
        created_at: Date.now(),
      });
      const { interaction, callOrder, edits } = buildInteraction();
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(callOrder.filter((c) => c === 'reply').length, 0);
      assert.ok(callOrder.filter((c) => c === 'editReply').length >= 2);
      const texts = edits.map((e) => String(e?.content ?? ''));
      assert.ok(texts.some((c) => c === t('fr', 'findScrim.sending')));
      assert.ok(
        texts.some(
          (c) =>
            c.includes('/scrim-close')
            || c.includes('Aucune annonce')
            || c.includes('recherche de scrim'),
        ),
        `attendu un résultat post-sending, got: ${JSON.stringify(texts)}`,
      );
    });
  });

  it('defer utilise MessageFlags.Ephemeral', async () => {
    await withTempDb(async (db, stmts) => {
      /** @type {unknown} */
      let deferOpts;
      const { interaction, callOrder } = buildInteraction();
      const originalDefer = interaction.deferReply.bind(interaction);
      interaction.deferReply = async (opts) => {
        deferOpts = opts;
        return originalDefer(opts);
      };
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.ok(callOrder.includes('deferReply'));
      assert.equal(/** @type {{ flags?: unknown }} */ (deferOpts)?.flags, MessageFlags.Ephemeral);
    });
  });
});
