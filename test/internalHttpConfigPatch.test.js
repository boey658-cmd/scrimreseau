/**
 * Web5B — PATCH /internal/guilds/:guildId/config
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
import { parseConfigPatchBody, ConfigWriteError } from '../src/internalHttp/configPatch.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';
import { assertActorCanManageGuildConfig } from '../src/services/guildConfigWriteAuthz.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';

const TEST_TOKEN = 'test-internal-token-web5b';
const GUILD_ID = '1484520688726311012';
const OTHER_GUILD = '1436848619796828322';
const ACTOR = '1009269632693174422';
const CHANNEL_ID = '1070686329991602240';
const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-web5b-'));
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

function makeMember({ admin = false, manageGuild = false, owner = false } = {}) {
  const bits = new PermissionsBitField();
  if (admin) bits.add(PermissionFlagsBits.Administrator);
  if (manageGuild) bits.add(PermissionFlagsBits.ManageGuild);
  return {
    id: ACTOR,
    permissions: bits,
  };
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
  } = opts;

  const guild = {
    id: GUILD_ID,
    ownerId,
    memberCount: 200,
    members: {
      me: {
        id: 'bot',
        permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      },
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
        if (channels.has(id)) return channels.get(id);
        return null;
      },
    },
    roles: {
      cache: {
        get: (id) => roles.get(id) ?? null,
      },
      fetch: async (id) => {
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

function makeTextChannel(id = CHANNEL_ID, botCanPost = true) {
  return {
    id,
    type: ChannelType.GuildText,
    permissionsFor: () => {
      if (!botCanPost) return new PermissionsBitField();
      return new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]);
    },
  };
}

function basePatch(section, extra = {}) {
  return {
    actor_discord_user_id: ACTOR,
    request_id: 'req-1',
    source: 'web',
    section,
    ...extra,
  };
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
 * @param {{ method?: string, token?: string | null, body?: unknown, contentType?: string | null }} [opts]
 */
function httpRequest(port, pathname, opts = {}) {
  const method = opts.method ?? 'GET';
  /** @type {Record<string, string>} */
  const headers = {};
  if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? TEST_TOKEN}`;
  }
  let bodyBuf = null;
  if (opts.body !== undefined) {
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

describe('Web5B — parseConfigPatchBody', () => {
  it('refuse champs inconnus / multi-section latente', () => {
    assert.throws(
      () => parseConfigPatchBody(basePatch('language', { language: 'fr', premium: true })),
      (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('accepte language', () => {
    const p = parseConfigPatchBody(basePatch('language', { language: 'en' }));
    assert.strictEqual(p.section, 'language');
    assert.strictEqual(p.actorDiscordUserId, ACTOR);
  });
});

describe('Web5B — authz live', () => {
  it('admin / ManageGuild / owner autorisés ; member 403', async () => {
    await assertActorCanManageGuildConfig({
      client: /** @type {any} */ (makeMockClient({ member: makeMember({ admin: true }) })),
      guildId: GUILD_ID,
      actorDiscordUserId: ACTOR,
    });
    await assertActorCanManageGuildConfig({
      client: /** @type {any} */ (makeMockClient({ member: makeMember({ manageGuild: true }) })),
      guildId: GUILD_ID,
      actorDiscordUserId: ACTOR,
    });
    await assertActorCanManageGuildConfig({
      client: /** @type {any} */ (
        makeMockClient({ member: makeMember(), ownerId: ACTOR })
      ),
      guildId: GUILD_ID,
      actorDiscordUserId: ACTOR,
    });
    await assert.rejects(
      () => assertActorCanManageGuildConfig({
        client: /** @type {any} */ (makeMockClient({ member: makeMember() })),
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      }),
      (err) => err instanceof ConfigWriteError && err.code === 'GUILD_NOT_MANAGEABLE',
    );
  });

  it('actor absent => 403 ; bot absent => 409 ; timeout => 503', async () => {
    await assert.rejects(
      () => assertActorCanManageGuildConfig({
        client: /** @type {any} */ (makeMockClient({ member: null })),
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      }),
      (err) => err instanceof ConfigWriteError && err.code === 'GUILD_NOT_MANAGEABLE',
    );

    await assert.rejects(
      () => assertActorCanManageGuildConfig({
        client: /** @type {any} */ (makeMockClient({ guildPresent: false })),
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      }),
      (err) => err instanceof ConfigWriteError && err.code === 'BOT_NOT_INSTALLED',
    );

    const timeoutErr = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    await assert.rejects(
      () => assertActorCanManageGuildConfig({
        client: /** @type {any} */ (makeMockClient({ memberError: timeoutErr })),
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      }),
      (err) => err instanceof ConfigWriteError && err.code === 'BOT_UNAVAILABLE',
    );
  });
});

describe('Web5B — writes sections', () => {
  it('language success + noop + isolation', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const ctx = {
        client: /** @type {any} */ (client),
        guild: client._guild,
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };
      const r1 = await applyGuildConfigSectionWrite(ctx, basePatch('language', { language: 'en' }));
      assert.strictEqual(r1.noop, false);
      assert.strictEqual(r1.config.language, 'en');
      const r2 = await applyGuildConfigSectionWrite(ctx, basePatch('language', { language: 'en' }));
      assert.strictEqual(r2.noop, true);
      assert.strictEqual(fetchGuildConfig(db, OTHER_GUILD).language, 'fr');
    });
  });

  it('reception_channel set/delete + gate + invalid type + bot perms', async () => {
    await withTempDb(async (db, stmts) => {
      const channel = makeTextChannel();
      const client = makeMockClient({ channels: new Map([[CHANNEL_ID, channel]]) });
      const ctx = {
        client: /** @type {any} */ (client),
        guild: client._guild,
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };

      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, basePatch('reception_channel', { channel_id: CHANNEL_ID })),
        (err) => err instanceof ConfigWriteError && err.code === 'RECEPTION_NOT_ALLOWED',
      );

      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: GUILD_ID,
        bypass_member_minimum: 1,
        updated_by: ACTOR,
        updated_at: new Date().toISOString(),
        note: null,
      });

      const ok = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('reception_channel', { channel_id: CHANNEL_ID }),
      );
      assert.strictEqual(ok.noop, false);
      assert.strictEqual(
        ok.config.reception_channels.find((c) => c.game_key === UI_PRIMARY_GAME_KEY)?.channel_id,
        CHANNEL_ID,
      );

      const noop = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('reception_channel', { channel_id: CHANNEL_ID }),
      );
      assert.strictEqual(noop.noop, true);

      // autre game_key historique non touché
      stmts.upsertGuildChannel.run({
        guild_id: GUILD_ID,
        channel_id: '333333333333333333',
        game_key: 'rocket_league',
        created_at: Date.now(),
      });
      await applyGuildConfigSectionWrite(ctx, basePatch('reception_channel', { channel_id: null }));
      const after = fetchGuildConfig(db, GUILD_ID);
      assert.ok(after.reception_channels.some((c) => c.game_key === 'rocket_league'));
      assert.ok(!after.reception_channels.some((c) => c.game_key === UI_PRIMARY_GAME_KEY));

      const badPermsClient = makeMockClient({
        channels: new Map([[CHANNEL_ID, makeTextChannel(CHANNEL_ID, false)]]),
      });
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: GUILD_ID,
        bypass_member_minimum: 1,
        updated_by: ACTOR,
        updated_at: new Date().toISOString(),
        note: null,
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          {
            client: /** @type {any} */ (badPermsClient),
            guild: badPermsClient._guild,
            db,
            stmts,
            guildId: GUILD_ID,
            actorDiscordUserId: ACTOR,
          },
          basePatch('reception_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
      );
    });
  });

  it('command_channel fetch hors cache + type', async () => {
    await withTempDb(async (db, stmts) => {
      const channel = makeTextChannel();
      const client = makeMockClient({ channels: new Map() });
      client._guild.channels.fetch = async (id) => (id === CHANNEL_ID ? channel : null);
      const ctx = {
        client: /** @type {any} */ (client),
        guild: client._guild,
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };
      const r = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_channel', { channel_id: CHANNEL_ID }),
      );
      assert.strictEqual(r.config.command_channel_id, CHANNEL_ID);
      await applyGuildConfigSectionWrite(ctx, basePatch('command_channel', { channel_id: null }));
      assert.strictEqual(fetchGuildConfig(db, GUILD_ID).command_channel_id, null);

      client._guild.channels.fetch = async () => ({
        id: CHANNEL_ID,
        type: ChannelType.GuildVoice,
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_channel', { channel_id: CHANNEL_ID }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_CHANNEL',
      );
    });
  });

  it('inactive_message_policy keep/delete + noop', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const ctx = {
        client: /** @type {any} */ (client),
        guild: client._guild,
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };
      const r = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('inactive_message_policy', { policy: 'delete' }),
      );
      assert.strictEqual(r.config.inactive_message_policy, 'delete');
      const noop = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('inactive_message_policy', { policy: 'delete' }),
      );
      assert.strictEqual(noop.noop, true);
    });
  });

  it('structure_link canonicalize + invalid + delete', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const ctx = {
        client: /** @type {any} */ (client),
        guild: client._guild,
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };
      const r = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('structure_link', { url: 'https://discord.com/invite/AbCdEf' }),
      );
      assert.strictEqual(r.config.structure_invite_url, 'https://discord.gg/AbCdEf');
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('structure_link', { url: 'https://evil.test/x' }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
      );
      await applyGuildConfigSectionWrite(ctx, basePatch('structure_link', { url: null }));
      assert.strictEqual(fetchGuildConfig(db, GUILD_ID).structure_invite_url, null);
    });
  });

  it('command_permissions roles/everyone/@everyone/empty/invalid/rollback', async () => {
    await withTempDb(async (db, stmts) => {
      const roles = new Map([
        [ROLE_A, { id: ROLE_A, guild: { id: GUILD_ID } }],
        [ROLE_B, { id: ROLE_B, guild: { id: GUILD_ID } }],
      ]);
      const client = makeMockClient({ roles });
      const ctx = {
        client: /** @type {any} */ (client),
        guild: client._guild,
        db,
        stmts,
        guildId: GUILD_ID,
        actorDiscordUserId: ACTOR,
      };

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
          basePatch('command_permissions', { mode: 'roles', role_ids: [GUILD_ID] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_ROLE',
      );

      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', { mode: 'roles', role_ids: ['333333333333333333'] }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INVALID_ROLE',
      );

      const ok = await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', { mode: 'roles', role_ids: [ROLE_A] }),
      );
      assert.strictEqual(ok.config.command_permissions.mode, 'roles');
      assert.deepStrictEqual(ok.config.command_permissions.role_ids, [ROLE_A]);

      // rollback si insert échoue après delete (écriture réelle, pas noop)
      const origInsert = stmts.insertScrimAllowedRole.run.bind(stmts.insertScrimAllowedRole);
      let calls = 0;
      stmts.insertScrimAllowedRole.run = (...args) => {
        calls += 1;
        if (calls >= 2) throw new Error('forced insert fail');
        return origInsert(...args);
      };
      await assert.rejects(
        () => applyGuildConfigSectionWrite(
          ctx,
          basePatch('command_permissions', {
            mode: 'roles',
            role_ids: [ROLE_A, ROLE_B],
          }),
        ),
        (err) => err instanceof ConfigWriteError && err.code === 'INTERNAL_ERROR',
      );
      // état inchangé grâce au rollback transaction
      const afterFail = fetchGuildConfig(db, GUILD_ID);
      assert.deepStrictEqual(afterFail.command_permissions.role_ids, [ROLE_A]);
      stmts.insertScrimAllowedRole.run = origInsert;

      await applyGuildConfigSectionWrite(
        ctx,
        basePatch('command_permissions', { mode: 'everyone', role_ids: [] }),
      );
      assert.deepStrictEqual(fetchGuildConfig(db, GUILD_ID).command_permissions, {
        mode: 'everyone',
        role_ids: [],
      });
    });
  });
});

describe('Web5B — HTTP PATCH', () => {
  beforeEach(() => {
    testServer = null;
    testListener = null;
  });
  afterEach(async () => {
    await stopTestServer();
  });

  it('bearer absent/mauvais => 401 ; invalid JSON ; content-type ; PATCH 200', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);

      const noTok = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
        method: 'PATCH',
        token: null,
        body: basePatch('language', { language: 'fr' }),
      });
      assert.strictEqual(noTok.status, 401);

      const badTok = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
        method: 'PATCH',
        token: 'wrong',
        body: basePatch('language', { language: 'fr' }),
      });
      assert.strictEqual(badTok.status, 401);

      const badJson = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/internal/guilds/${GUILD_ID}/config`,
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${TEST_TOKEN}`,
              'Content-Type': 'application/json',
              'Content-Length': 3,
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            });
          },
        );
        req.on('error', reject);
        req.write('{a}');
        req.end();
      });
      assert.strictEqual(badJson.status, 400);
      assert.strictEqual(badJson.body.error, 'VALIDATION_ERROR');

      const badCt = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
        method: 'PATCH',
        body: basePatch('language', { language: 'en' }),
        contentType: 'text/plain',
      });
      assert.strictEqual(badCt.status, 400);

      const ok = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
        method: 'PATCH',
        body: basePatch('language', { language: 'en' }),
      });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.language, 'en');
      assert.ok('command_permissions' in ok.body);
    });
  });

  it('POST => 405 ; GET routes intactes', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeMockClient();
      const port = await startTestServer(db, client, stmts);

      const post = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`, {
        method: 'POST',
        body: basePatch('language', { language: 'fr' }),
      });
      assert.strictEqual(post.status, 405);

      const getCfg = await httpRequest(port, `/internal/guilds/${GUILD_ID}/config`);
      assert.strictEqual(getCfg.status, 200);
      assert.ok('language' in getCfg.body);

      const overview = await httpRequest(port, `/internal/guilds/${GUILD_ID}/overview`);
      assert.strictEqual(overview.status, 200);

      const network = await httpRequest(port, '/internal/network/overview');
      assert.strictEqual(network.status, 200);
    });
  });
});
