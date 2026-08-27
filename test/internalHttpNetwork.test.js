/**
 * Web4B — GET /internal/network/overview (READ-ONLY, anonyme).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb } from '../src/database/db.js';
import { fetchNetworkOverview } from '../src/internalHttp/index.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';

const TEST_TOKEN = 'test-internal-token-web4b';
const GUILD_A = '1484520688726311012';
const GUILD_B = '1436848619796828322';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-internal-network-'));
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

function insertScrimPost(db, {
  originGuildId,
  status = 'active',
  publicId = Math.floor(Math.random() * 90000) + 1,
  createdAt = Date.now(),
  authorUserId = 'author-secret',
}) {
  db.prepare(
    `INSERT INTO scrim_posts (
      scrim_public_id, author_user_id, origin_guild_id, source_guild_id,
      game_key, rank_key, format_key, contact_user_id, contact_display_name,
      scheduled_date, scheduled_time, scheduled_at, scheduled_at_end, tags,
      multi_opgg_url, elo_precision, structure_guild_id, structure_name_snapshot,
      structure_invite_url_snapshot, created_at, status, closed_at, closed_reason
    ) VALUES (
      ?, ?, ?, ?,
      'league_of_legends', 'Gold', 'BO1', ?, NULL,
      '01/09/2026', '20:00', ?, NULL, '[]',
      NULL, NULL, NULL, NULL,
      NULL, ?, ?, NULL, NULL
    )`,
  ).run(
    publicId,
    authorUserId,
    originGuildId,
    originGuildId,
    authorUserId,
    new Date(createdAt + 86400000).toISOString(),
    createdAt,
    status,
  );
}

describe('Web4B network overview — data', () => {
  it('configured_guilds_count DISTINCT (plusieurs mappings même guild)', async () => {
    await withTempDb(async (db) => {
      const ins = db.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
         VALUES (?, ?, ?, 1)`,
      );
      ins.run(GUILD_A, 'c1', 'league_of_legends');
      ins.run(GUILD_A, 'c2', 'rocket_league');
      ins.run(GUILD_B, 'c3', 'league_of_legends');
      const stats = fetchNetworkOverview(db);
      assert.strictEqual(stats.configured_guilds_count, 2);
    });
  });

  it('published / closed / active counts', async () => {
    await withTempDb(async (db) => {
      insertScrimPost(db, { originGuildId: GUILD_A, status: 'active', publicId: 1 });
      insertScrimPost(db, { originGuildId: GUILD_A, status: 'closed_manual', publicId: 2 });
      insertScrimPost(db, { originGuildId: GUILD_B, status: 'closed_expired', publicId: 3 });
      insertScrimPost(db, { originGuildId: GUILD_B, status: 'active', publicId: 4 });
      const stats = fetchNetworkOverview(db);
      assert.strictEqual(stats.published_scrims_count, 4);
      assert.strictEqual(stats.closed_scrims_count, 2);
      assert.strictEqual(stats.active_scrims_count, 2);
    });
  });

  it('recent max 10, newest first, anonymisé', async () => {
    await withTempDb(async (db) => {
      for (let i = 0; i < 12; i += 1) {
        insertScrimPost(db, {
          originGuildId: GUILD_A,
          status: 'active',
          publicId: 100 + i,
          createdAt: i * 1000,
          authorUserId: `user-${i}`,
        });
      }
      const stats = fetchNetworkOverview(db);
      assert.strictEqual(stats.recent.length, 10);
      assert.strictEqual(stats.recent[0].public_id, 111);
      assert.strictEqual(stats.recent[9].public_id, 102);
      assert.ok(stats.recent[0].created_at.endsWith('Z'));

      for (const item of stats.recent) {
        assert.deepStrictEqual(Object.keys(item).sort(), [
          'created_at',
          'game_key',
          'public_id',
          'rank_key',
          'status',
        ]);
        assert.ok(!('guild_id' in item));
        assert.ok(!('origin_guild_id' in item));
        assert.ok(!('author_user_id' in item));
        assert.ok(!('message_id' in item));
        assert.ok(!('id' in item));
      }

      const json = JSON.stringify(stats);
      assert.ok(!json.includes(GUILD_A));
      assert.ok(!json.includes('user-'));
      assert.ok(!json.includes('origin_guild'));
      assert.ok(!json.includes('message_id'));
      assert.ok(!json.includes('author'));
    });
  });

  it('empty DB => counts 0 + recent []', async () => {
    await withTempDb(async (db) => {
      assert.deepStrictEqual(fetchNetworkOverview(db), {
        configured_guilds_count: 0,
        published_scrims_count: 0,
        closed_scrims_count: 0,
        active_scrims_count: 0,
        recent: [],
      });
    });
  });
});

describe('Web4B network overview — HTTP', () => {
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
      const res = await httpRequest(port, '/internal/network/overview', { token: null });
      assert.strictEqual(res.status, 401);
    });
  });

  it('mauvais bearer => 401', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, '/internal/network/overview', { token: 'wrong' });
      assert.strictEqual(res.status, 401);
    });
  });

  it('GET network overview => 200 payload exact', async () => {
    await withTempDb(async (db) => {
      db.prepare(
        `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
         VALUES (?, 'c1', 'league_of_legends', 1)`,
      ).run(GUILD_A);
      insertScrimPost(db, {
        originGuildId: GUILD_A,
        status: 'active',
        publicId: 42,
        createdAt: Date.parse('2026-08-27T05:00:00.000Z'),
      });

      const port = await startTestServer(db);
      const res = await httpRequest(port, '/internal/network/overview');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, {
        configured_guilds_count: 1,
        published_scrims_count: 1,
        closed_scrims_count: 0,
        active_scrims_count: 1,
        recent: [
          {
            public_id: 42,
            status: 'active',
            created_at: '2026-08-27T05:00:00.000Z',
            game_key: 'league_of_legends',
            rank_key: 'Gold',
          },
        ],
      });
      assert.ok(!res.bodyText.includes(TEST_TOKEN));
      assert.ok(!res.bodyText.includes(GUILD_A));
    });
  });

  it('POST même route => 405', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const res = await httpRequest(port, '/internal/network/overview', { method: 'POST' });
      assert.strictEqual(res.status, 405);
    });
  });

  it('routes guild overview/config continuent de fonctionner', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db);
      const overview = await httpRequest(port, `/internal/guilds/${GUILD_A}/overview`);
      assert.strictEqual(overview.status, 200);
      assert.ok('published_count' in overview.body);

      const config = await httpRequest(port, `/internal/guilds/${GUILD_A}/config`);
      assert.strictEqual(config.status, 200);
      assert.ok('language' in config.body);
    });
  });
});
