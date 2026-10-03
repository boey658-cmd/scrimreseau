/**
 * Gate membership CONTACT /find-scrim — fail-closed, auteur inchangé.
 * Cas A–G (+ couverture defer / mutations).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { rechercheScrim } from '../src/commands/rechercheScrim.js';
import { endScrimRequest } from '../src/utils/scrimRequestLock.js';
import { t } from '../src/i18n/index.js';

const ENV_PUBLIC = 'SCRIMRESEAU_PUBLIC_GUILD_ID';
const ENV_COMMUNITY = 'SCRIM_COMMUNITY_SERVER_URL';
const PUBLIC_GUILD = 'public-guild-contact-gate';
const INVITE = 'https://discord.gg/scrimreseau-contact-gate';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'find-scrim-contact-gate-'));
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
 *   contactId?: string,
 *   memberFetchByUser?: (userId: string) => Promise<unknown>,
 * }} [opts]
 */
function buildInteraction(opts = {}) {
  const userId = opts.userId ?? 'author-1';
  const contactId = opts.contactId ?? 'contact-2';
  const guildId = 'guild-origin';
  /** @type {string[]} */
  const callOrder = [];
  /** @type {unknown[]} */
  const edits = [];
  /** @type {string[]} */
  const fetchedUserIds = [];
  let deferred = false;
  let replied = false;
  let memberFetchCalls = 0;

  const defaultOptions = {
    rang: 'Platine',
    date: tomorrowDdMmYyyy(),
    heure: '20h',
    contact: { id: contactId, username: 'Contact', bot: false },
    format: 'BO1',
    fearless: 'non',
    elo_precision: null,
    heure_max_debut: null,
    multi_opgg: null,
    structure: null,
    nombre_de_games: null,
  };

  const interaction = {
    commandName: 'find-scrim',
    user: { id: userId },
    guildId,
    guild: { id: guildId, name: 'Origin', roles: { cache: new Map() } },
    channel: { id: 'ch-cmd', isThread: () => false },
    member: {
      id: userId,
      roles: { cache: new Map() },
      permissions: { has: () => true },
    },
    inGuild: () => true,
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    options: {
      getString(name) {
        const v = defaultOptions[name];
        return v == null ? null : String(v);
      },
      getUser(name) {
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
            if (id === PUBLIC_GUILD) {
              return {
                id: PUBLIC_GUILD,
                members: {
                  fetch: async (arg) => {
                    memberFetchCalls += 1;
                    callOrder.push('members.fetch');
                    const uid =
                      typeof arg === 'object' && arg !== null && 'user' in arg
                        ? String(/** @type {{ user: string }} */ (arg).user)
                        : String(arg);
                    fetchedUserIds.push(uid);
                    if (opts.memberFetchByUser) return opts.memberFetchByUser(uid);
                    return { id: uid };
                  },
                },
              };
            }
            return { id, name: `Guild ${id}` };
          },
        },
        fetch: async (id) => interaction.client.guilds.cache.get(id),
      },
    },
    deferReply: async () => {
      callOrder.push('deferReply');
      deferred = true;
    },
    reply: async () => {
      callOrder.push('reply');
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
    edits,
    fetchedUserIds,
    getMemberFetchCalls: () => memberFetchCalls,
  };
}

function seedDestination(stmts) {
  stmts.upsertGuildChannel.run({
    guild_id: 'dest-g',
    channel_id: 'dest-c',
    game_key: 'league_of_legends',
    created_at: Date.now(),
  });
}

function countScrimMutations(db) {
  const posts = db.prepare('SELECT COUNT(*) AS n FROM scrim_posts').get().n;
  const batches = db.prepare('SELECT COUNT(*) AS n FROM scrim_broadcast_batches').get().n;
  const deliveries = db.prepare('SELECT COUNT(*) AS n FROM scrim_broadcast_deliveries').get().n;
  return { posts, batches, deliveries };
}

describe('/find-scrim — gate membership CONTACT (fail-closed)', () => {
  const prevPublic = process.env[ENV_PUBLIC];
  const prevCommunity = process.env[ENV_COMMUNITY];

  beforeEach(() => {
    process.env[ENV_PUBLIC] = PUBLIC_GUILD;
    process.env[ENV_COMMUNITY] = INVITE;
  });

  afterEach(() => {
    if (prevPublic === undefined) delete process.env[ENV_PUBLIC];
    else process.env[ENV_PUBLIC] = prevPublic;
    if (prevCommunity === undefined) delete process.env[ENV_COMMUNITY];
    else process.env[ENV_COMMUNITY] = prevCommunity;
    endScrimRequest('author-1');
  });

  it('A: auteur présent + contact = auteur → succès, 1 seul members.fetch', async () => {
    await withTempDb(async (db, stmts) => {
      seedDestination(stmts);
      const { interaction, fetchedUserIds, getMemberFetchCalls, edits, callOrder } =
        buildInteraction({
          userId: 'author-1',
          contactId: 'author-1',
        });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.equal(getMemberFetchCalls(), 1);
      assert.deepEqual(fetchedUserIds, ['author-1']);
      assert.ok(callOrder.includes('deferReply'));
      assert.ok(edits.some((e) => String(e?.content ?? '') === t('fr', 'findScrim.sending')));
      assert.ok(
        !edits.some(
          (e) =>
            String(e?.content ?? '') ===
            t('fr', 'publicGate.contactRefusal', { url: INVITE }),
        ),
      );
    });
  });

  it('B: auteur présent + contact différent présent → succès, 2 fetch', async () => {
    await withTempDb(async (db, stmts) => {
      seedDestination(stmts);
      const { interaction, fetchedUserIds, getMemberFetchCalls, edits } = buildInteraction({
        userId: 'author-1',
        contactId: 'contact-2',
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.equal(getMemberFetchCalls(), 2);
      assert.deepEqual(fetchedUserIds, ['author-1', 'contact-2']);
      assert.ok(edits.some((e) => String(e?.content ?? '') === t('fr', 'findScrim.sending')));
      assert.ok(
        !edits.some(
          (e) =>
            String(e?.content ?? '') ===
            t('fr', 'publicGate.contactRefusal', { url: INVITE }),
        ),
      );
    });
  });

  it('C: contact absent 10007 → refus, aucune row scrim_posts / batch / delivery', async () => {
    await withTempDb(async (db, stmts) => {
      seedDestination(stmts);
      const { interaction, edits, getMemberFetchCalls } = buildInteraction({
        userId: 'author-1',
        contactId: 'contact-absent',
        memberFetchByUser: async (uid) => {
          if (uid === 'author-1') return { id: uid };
          const err = Object.assign(new Error('Unknown Member'), { code: 10007 });
          throw err;
        },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.equal(getMemberFetchCalls(), 2);
      const expected = t('fr', 'publicGate.contactRefusal', { url: INVITE });
      assert.equal(edits.at(-1)?.content, expected);
      assert.ok(!edits.some((e) => String(e?.content ?? '') === t('fr', 'findScrim.sending')));
      assert.deepEqual(countScrimMutations(db), { posts: 0, batches: 0, deliveries: 0 });
    });
  });

  it('D: erreur Discord non-10007 sur le contact → refus, aucune mutation', async () => {
    await withTempDb(async (db, stmts) => {
      seedDestination(stmts);
      const { interaction, edits, getMemberFetchCalls } = buildInteraction({
        userId: 'author-1',
        contactId: 'contact-err',
        memberFetchByUser: async (uid) => {
          if (uid === 'author-1') return { id: uid };
          const err = Object.assign(new Error('Missing Access'), { code: 50001 });
          throw err;
        },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.equal(getMemberFetchCalls(), 2);
      assert.equal(
        edits.at(-1)?.content,
        t('fr', 'publicGate.contactRefusal', { url: INVITE }),
      );
      assert.deepEqual(countScrimMutations(db), { posts: 0, batches: 0, deliveries: 0 });
    });
  });

  it('E: deferReply reste avant tous les members.fetch', async () => {
    await withTempDb(async (db, stmts) => {
      seedDestination(stmts);
      const { interaction, callOrder } = buildInteraction({
        userId: 'author-1',
        contactId: 'contact-2',
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      const deferIdx = callOrder.indexOf('deferReply');
      const fetchIndices = callOrder
        .map((c, i) => (c === 'members.fetch' ? i : -1))
        .filter((i) => i >= 0);
      assert.ok(deferIdx >= 0);
      assert.equal(fetchIndices.length, 2);
      assert.ok(fetchIndices.every((i) => deferIdx < i));
    });
  });

  it('F: gate auteur inchangé — erreur non-10007 → fail-open, flux continue', async () => {
    await withTempDb(async (db, stmts) => {
      seedDestination(stmts);
      let authorFetches = 0;
      const { interaction, edits, getMemberFetchCalls } = buildInteraction({
        userId: 'author-1',
        contactId: 'author-1',
        memberFetchByUser: async (uid) => {
          if (uid === 'author-1') {
            authorFetches += 1;
            // 1er fetch = gate auteur : erreur non-10007 → fail-open historique
            if (authorFetches === 1) {
              const err = Object.assign(new Error('rate limited'), { code: 429 });
              throw err;
            }
          }
          return { id: uid };
        },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      // contact === auteur → pas de 2e gate ; seul le fetch auteur (fail-open) a lieu
      assert.equal(getMemberFetchCalls(), 1);
      assert.ok(edits.some((e) => String(e?.content ?? '') === t('fr', 'findScrim.sending')));
      assert.ok(
        !edits.some(
          (e) =>
            String(e?.content ?? '') ===
            t('fr', 'publicGate.contactRefusal', { url: INVITE }),
        ),
      );
    });
  });

  it('G: refus auteur 10007 conserve le texte auteur (pas contactRefusal)', async () => {
    await withTempDb(async (db, stmts) => {
      const { interaction, edits } = buildInteraction({
        userId: 'author-1',
        contactId: 'contact-2',
        memberFetchByUser: async () => {
          const err = Object.assign(new Error('Unknown Member'), { code: 10007 });
          throw err;
        },
      });
      await rechercheScrim.execute(interaction, { stmts, db });
      assert.equal(
        edits.at(-1)?.content,
        t('fr', 'publicGate.refusal', { url: INVITE }),
      );
      assert.notEqual(
        edits.at(-1)?.content,
        t('fr', 'publicGate.contactRefusal', { url: INVITE }),
      );
      assert.deepEqual(countScrimMutations(db), { posts: 0, batches: 0, deliveries: 0 });
    });
  });
});
