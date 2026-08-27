/**
 * Web5F-BOT — hardening PATCH /internal/guilds/:guildId/config
 * Idempotence, rollback, SQLITE_BUSY, authz stale, Discord failures, body/method.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  CONFIG_PATCH_MAX_BODY_BYTES,
  handleGuildConfigPatch,
  parseConfigPatchBody,
  ConfigWriteError,
} from '../src/internalHttp/configPatch.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';
import { assertActorCanManageGuildConfig } from '../src/services/guildConfigWriteAuthz.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import {
  isNetworkDashboardUpdateScheduled,
  stopDashboardRefreshJob,
} from '../src/services/networkDashboard.js';
import { transactionReplaceScrimAllowedRoles } from '../src/commands/configScrimPermissions.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';

const TEST_TOKEN = 'test-internal-token-web5f';
const GUILD_ID = '1484520688726311012';
const OTHER_GUILD = '1436848619796828322';
const ACTOR = '1009269632693174422';
const CHANNEL_ID = '1070686329991602240';
const CHANNEL_B = '1070686329991602241';
const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';
const ROLE_C = '333333333333333333';
const ROLE_D = '444444444444444444';
const ROLE_E = '555555555555555555';
const ROLE_F = '666666666666666666';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-web5f-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    await fn(db, stmts);
  } finally {
    stopDashboardRefreshJob();
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeMember({ admin = false, manageGuild = false } = {}) {
  const bits = new PermissionsBitField();
  if (admin) bits.add(PermissionFlagsBits.Administrator);
  if (manageGuild) bits.add(PermissionFlagsBits.ManageGuild);
  return { id: ACTOR, permissions: bits };
}

function makeTimeoutError() {
  return Object.assign(new Error('Discord fetch timeout'), { code: 'TIMEOUT' });
}

function makeBusyError() {
  return Object.assign(new Error('database is locked SQLITE_BUSY'), { code: 'SQLITE_BUSY' });
}

/**
 * @param {object} opts
 */
function makeMockClient(opts = {}) {
  const {
    guildPresent = true,
    member = makeMember({ admin: true }),
    memberError = null,
    guildFetchError = null,
    channels = new Map(),
    roles = new Map(),
    ownerId = '999999999999999999',
    channelFetchError = null,
    roleFetchError = null,
    memberCount = 200,
  } = opts;

  const guild = {
    id: GUILD_ID,
    ownerId,
    memberCount,
    members: {
      me: {
        id: 'bot',
        permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      },
      cache: new Map(),
      fetch: async (id) => {
        if (memberError) throw memberError;
        if (!member || id !== ACTOR) {
          const err = new Error('Unknown Member');
          /** @type {any} */ (err).code = 10007;
          throw err;
        }
        return member;
      },
      fetchMe: async () => guild.members.me,
    },
    channels: {
      cache: {
        get: (id) => channels.get(id) ?? null,
      },
      fetch: async (id) => {
        if (channelFetchError) throw channelFetchError;
        if (channels.has(id)) return channels.get(id);
        return null;
      },
    },
    roles: {
      cache: {
        get: (id) => roles.get(id) ?? null,
      },
      fetch: async (id) => {
        if (roleFetchError) throw roleFetchError;
        if (roles.has(id)) return roles.get(id);
        return null;
      },
    },
  };

  return {
    guilds: {
      cache: {
        get: (id) => (guildPresent && id === GUILD_ID ? guild : null),
        has: (id) => guildPresent && id === GUILD_ID,
      },
      fetch: async (id) => {
        if (guildFetchError) throw guildFetchError;
        if (!guildPresent || id !== GUILD_ID) {
          const err = new Error('Unknown Guild');
          /** @type {any} */ (err).code = 10004;
          throw err;
        }
        return guild;
      },
    },
    _guild: guild,
  };
}

/**
 * @param {string} [id]
 * @param {{
 *   type?: number,
 *   view?: boolean,
 *   send?: boolean,
 *   embed?: boolean,
 *   guildId?: string,
 * }} [opts]
 */
function makeChannel(id = CHANNEL_ID, opts = {}) {
  const {
    type = ChannelType.GuildText,
    view = true,
    send = true,
    embed = true,
    guildId = GUILD_ID,
  } = opts;
  const bits = new PermissionsBitField();
  if (view) bits.add(PermissionFlagsBits.ViewChannel);
  if (send) bits.add(PermissionFlagsBits.SendMessages);
  if (embed) bits.add(PermissionFlagsBits.EmbedLinks);
  return {
    id,
    type,
    guildId,
    guild: { id: guildId },
    permissionsFor: () => bits,
  };
}

function makeRole(id, guildId = GUILD_ID, extra = {}) {
  return { id, guild: { id: guildId }, managed: false, ...extra };
}

function basePatch(section, extra = {}) {
  return {
    actor_discord_user_id: ACTOR,
    request_id: 'req-web5f-1',
    source: 'web',
    section,
    ...extra,
  };
}

function writeCtx(client, db, stmts) {
  return {
    client: /** @type {any} */ (client),
    guild: client._guild,
    db,
    stmts,
    guildId: GUILD_ID,
    actorDiscordUserId: ACTOR,
  };
}

function enableReceptionBypass(stmts) {
  stmts.upsertGuildScrimReceptionBypass.run({
    guild_id: GUILD_ID,
    bypass_member_minimum: 1,
    updated_by: ACTOR,
    updated_at: new Date().toISOString(),
    note: null,
  });
}

function snapshotConfig(db) {
  return JSON.stringify(fetchGuildConfig(db, GUILD_ID));
}

/** @type {import('node:http').Server | null} */
let testServer = null;
/** @type {{ stopAccepting?: () => void } | null} */
let testListener = null;

async function startTestServer(db, client, stmts) {
  const config = { enabled: true, port: 0, token: TEST_TOKEN };
  const { server, listener, host } = createInternalHttpServer({
    db,
    client,
    stmts,
    config,
    port: 0,
  });
  const bound = await listenInternalHttpServer(server, host, 0);
  testServer = server;
  testListener = listener;
  return bound.port;
}

async function stopTestServer() {
  if (testListener?.stopAccepting) testListener.stopAccepting();
  if (testServer) await closeInternalHttpServer(testServer);
  testServer = null;
  testListener = null;
}

/**
 * @param {number} port
 * @param {string} pathname
 * @param {{
 *   method?: string,
 *   token?: string | null,
 *   authorization?: string | null,
 *   body?: unknown,
 *   contentType?: string | null,
 *   rawBody?: Buffer | string,
 * }} [opts]
 */
function httpRequest(port, pathname, opts = {}) {
  const method = opts.method ?? 'GET';
  /** @type {Record<string, string>} */
  const headers = {};

  if (opts.authorization !== undefined) {
    if (opts.authorization !== null) {
      headers.Authorization = opts.authorization;
    }
  } else if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? TEST_TOKEN}`;
  }

  let bodyBuf = null;
  if (opts.rawBody !== undefined) {
    bodyBuf = Buffer.isBuffer(opts.rawBody)
      ? opts.rawBody
      : Buffer.from(String(opts.rawBody), 'utf8');
    if (opts.contentType !== null) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
    }
    headers['Content-Length'] = String(bodyBuf.length);
  } else if (opts.body !== undefined) {
    bodyBuf = Buffer.from(JSON.stringify(opts.body), 'utf8');
    if (opts.contentType !== null) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
    }
    headers['Content-Length'] = String(bodyBuf.length);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = bodyText ? JSON.parse(bodyText) : null;
          } catch {
            body = bodyText;
          }
          resolve({ status: res.statusCode ?? 0, body, bodyText });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

describe('Web5F — idempotence réelle', () => {
  it('chaque section : write A puis A => noop, DB inchangée, pas de write inutile', async () => {
    await withTempDb(async (db, stmts) => {
      const roles = new Map([
        [ROLE_A, makeRole(ROLE_A)],
        [ROLE_B, makeRole(ROLE_B)],
      ]);
      const client = makeMockClient({
        channels: new Map([[CHANNEL_ID, makeChannel()]]),
        roles,
      });
      const ctx = writeCtx(client, db, stmts);
      enableReceptionBypass(stmts);

      const cases = [
        {
          section: 'language',
          payload: { language: 'en' },
          stmt: stmts.upsertGuildLanguage,
        },
        {
          section: 'reception_channel',
          payload: { channel_id: CHANNEL_ID },
          stmt: stmts.upsertGuildChannel,
        },
        {
          section: 'command_channel',
          payload: { channel_id: CHANNEL_ID },
          stmt: stmts.upsertScrimUsageChannel,
        },
        {
          section: 'inactive_message_policy',
          payload: { policy: 'delete' },
          stmt: stmts.upsertScrimMessageLifecyclePolicy,
        },
        {
          section: 'structure_link',
          payload: { url: 'https://discord.gg/NoOpCode1' },
          stmt: stmts.upsertStructureDiscordLink,
        },
        {
          section: 'command_permissions',
          payload: { mode: 'roles', role_ids: [ROLE_A, ROLE_B] },
          stmt: stmts.insertScrimAllowedRole,
        },
      ];

      for (const c of cases) {
        const first = await applyGuildConfigSectionWrite(
          ctx,
          basePatch(c.section, c.payload),
        );
        assert.strictEqual(first.noop, false, `${c.section} first write`);
        const snap = snapshotConfig(db);

        if (c.section === 'reception_channel') {
          stopDashboardRefreshJob();
          assert.strictEqual(isNetworkDashboardUpdateScheduled(), false);
        }

        const origRun = c.stmt.run.bind(c.stmt);
        let writeCalls = 0;
        c.stmt.run = (...args) => {
          writeCalls += 1;
          return origRun(...args);
        };

        const second = await applyGuildConfigSectionWrite(
          ctx,
          basePatch(c.section, c.payload),
        );
        assert.strictEqual(second.noop, true, `${c.section} noop`);
        assert.strictEqual(snapshotConfig(db), snap, `${c.section} DB inchangée`);
        assert.strictEqual(writeCalls, 0, `${c.section} aucun write inutile`);

        if (c.section === 'reception_channel') {
          assert.strictEqual(
            isNetworkDashboardUpdateScheduled(),
            false,
            'reception noop: aucun schedule dashboard',
          );
        }

        c.stmt.run = origRun;
      }
    });
  });

  it('HTTP PATCH noop => 200 + log noop path (réponse config courante)', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);
      try {
        const body = basePatch('language', { language: 'en' });
        const r1 = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
          method: 'PATCH',
          body,
        });
        assert.strictEqual(r1.status, 200);
        const r2 = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
          method: 'PATCH',
          body,
        });
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.body.language, 'en');
        assert.deepStrictEqual(r2.body, fetchGuildConfig(db, GUILD_ID));
      } finally {
        await stopTestServer();
      }
    });
  });
});

describe('Web5F — transaction permissions rollback', () => {
  it('panne insert role 2 => rollback total, mode/rôles inchangés', async () => {
    await withTempDb(async (db, stmts) => {
      const roles = new Map([
        [ROLE_A, makeRole(ROLE_A)],
        [ROLE_B, makeRole(ROLE_B)],
      ]);
      const ctx = writeCtx(makeMockClient({ roles }), db, stmts);
      await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A] }),
      );
      const before = fetchGuildConfig(db, GUILD_ID);

      const origInsert = stmts.insertScrimAllowedRole.run.bind(stmts.insertScrimAllowedRole);
      let n = 0;
      stmts.insertScrimAllowedRole.run = (...args) => {
        n += 1;
        if (n >= 2) throw new Error('forced insert role 2 fail');
        return origInsert(...args);
      };

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A, ROLE_B] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INTERNAL_ERROR',
      );

      assert.deepStrictEqual(fetchGuildConfig(db, GUILD_ID).command_permissions, before.command_permissions);
      stmts.insertScrimAllowedRole.run = origInsert;
    });
  });

  it('panne upsert mode final => rollback, aucun état partiel', async () => {
    await withTempDb(async (db, stmts) => {
      const roles = new Map([
        [ROLE_A, makeRole(ROLE_A)],
        [ROLE_B, makeRole(ROLE_B)],
      ]);
      const ctx = writeCtx(makeMockClient({ roles }), db, stmts);
      await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A] }),
      );
      const before = fetchGuildConfig(db, GUILD_ID);

      const origUpsert = stmts.upsertScrimPermissionMode.run.bind(stmts.upsertScrimPermissionMode);
      stmts.upsertScrimPermissionMode.run = () => {
        throw new Error('forced upsert mode fail');
      };

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_B] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INTERNAL_ERROR',
      );

      assert.deepStrictEqual(fetchGuildConfig(db, GUILD_ID).command_permissions, before.command_permissions);
      stmts.upsertScrimPermissionMode.run = origUpsert;
    });
  });
});

describe('Web5F — SQLITE_BUSY', () => {
  it('write simple language => 503 BOT_BUSY, DB inchangée, serveur survivant', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);
      try {
        const before = snapshotConfig(db);
        const orig = stmts.upsertGuildLanguage.run.bind(stmts.upsertGuildLanguage);
        stmts.upsertGuildLanguage.run = () => {
          throw makeBusyError();
        };

        const res = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
          method: 'PATCH',
          body: basePatch('language', { language: 'en' }),
        });
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.error, 'BOT_BUSY');
        assert.strictEqual(snapshotConfig(db), before);

        stmts.upsertGuildLanguage.run = orig;

        const get = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`);
        assert.strictEqual(get.status, 200);
        assert.strictEqual(get.body.guild_id, GUILD_ID);
      } finally {
        await stopTestServer();
      }
    });
  });

  it('transaction roles SQLITE_BUSY => BOT_BUSY, rollback, pas de crash', async () => {
    await withTempDb(async (db, stmts) => {
      const roles = new Map([
        [ROLE_A, makeRole(ROLE_A)],
        [ROLE_B, makeRole(ROLE_B)],
      ]);
      const client = makeMockClient({ roles });
      const ctx = writeCtx(client, db, stmts);
      await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A] }),
      );
      const before = fetchGuildConfig(db, GUILD_ID);

      const origInsert = stmts.insertScrimAllowedRole.run.bind(stmts.insertScrimAllowedRole);
      stmts.insertScrimAllowedRole.run = (...args) => {
        throw makeBusyError();
      };

      await assert.rejects(
        () => handleGuildConfigPatch({
          client: /** @type {any} */ (client),
          db,
          stmts,
          guildId: GUILD_ID,
          body: basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A, ROLE_B] }),
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'BOT_BUSY' && err.status === 503,
      );

      assert.deepStrictEqual(fetchGuildConfig(db, GUILD_ID).command_permissions, before.command_permissions);
      stmts.insertScrimAllowedRole.run = origInsert;
    });
  });
});

describe('Web5F — authz live stale / owner / absent', () => {
  it('A: cache admin historique mais fetch live sans droit => 403, aucun write', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient({ member: makeMember() });
      client._guild.members.cache.set(ACTOR, makeMember({ admin: true }));
      const before = snapshotConfig(db);

      await assert.rejects(
        () => handleGuildConfigPatch({
          client: /** @type {any} */ (client),
          db,
          stmts,
          guildId: GUILD_ID,
          body: basePatch('language', { language: 'en' }),
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'GUILD_NOT_MANAGEABLE',
      );
      assert.strictEqual(snapshotConfig(db), before);
    });
  });

  it('B/C/D: owner sans bits, ManageGuild, Administrator autorisés', async () => {
    await assertActorCanManageGuildConfig({
      client: /** @type {any} */ (makeMockClient({ member: makeMember(), ownerId: ACTOR })),
      guildId: GUILD_ID,
      actorDiscordUserId: ACTOR,
    });
    await assertActorCanManageGuildConfig({
      client: /** @type {any} */ (makeMockClient({ member: makeMember({ manageGuild: true }) })),
      guildId: GUILD_ID,
      actorDiscordUserId: ACTOR,
    });
    await assertActorCanManageGuildConfig({
      client: /** @type {any} */ (makeMockClient({ member: makeMember({ admin: true }) })),
      guildId: GUILD_ID,
      actorDiscordUserId: ACTOR,
    });
  });

  it('E: member disparu (10007) => 403, pas write', async () => {
    await withTempDb(async (db, stmts) => {
      const before = snapshotConfig(db);
      await assert.rejects(
        () => handleGuildConfigPatch({
          client: /** @type {any} */ (makeMockClient({ member: null })),
          db,
          stmts,
          guildId: GUILD_ID,
          body: basePatch('language', { language: 'en' }),
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'GUILD_NOT_MANAGEABLE',
      );
      assert.strictEqual(snapshotConfig(db), before);
    });
  });
});

describe('Web5F — bot quitte guild / Discord fetch failures', () => {
  it('guild introuvable => 409 BOT_NOT_INSTALLED, aucun write DB', async () => {
    await withTempDb(async (db, stmts) => {
      const before = snapshotConfig(db);
      let langWrites = 0;
      const orig = stmts.upsertGuildLanguage.run.bind(stmts.upsertGuildLanguage);
      stmts.upsertGuildLanguage.run = (...args) => {
        langWrites += 1;
        return orig(...args);
      };

      await assert.rejects(
        () => handleGuildConfigPatch({
          client: /** @type {any} */ (makeMockClient({ guildPresent: false })),
          db,
          stmts,
          guildId: GUILD_ID,
          body: basePatch('language', { language: 'en' }),
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'BOT_NOT_INSTALLED',
      );
      assert.strictEqual(langWrites, 0);
      assert.strictEqual(snapshotConfig(db), before);
      stmts.upsertGuildLanguage.run = orig;
    });
  });

  it('members.fetch timeout => 503, aucun write', async () => {
    await withTempDb(async (db, stmts) => {
      const before = snapshotConfig(db);
      await assert.rejects(
        () => handleGuildConfigPatch({
          client: /** @type {any} */ (makeMockClient({ memberError: makeTimeoutError() })),
          db,
          stmts,
          guildId: GUILD_ID,
          body: basePatch('language', { language: 'en' }),
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'BOT_UNAVAILABLE',
      );
      assert.strictEqual(snapshotConfig(db), before);
    });
  });

  it('channel fetch timeout => 503, aucun write (command_channel)', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient({
        channels: new Map(),
        channelFetchError: makeTimeoutError(),
      });
      const before = snapshotConfig(db);
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(client, db, stmts),
          basePatch('command_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'BOT_UNAVAILABLE',
      );
      assert.strictEqual(snapshotConfig(db), before);
    });
  });

  it('role fetch timeout => 503, aucun write', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient({
        roles: new Map(),
        roleFetchError: makeTimeoutError(),
      });
      const before = snapshotConfig(db);
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(client, db, stmts),
          basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'BOT_UNAVAILABLE',
      );
      assert.strictEqual(snapshotConfig(db), before);
    });
  });
});

describe('Web5F — channel deleted / wrong type / other guild', () => {
  it('reception: deleted, voice, thread, other guild => INVALID_CHANNEL, DB inchangée', async () => {
    await withTempDb(async (db, stmts) => {
      enableReceptionBypass(stmts);
      const before = snapshotConfig(db);

      const deletedClient = makeMockClient({ channels: new Map() });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(deletedClient, db, stmts),
          basePatch('reception_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
      );

      for (const type of [ChannelType.GuildVoice, ChannelType.PublicThread]) {
        const c = makeMockClient({
          channels: new Map([[CHANNEL_ID, makeChannel(CHANNEL_ID, { type })]]),
        });
        await assert.rejects(
          () => applyGuildConfigSectionWrite(
            writeCtx(c, db, stmts),
            basePatch('reception_channel', { channel_id: CHANNEL_ID }),
          ),
          (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
        );
      }

      const other = makeMockClient({
        channels: new Map([[CHANNEL_ID, makeChannel(CHANNEL_ID, { guildId: OTHER_GUILD })]]),
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(other, db, stmts),
          basePatch('reception_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
      );

      assert.strictEqual(snapshotConfig(db), before);
    });
  });

  it('command_channel: deleted, voice, thread, other guild => INVALID_CHANNEL', async () => {
    await withTempDb(async (db, stmts) => {
      const before = snapshotConfig(db);
      const deleted = makeMockClient({ channels: new Map() });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(deleted, db, stmts),
          basePatch('command_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
      );

      for (const type of [ChannelType.GuildVoice, ChannelType.PublicThread]) {
        const c = makeMockClient({
          channels: new Map([[CHANNEL_ID, makeChannel(CHANNEL_ID, { type })]]),
        });
        await assert.rejects(
          () => applyGuildConfigSectionWrite(
            writeCtx(c, db, stmts),
            basePatch('command_channel', { channel_id: CHANNEL_ID }),
          ),
          (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
        );
      }

      const other = makeMockClient({
        channels: new Map([[CHANNEL_ID, makeChannel(CHANNEL_ID, { guildId: OTHER_GUILD })]]),
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(other, db, stmts),
          basePatch('command_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
      );
      assert.strictEqual(snapshotConfig(db), before);
    });
  });
});

describe('Web5F — bot permissions reception (convention INVALID_CHANNEL)', () => {
  it('manque ViewChannel / SendMessages / EmbedLinks séparément => INVALID_CHANNEL, aucun write', async () => {
    await withTempDb(async (db, stmts) => {
      enableReceptionBypass(stmts);
      const before = snapshotConfig(db);
      const variants = [
        { view: false, send: true, embed: true },
        { view: true, send: false, embed: true },
        { view: true, send: true, embed: false },
      ];
      for (const perms of variants) {
        const client = makeMockClient({
          channels: new Map([[CHANNEL_ID, makeChannel(CHANNEL_ID, perms)]]),
        });
        await assert.rejects(
          () => applyGuildConfigSectionWrite(
            writeCtx(client, db, stmts),
            basePatch('reception_channel', { channel_id: CHANNEL_ID }),
          ),
          (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
        );
      }
      assert.strictEqual(snapshotConfig(db), before);
    });
  });
});

describe('Web5F — reception gate', () => {
  it('allowed write ; denied => RECEPTION_NOT_ALLOWED, pas dashboard, DB inchangée', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient({
        channels: new Map([[CHANNEL_ID, makeChannel()]]),
        memberCount: 200,
      });
      const ctx = writeCtx(client, db, stmts);
      const before = snapshotConfig(db);
      stopDashboardRefreshJob();

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('reception_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'RECEPTION_NOT_ALLOWED',
      );
      assert.strictEqual(snapshotConfig(db), before);
      assert.strictEqual(isNetworkDashboardUpdateScheduled(), false);

      enableReceptionBypass(stmts);
      const ok = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('reception_channel', { channel_id: CHANNEL_ID }),
      );
      assert.strictEqual(ok.noop, false);
      assert.ok(isNetworkDashboardUpdateScheduled());
      stopDashboardRefreshJob();
    });
  });
});

describe('Web5F — role validation', () => {
  it('0 / 6 / duplicates / @everyone / deleted / other guild / managed ok', async () => {
    await withTempDb(async (db, stmts) => {
      const roles = new Map([
        [ROLE_A, makeRole(ROLE_A)],
        [ROLE_B, makeRole(ROLE_B)],
        [ROLE_C, makeRole(ROLE_C)],
        [ROLE_D, makeRole(ROLE_D)],
        [ROLE_E, makeRole(ROLE_E)],
        [ROLE_F, makeRole(ROLE_F)],
        ['777777777777777777', makeRole('777777777777777777', GUILD_ID, { managed: true })],
      ]);
      const client = makeMockClient({ roles });
      const ctx = writeCtx(client, db, stmts);
      const before = snapshotConfig(db);

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', { mode: 'roles', role_ids: [] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', {
            mode: 'roles',
            role_ids: [ROLE_A, ROLE_B, ROLE_C, ROLE_D, ROLE_E, ROLE_F],
          }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', { mode: 'roles', role_ids: [GUILD_ID] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_ROLE',
      );

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', {
            mode: 'roles',
            role_ids: ['999999999999999999'],
          }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_ROLE',
      );

      const foreign = makeMockClient({
        roles: new Map([[ROLE_A, makeRole(ROLE_A, OTHER_GUILD)]]),
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          writeCtx(foreign, db, stmts),
          basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_ROLE',
      );

      assert.strictEqual(snapshotConfig(db), before);

      // duplicates dédupliqués → 1 rôle
      const dup = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A, ROLE_A] }),
      );
      assert.deepStrictEqual(dup.config.command_permissions.role_ids, [ROLE_A]);

      // managed autorisé
      const managed = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', {
          mode: 'roles',
          role_ids: ['777777777777777777'],
        }),
      );
      assert.deepStrictEqual(managed.config.command_permissions.role_ids, ['777777777777777777']);
    });
  });
});

describe('Web5F — structure link', () => {
  it('canonicalisation, http interdit, hostname invalide, null remove, noop', async () => {
    await withTempDb(async (db, stmts) => {
      const ctx = writeCtx(makeMockClient(), db, stmts);

      const ok = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('structure_link', { url: 'https://discord.com/invite/HardCode' }),
      );
      assert.strictEqual(ok.config.structure_invite_url, 'https://discord.gg/HardCode');

      const noop = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('structure_link', { url: 'https://discord.gg/HardCode' }),
      );
      assert.strictEqual(noop.noop, true);

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('structure_link', { url: 'http://discord.gg/HardCode' }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('structure_link', { url: 'https://evil.example/invite/x' }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );

      const removed = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('structure_link', { url: null }),
      );
      assert.strictEqual(removed.config.structure_invite_url, null);
      const noopNull = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('structure_link', { url: null }),
      );
      assert.strictEqual(noopNull.noop, true);
    });
  });
});

describe('Web5F — request body / method / bearer / response / survival', () => {
  beforeEach(() => {
    testServer = null;
    testListener = null;
  });
  afterEach(async () => {
    await stopTestServer();
  });

  it('body hardening : malformed, vide, trop gros, section, actor, source, request_id, CT', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);
      const before = snapshotConfig(db);
      const pathCfg = `/internal/guilds/${GUILD_ID}/config`;

      assert.throws(
        () => parseConfigPatchBody(null),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.throws(
        () => parseConfigPatchBody(basePatch('language', { language: 'fr', premium: true })),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.throws(
        () => parseConfigPatchBody({
          ...basePatch('language', { language: 'fr' }),
          section: 'unknown_section',
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.throws(
        () => parseConfigPatchBody({
          request_id: 'x',
          source: 'web',
          section: 'language',
          language: 'fr',
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.throws(
        () => parseConfigPatchBody({
          ...basePatch('language', { language: 'fr' }),
          actor_discord_user_id: 'not-a-snowflake',
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.throws(
        () => parseConfigPatchBody({
          ...basePatch('language', { language: 'fr' }),
          source: 'discord',
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      assert.throws(
        () => parseConfigPatchBody({
          actor_discord_user_id: ACTOR,
          source: 'web',
          section: 'language',
          language: 'fr',
          request_id: '   ',
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );

      const empty = await httpRequest(port, pathCfg, {
        method: 'PATCH',
        rawBody: '   ',
      });
      assert.strictEqual(empty.status, 400);

      const oversized = await httpRequest(port, pathCfg, {
        method: 'PATCH',
        rawBody: Buffer.alloc(CONFIG_PATCH_MAX_BODY_BYTES + 10, 0x61),
      });
      assert.strictEqual(oversized.status, 400);

      const badCt = await httpRequest(port, pathCfg, {
        method: 'PATCH',
        body: basePatch('language', { language: 'en' }),
        contentType: 'text/plain',
      });
      assert.strictEqual(badCt.status, 400);

      assert.strictEqual(snapshotConfig(db), before);
    });
  });

  it('methods GET/PATCH ok ; POST/PUT/DELETE => 405', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);
      const pathCfg = `/internal/guilds/${GUILD_ID}/config`;

      assert.strictEqual((await httpRequest(port, pathCfg)).status, 200);

      const patch = await httpRequest(port, pathCfg, {
        method: 'PATCH',
        body: basePatch('language', { language: 'en' }),
      });
      assert.strictEqual(patch.status, 200);

      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await httpRequest(port, pathCfg, {
          method,
          body: basePatch('language', { language: 'fr' }),
        });
        assert.strictEqual(res.status, 405, method);
      }
    });
  });

  it('bearer absent / vide / faux => 401 ; bon => 200', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);
      const pathCfg = `/internal/guilds/${GUILD_ID}/config`;
      const body = basePatch('inactive_message_policy', { policy: 'keep' });

      assert.strictEqual(
        (await httpRequest(port, pathCfg, { method: 'PATCH', token: null, body })).status,
        401,
      );
      assert.strictEqual(
        (await httpRequest(port, pathCfg, {
          method: 'PATCH',
          authorization: 'Bearer ',
          body,
        })).status,
        401,
      );
      assert.strictEqual(
        (await httpRequest(port, pathCfg, { method: 'PATCH', token: 'wrong-token', body })).status,
        401,
      );
      assert.strictEqual(
        (await httpRequest(port, pathCfg, { method: 'PATCH', body })).status,
        200,
      );
    });
  });

  it('réponse PATCH = forme GET ; pas de champs internes ; survival après erreurs', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient({
        channels: new Map([[CHANNEL_ID, makeChannel()]]),
      });
      const port = await startTestServer(db, client, stmts);
      const pathCfg = `/internal/guilds/${GUILD_ID}/config`;

      // série d'erreurs volontaires
      await httpRequest(port, pathCfg, { method: 'PATCH', token: null, body: { a: 1 } });
      await httpRequest(port, pathCfg, {
        method: 'POST',
        body: basePatch('language', { language: 'en' }),
      });
      await httpRequest(port, pathCfg, {
        method: 'PATCH',
        body: basePatch('language', { language: 'xx' }),
      });
      await httpRequest(port, pathCfg, {
        method: 'PATCH',
        body: basePatch('reception_channel', { channel_id: CHANNEL_ID }),
      });

      const getBefore = await httpRequest(port, pathCfg);
      assert.strictEqual(getBefore.status, 200);

      const patch = await httpRequest(port, pathCfg, {
        method: 'PATCH',
        body: basePatch('language', { language: 'en' }),
      });
      assert.strictEqual(patch.status, 200);
      assert.strictEqual(patch.body.guild_id, GUILD_ID);
      assert.ok(!('actor_discord_user_id' in patch.body));
      assert.ok(!('request_id' in patch.body));
      assert.ok(!('source' in patch.body));
      assert.ok(!('noop' in patch.body));
      assert.ok(!('section' in patch.body));

      const getAfter = await httpRequest(port, pathCfg);
      assert.strictEqual(getAfter.status, 200);
      assert.deepStrictEqual(patch.body, getAfter.body);
      assert.deepStrictEqual(patch.body, fetchGuildConfig(db, GUILD_ID));
    });
  });
});

describe('Web5F — no network await in transaction (garde structurelle)', () => {
  it('transactionReplaceScrimAllowedRoles est sync (pas d’await dans le corps)', () => {
    const src = Function.prototype.toString.call(transactionReplaceScrimAllowedRoles);
    assert.ok(!/\bawait\b/.test(src), 'aucun await dans transactionReplaceScrimAllowedRoles');
    assert.ok(/db\.transaction/.test(src), 'utilise db.transaction');
  });
});
