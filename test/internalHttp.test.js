/**
 * Web2B — serveur HTTP interne GET-only (localhost).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb } from '../src/database/db.js';
import {
  parseInternalHttpConfig,
  isInternalHttpEnabled,
  parseGuildIdParam,
  fetchGuildOverview,
  verifyInternalHttpToken,
} from '../src/internalHttp/index.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';

const TEST_TOKEN = 'test-internal-token-web2b';
const VALID_GUILD = '1484520688726311012';
const OTHER_GUILD = '1436848619796828322';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-internal-http-'));
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

function insertScrimPost(db, {
  originGuildId,
  status = 'active',
  publicId = Math.floor(Math.random() * 90000) + 1,
  createdAt = Date.now(),
}) {
  db.prepare(
    `INSERT INTO scrim_posts (
      scrim_public_id, author_user_id, origin_guild_id, source_guild_id,
      game_key, rank_key, format_key, contact_user_id, contact_display_name,
      scheduled_date, scheduled_time, scheduled_at, scheduled_at_end, tags,
      multi_opgg_url, elo_precision, structure_guild_id, structure_name_snapshot,
      structure_invite_url_snapshot, created_at, status, closed_at, closed_reason
    ) VALUES (
      ?, 'author', ?, ?,
      'league_of_legends', 'Gold', 'BO1', 'author', NULL,
      '01/09/2026', '20:00', ?, NULL, '[]',
      NULL, NULL, NULL, NULL,
      NULL, ?, ?, NULL, NULL
    )`,
  ).run(
    publicId,
    originGuildId,
    originGuildId,
    new Date(createdAt + 86400000).toISOString(),
    createdAt,
    status,
  );
}

/** @type {import('node:http').Server | null} */
let testServer = null;

/** @type {ReturnType<import('../src/internalHttp/server.js').createInternalHttpRequestListener> | null} */
let testListener = null;

async function startTestServer(db, client, port = 0) {
  const config = { enabled: true, port, token: TEST_TOKEN };
  const { server, listener, host } = createInternalHttpServer({
    db,
    client,
    config,
    port,
  });
  const bound = await listenInternalHttpServer(server, host, port);
  testServer = server;
  testListener = listener;
  return bound.port;
}

async function stopTestServer() {
  if (testListener?.stopAccepting) {
    testListener.stopAccepting();
  }
  if (testServer) {
    await closeInternalHttpServer(testServer);
  }
  testServer = null;
  testListener = null;
}

describe('Web2B internal HTTP — config', () => {
  it('port absent => désactivé', () => {
    const cfg = parseInternalHttpConfig({});
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(isInternalHttpEnabled(cfg), false);
  });

  it('port sans token => fail-fast', () => {
    assert.throws(
      () => parseInternalHttpConfig({ INTERNAL_HTTP_PORT: '8081' }),
      /INTERNAL_HTTP_TOKEN obligatoire/,
    );
  });

  it('port invalide => fail-fast', () => {
    assert.throws(
      () => parseInternalHttpConfig({ INTERNAL_HTTP_PORT: 'abc', INTERNAL_HTTP_TOKEN: 'x' }),
      /INTERNAL_HTTP_PORT invalide/,
    );
  });

  it('port hors plage => fail-fast', () => {
    assert.throws(
      () => parseInternalHttpConfig({ INTERNAL_HTTP_PORT: '70000', INTERNAL_HTTP_TOKEN: 'x' }),
      /hors plage/,
    );
  });

  it('config valide => enabled', () => {
    const cfg = parseInternalHttpConfig({
      INTERNAL_HTTP_PORT: '8081',
      INTERNAL_HTTP_TOKEN: 'secret',
    });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.port, 8081);
    assert.strictEqual(cfg.token, 'secret');
  });
});

describe('Web2B internal HTTP — auth & guild id', () => {
  it('verifyInternalHttpToken timing-safe OK/KO', () => {
    assert.strictEqual(verifyInternalHttpToken('abc', 'abc'), true);
    assert.strictEqual(verifyInternalHttpToken('abc', 'abd'), false);
  });

  it('parseGuildIdParam valide snowflake string', () => {
    assert.strictEqual(parseGuildIdParam(VALID_GUILD), VALID_GUILD);
    assert.strictEqual(parseGuildIdParam('abc'), null);
    assert.strictEqual(parseGuildIdParam('123'), null);
  });
});

describe('Web2B internal HTTP — overview data', () => {
  it('published_count / closed_count / recent / isolation guild', async () => {
    await withTempDb(async (db) => {
      insertScrimPost(db, { originGuildId: VALID_GUILD, status: 'active', publicId: 101, createdAt: 1000 });
      insertScrimPost(db, { originGuildId: VALID_GUILD, status: 'closed_manual', publicId: 102, createdAt: 2000 });
      insertScrimPost(db, { originGuildId: VALID_GUILD, status: 'closed_expired', publicId: 103, createdAt: 3000 });
      insertScrimPost(db, { originGuildId: OTHER_GUILD, status: 'active', publicId: 201, createdAt: 4000 });

      db.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
         VALUES (?, 'chan', 'league_of_legends', 1)`,
      ).run(VALID_GUILD);

      const stats = fetchGuildOverview(db, VALID_GUILD);
      assert.strictEqual(stats.published_count, 3);
      assert.strictEqual(stats.closed_count, 2);
      assert.strictEqual(stats.configured, true);
      assert.strictEqual(stats.recent.length, 3);
      assert.strictEqual(stats.recent[0].public_id, 103);
      assert.strictEqual(stats.recent[0].status, 'closed_expired');
      assert.ok(typeof stats.recent[0].created_at === 'string');
      assert.strictEqual(stats.recent[0].game_key, 'league_of_legends');
      assert.strictEqual(stats.recent[0].rank_key, 'Gold');
      assert.ok(!('id' in stats.recent[0]));
    });
  });

  it('recent max 10', async () => {
    await withTempDb(async (db) => {
      for (let i = 0; i < 12; i += 1) {
        insertScrimPost(db, {
          originGuildId: VALID_GUILD,
          status: 'active',
          publicId: 1000 + i,
          createdAt: i * 1000,
        });
      }
      const stats = fetchGuildOverview(db, VALID_GUILD);
      assert.strictEqual(stats.recent.length, 10);
      assert.strictEqual(stats.recent[0].public_id, 1011);
    });
  });
});

describe('Web2B internal HTTP — HTTP surface', () => {
  beforeEach(async () => {
    testServer = null;
    testListener = null;
  });

  afterEach(async () => {
    await stopTestServer();
  });

  it('bind 127.0.0.1 + overview 200 avec bon token', async () => {
    await withTempDb(async (db) => {
      insertScrimPost(db, { originGuildId: VALID_GUILD, status: 'active', publicId: 42 });
      const mockClient = {
        guilds: { cache: { has: (id) => id === VALID_GUILD } },
      };
      const port = await startTestServer(db, mockClient);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/overview`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.guild_id, VALID_GUILD);
      assert.strictEqual(res.body.bot_installed, true);
      assert.strictEqual(res.body.published_count, 1);
      assert.strictEqual(res.body.closed_count, 0);
      assert.deepStrictEqual(res.body.recent[0].public_id, 42);
      assert.ok(!/\"id\"\s*:/.test(res.bodyText));
      assert.ok(!res.bodyText.includes('message_id'));
      assert.ok(!res.bodyText.includes(TEST_TOKEN));
    });
  });

  it('token absent => 401', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, null);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/overview`, { token: null });
      assert.strictEqual(res.status, 401);
    });
  });

  it('mauvais token => 401', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, null);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/overview`, { token: 'wrong' });
      assert.strictEqual(res.status, 401);
    });
  });

  it('invalid guild => 400', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, null);
      const res = await httpRequest(port, '/internal/guilds/not-a-snowflake/overview');
      assert.strictEqual(res.status, 400);
    });
  });

  it('POST même route => 405', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, null);
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/overview`, { method: 'POST' });
      assert.strictEqual(res.status, 405);
    });
  });

  it('route inconnue => 404', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, null);
      const res = await httpRequest(port, '/internal/unknown');
      assert.strictEqual(res.status, 404);
    });
  });
});

describe('Web2B internal HTTP — shutdown', () => {
  it('stopAccepting => 503 avant fermeture socket', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, null);
      testListener?.stopAccepting?.();
      const res = await httpRequest(port, `/internal/guilds/${VALID_GUILD}/overview`);
      assert.strictEqual(res.status, 503);
      await stopTestServer();
    });
  });

  it('index.js inclut internal_http_stop dans les steps shutdown', () => {
    const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const stepsMatch = src.match(/steps:\s*\[[\s\S]*?\n\s*\],/);
    assert.ok(stepsMatch, 'bloc steps gracefulShutdown introuvable');
    const stepsBlock = stepsMatch[0];
    assert.match(stepsBlock, /internal_http_stop/);
    const internalIdx = stepsBlock.indexOf('internal_http_stop');
    const taskQueueIdx = stepsBlock.indexOf('discord_task_queue_stop');
    assert.ok(internalIdx > taskQueueIdx, 'internal_http doit être après task queue');
    assert.match(src, /stopInternalHttpServer/);
    assert.match(src, /startInternalHttpServer/);
  });
});
