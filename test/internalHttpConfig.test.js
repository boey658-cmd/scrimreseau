/**
 * Web3B — GET /internal/guilds/:guildId/config (READ-ONLY).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb } from '../src/database/db.js';
import { fetchGuildConfig } from '../src/internalHttp/index.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';

const TEST_TOKEN = 'test-internal-token-web3b';
const VALID_GUILD = '1484520688726311012';
const OTHER_GUILD = '1436848619796828322';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-internal-config-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  try {
    const db = getDb();
    await fn(db);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {number} port
 * @param {string} pathname
 * @param {{ method?: string, token?: string | null }} [opts]
 */
function httpRequest(port, pathname, opts = {}) {
  const method = opts.method ?? 'GET';
  const headers = {};
  if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? TEST_TOKEN}`;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
      },
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
    req.end();
  });
}

/** @type {import('node:http').Server | null} */
let testServer = null;
/** @type {{ stopAccepting?: () => void } | null} */
let testListener = null;

async function startTestServer(db, port = 0) {
  const config = { enabled: true, port, token: TEST_TOKEN };
  const { server, listener, host } = createInternalHttpServer({
    db,
    client: null,
    config,
    port,
  });
  const bound = await listenInternalHttpServer(server, host, port);
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

describe('Web3B config queries — data & fallbacks', () => {
  it('fallback language => fr', async () => {
    await withTempDb(async (db) => {
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      assert.strictEqual(cfg.language, 'fr');
    });
  });

  it('language en', async () => {
    await withTempDb(async (db) => {
      db.prepare(`INSERT INTO guild_languages (guild_id, language) VALUES (?, ?)`).run(
        VALID_GUILD,
        'en',
      );
      assert.strictEqual(fetchGuildConfig(db, VALID_GUILD).language, 'en');
    });
  });

  it('language inconnue normalisée via normalizeLocale (sans violer CHECK DB)', async () => {
    await withTempDb(async (db) => {
      // La table a CHECK(language IN 7 locales) — une valeur hors CHECK ne peut pas
      // entrer en DB. Le fallback runtime reste couvert via normalizeLocale + ligne absente.
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      assert.strictEqual(cfg.language, 'fr');
      const { normalizeEnabledGuildLocale } = await import('../src/i18n/index.js');
      assert.strictEqual(normalizeEnabledGuildLocale('xx'), 'fr');
      assert.strictEqual(normalizeEnabledGuildLocale('EN'), 'en');
      assert.strictEqual(normalizeEnabledGuildLocale('es'), 'es');
    });
  });

  it('reception_channels plusieurs mappings ordonnés', async () => {
    await withTempDb(async (db) => {
      const ins = db.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
         VALUES (?, ?, ?, 1)`,
      );
      ins.run(VALID_GUILD, 'c2', 'rocket_league');
      ins.run(VALID_GUILD, 'c1', 'league_of_legends');
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      assert.deepStrictEqual(cfg.reception_channels, [
        { game_key: 'league_of_legends', channel_id: 'c1' },
        { game_key: 'rocket_league', channel_id: 'c2' },
      ]);
    });
  });

  it('reception_channels vide', async () => {
    await withTempDb(async (db) => {
      assert.deepStrictEqual(fetchGuildConfig(db, VALID_GUILD).reception_channels, []);
    });
  });

  it('command_channel_id présent', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO guild_scrim_usage_channel (guild_id, channel_id) VALUES (?, ?)`,
      ).run(VALID_GUILD, '999888777666555444');
      assert.strictEqual(
        fetchGuildConfig(db, VALID_GUILD).command_channel_id,
        '999888777666555444',
      );
    });
  });

  it('command_channel_id null', async () => {
    await withTempDb(async (db) => {
      assert.strictEqual(fetchGuildConfig(db, VALID_GUILD).command_channel_id, null);
    });
  });

  it('inactive policy keep', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO guild_scrim_message_lifecycle_policy (guild_id, policy, updated_at)
         VALUES (?, 'keep', 'now')`,
      ).run(VALID_GUILD);
      assert.strictEqual(fetchGuildConfig(db, VALID_GUILD).inactive_message_policy, 'keep');
    });
  });

  it('inactive policy delete', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO guild_scrim_message_lifecycle_policy (guild_id, policy, updated_at)
         VALUES (?, 'delete', 'now')`,
      ).run(VALID_GUILD);
      assert.strictEqual(fetchGuildConfig(db, VALID_GUILD).inactive_message_policy, 'delete');
    });
  });

  it('fallback policy => keep', async () => {
    await withTempDb(async (db) => {
      assert.strictEqual(fetchGuildConfig(db, VALID_GUILD).inactive_message_policy, 'keep');
    });
  });

  it('structure URL valide', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO structure_discord_links (guild_id, discord_invite_url, updated_at, updated_by)
         VALUES (?, ?, 'now', 'tester')`,
      ).run(VALID_GUILD, 'https://discord.gg/abcdef');
      assert.strictEqual(
        fetchGuildConfig(db, VALID_GUILD).structure_invite_url,
        'https://discord.gg/abcdef',
      );
    });
  });

  it('structure URL DB invalide => null', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO structure_discord_links (guild_id, discord_invite_url, updated_at, updated_by)
         VALUES (?, ?, 'now', 'tester')`,
      ).run(VALID_GUILD, 'https://evil.example/not-discord');
      assert.strictEqual(fetchGuildConfig(db, VALID_GUILD).structure_invite_url, null);
    });
  });

  it('permissions everyone', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO guild_scrim_permissions (guild_id, mode) VALUES (?, 'everyone')`,
      ).run(VALID_GUILD);
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      assert.deepStrictEqual(cfg.command_permissions, { mode: 'everyone', role_ids: [] });
    });
  });

  it('permissions roles + role_ids ordonnés', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO guild_scrim_permissions (guild_id, mode) VALUES (?, 'roles')`,
      ).run(VALID_GUILD);
      const ins = db.prepare(
        `INSERT INTO guild_scrim_allowed_roles (guild_id, role_id) VALUES (?, ?)`,
      );
      ins.run(VALID_GUILD, '222');
      ins.run(VALID_GUILD, '111');
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      assert.strictEqual(cfg.command_permissions.mode, 'roles');
      assert.deepStrictEqual(cfg.command_permissions.role_ids, ['111', '222']);
    });
  });

  it('fallback permissions => everyone', async () => {
    await withTempDb(async (db) => {
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      assert.deepStrictEqual(cfg.command_permissions, { mode: 'everyone', role_ids: [] });
    });
  });

  it('isolation entre deux guilds', async () => {
    await withTempDb(async (db) => {
      db.prepare(`INSERT INTO guild_languages (guild_id, language) VALUES (?, 'en')`).run(
        VALID_GUILD,
      );
      db.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
         VALUES (?, 'c-a', 'league_of_legends', 1)`,
      ).run(VALID_GUILD);
      db.prepare(
        `INSERT INTO guild_scrim_message_lifecycle_policy (guild_id, policy, updated_at)
         VALUES (?, 'delete', 'now')`,
      ).run(VALID_GUILD);

      const a = fetchGuildConfig(db, VALID_GUILD);
      const b = fetchGuildConfig(db, OTHER_GUILD);
      assert.strictEqual(a.language, 'en');
      assert.strictEqual(a.inactive_message_policy, 'delete');
      assert.strictEqual(a.reception_channels.length, 1);
      assert.strictEqual(b.language, 'fr');
      assert.strictEqual(b.inactive_message_policy, 'keep');
      assert.deepStrictEqual(b.reception_channels, []);
    });
  });

  it('aucun champ interne exposé', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO structure_discord_links (guild_id, discord_invite_url, updated_at, updated_by)
         VALUES (?, ?, 'secret-ts', 'secret-user')`,
      ).run(VALID_GUILD, 'https://discord.gg/okcode');
      const cfg = fetchGuildConfig(db, VALID_GUILD);
      const json = JSON.stringify(cfg);
      assert.ok(!json.includes('updated_by'));
      assert.ok(!json.includes('updated_at'));
      assert.ok(!json.includes('secret-user'));
      assert.ok(!json.includes('secret-ts'));
      assert.ok(!json.includes('bypass'));
      assert.ok(!('channel_principal' in cfg));
      assert.ok(!('announcements' in cfg));
      assert.deepStrictEqual(Object.keys(cfg).sort(), [
        'command_channel_id',
        'command_permissions',
        'guild_id',
        'inactive_message_policy',
        'language',
        'reception_channels',
        'structure_invite_url',
      ]);
    });
  });
});

describe('Web3B config HTTP', () => {
  beforeEach(() => {
    testServer = null;
    testListener = null;
  });
  afterEach(async () => {
    await stopTestServer();
  });

  it('bearer absent => 401', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/config`, { token: null });
      assert.strictEqual(res.status, 401);
    });
  });

  it('mauvais bearer => 401', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/config`, {
        token: 'wrong',
      });
      assert.strictEqual(res.status, 401);
    });
  });

  it('invalid guild => 400', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, '/internal/guilds/bad/config');
      assert.strictEqual(res.status, 400);
    });
  });

  it('GET config => 200 payload exact', async () => {
    await withTempDb(async (db) => {
      db.prepare(`INSERT INTO guild_languages (guild_id, language) VALUES (?, 'fr')`).run(
        VALID_GUILD,
      );
      db.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
         VALUES (?, '111', 'league_of_legends', 1)`,
      ).run(VALID_GUILD);
      const port = await startTestServer(db);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/config`);
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, {
        guild_id: VALID_GUILD,
        language: 'fr',
        reception_channels: [{ game_key: 'league_of_legends', channel_id: '111' }],
        command_channel_id: null,
        inactive_message_policy: 'keep',
        structure_invite_url: null,
        command_permissions: { mode: 'everyone', role_ids: [] },
      });
      assert.ok(!res.bodyText.includes('updated_by'));
      assert.ok(!res.bodyText.includes(TEST_TOKEN));
    });
  });

  it('POST config => 405', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/config`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 405);
    });
  });

  it('overview existant continue de fonctionner', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/overview`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.guild_id, VALID_GUILD);
      assert.ok('published_count' in res.body);
      assert.ok(!('language' in res.body));
    });
  });
});
