/**
 * Tests — partenaires publics /network (buildPublicNetworkPartners + HTTP interne).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { fetchNetworkPartners } from '../src/internalHttp/index.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';
import { buildPublicNetworkPartners } from '../src/services/publicNetworkPartners.js';
import { fileURLToPath } from 'node:url';

const TEST_TOKEN = 'test-internal-token-partners';
const GUILD_A = '1000000000000000001';
const GUILD_B = '1000000000000000002';
const GUILD_C = '1000000000000000003';
const GUILD_GHOST = '1000000000000000099';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-network-partners-'));
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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {unknown} client
 * @param {number} [port]
 */
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
  if (testListener?.stopAccepting) testListener.stopAccepting();
  if (testServer) await closeInternalHttpServer(testServer);
  testServer = null;
  testListener = null;
}

afterEach(async () => {
  await stopTestServer();
});

/**
 * @param {Map<string, { name: string, icon: string | null }>} map
 */
function mockClient(map) {
  return {
    guilds: {
      cache: {
        get(id) {
          const g = map.get(String(id));
          if (!g) return undefined;
          return {
            name: g.name,
            iconURL({ extension, size } = {}) {
              if (!g.icon) return null;
              return `https://cdn.discordapp.com/icons/${id}/${g.icon}.${extension ?? 'png'}?size=${size ?? 128}`;
            },
          };
        },
      },
    },
  };
}

function insertPartner(db, guildId, channelId = 'ch1') {
  db.prepare(
    `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
     VALUES (?, ?, 'league_of_legends', 1)`,
  ).run(guildId, channelId);
}

describe('buildPublicNetworkPartners — pure', () => {
  it('0 partenaire → []', () => {
    const out = buildPublicNetworkPartners([], new Set(), () => null);
    assert.deepStrictEqual(out, { partners: [], count: 0 });
  });

  it('partenaire normal visible', () => {
    const out = buildPublicNetworkPartners(
      [GUILD_A],
      new Set(),
      (id) => (id === GUILD_A
        ? { name: 'ACKU', icon_url: 'https://cdn.example/a.png' }
        : null),
    );
    assert.strictEqual(out.count, 1);
    assert.deepStrictEqual(out.partners[0], {
      name: 'ACKU',
      icon_url: 'https://cdn.example/a.png',
    });
    assert.ok(!('guild_id' in out.partners[0]));
  });

  it('partenaire exclu masqué', () => {
    const out = buildPublicNetworkPartners(
      [GUILD_A, GUILD_B],
      new Set([GUILD_A]),
      (id) => ({ name: id === GUILD_A ? 'A' : 'B', icon_url: null }),
    );
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.partners[0].name, 'B');
  });

  it('partenaire absent du cache → omis', () => {
    const out = buildPublicNetworkPartners(
      [GUILD_A, GUILD_GHOST],
      new Set(),
      (id) => (id === GUILD_A ? { name: 'Visible', icon_url: null } : null),
    );
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.partners[0].name, 'Visible');
  });

  it('sans icône → icon_url null', () => {
    const out = buildPublicNetworkPartners(
      [GUILD_A],
      new Set(),
      () => ({ name: 'NoIcon', icon_url: null }),
    );
    assert.strictEqual(out.partners[0].icon_url, null);
  });

  it('tri alphabétique par name', () => {
    const out = buildPublicNetworkPartners(
      [GUILD_A, GUILD_B, GUILD_C],
      new Set(),
      (id) => {
        if (id === GUILD_A) return { name: 'Zebra', icon_url: null };
        if (id === GUILD_B) return { name: 'Alpha', icon_url: null };
        return { name: 'Middle', icon_url: null };
      },
    );
    assert.deepStrictEqual(
      out.partners.map((p) => p.name),
      ['Alpha', 'Middle', 'Zebra'],
    );
    assert.strictEqual(out.count, 3);
  });

  it('n’expose jamais guild_id', () => {
    const out = buildPublicNetworkPartners(
      [GUILD_A],
      new Set(),
      () => ({ name: 'X', icon_url: 'https://x' }),
    );
    const json = JSON.stringify(out);
    assert.ok(!json.includes(GUILD_A));
    assert.ok(!json.includes('guild_id'));
  });
});

describe('fetchNetworkPartners + SQLite exclusions', () => {
  it('migration exclusions idempotente + CRUD statements', async () => {
    await withTempDb(async (db) => {
      const stmts = prepareStatements(db);
      assert.deepStrictEqual(stmts.listNetworkPublicExclusions.all(), []);

      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_A,
        created_at: new Date().toISOString(),
        reason: 'test',
      });
      assert.ok(stmts.getNetworkPublicExclusion.get(GUILD_A));

      // Re-run migration path via second getDb is same instance; recreate table IF NOT EXISTS
      db.exec(`
        CREATE TABLE IF NOT EXISTS network_public_exclusions (
          guild_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          reason TEXT
        );
      `);
      assert.ok(stmts.getNetworkPublicExclusion.get(GUILD_A));

      stmts.deleteNetworkPublicExclusion.run(GUILD_A);
      assert.equal(stmts.getNetworkPublicExclusion.get(GUILD_A), undefined);
    });
  });

  it('filtre exclusion + ghost + icon null + tri', async () => {
    await withTempDb(async (db) => {
      insertPartner(db, GUILD_A);
      insertPartner(db, GUILD_B, 'ch2');
      insertPartner(db, GUILD_C, 'ch3');
      insertPartner(db, GUILD_GHOST, 'ch4');

      const stmts = prepareStatements(db);
      stmts.upsertNetworkPublicExclusion.run({
        guild_id: GUILD_B,
        created_at: new Date().toISOString(),
        reason: 'demo',
      });

      const client = mockClient(new Map([
        [GUILD_A, { name: 'Zebra Clan', icon: 'abc' }],
        [GUILD_C, { name: 'Alpha Team', icon: null }],
        // GUILD_B excluded even if present
        [GUILD_B, { name: 'Hidden', icon: 'hid' }],
        // GUILD_GHOST absent from cache
      ]));

      const payload = fetchNetworkPartners(db, client);
      assert.strictEqual(payload.count, 2);
      assert.deepStrictEqual(
        payload.partners.map((p) => p.name),
        ['Alpha Team', 'Zebra Clan'],
      );
      assert.strictEqual(payload.partners[0].icon_url, null);
      assert.ok(payload.partners[1].icon_url?.includes(GUILD_A));
      assert.ok(!JSON.stringify(payload).includes('guild_id'));
      assert.ok(!JSON.stringify(payload).includes(GUILD_GHOST));
      assert.ok(!JSON.stringify(payload).includes('"Hidden"'));
    });
  });
});

describe('GET /internal/network/partners', () => {
  it('401 sans bearer', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, mockClient(new Map()));
      const res = await httpRequest(port, '/internal/network/partners', { token: null });
      assert.strictEqual(res.status, 401);
    });
  });

  it('200 succès payload public', async () => {
    await withTempDb(async (db) => {
      insertPartner(db, GUILD_A);
      const client = mockClient(new Map([
        [GUILD_A, { name: 'ACKU', icon: 'ico1' }],
      ]));
      const port = await startTestServer(db, client);
      const res = await httpRequest(port, '/internal/network/partners');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.count, 1);
      assert.strictEqual(res.body.partners[0].name, 'ACKU');
      assert.ok(typeof res.body.partners[0].icon_url === 'string');
      assert.ok(!JSON.stringify(res.body).includes('guild_id'));
    });
  });

  it('0 partenaire → count 0', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(db, mockClient(new Map()));
      const res = await httpRequest(port, '/internal/network/partners');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, { partners: [], count: 0 });
    });
  });
});

describe('publicNetworkPartners — pas de hardcode serveurs test', () => {
  it('sources prod ne contiennent pas de DEV_GUILD_ID / IDs test connus', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    for (const rel of [
      'src/services/publicNetworkPartners.js',
      'src/internalHttp/networkPartnersQueries.js',
    ]) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.ok(!src.includes('1484520688726311012'), rel);
      assert.ok(!src.includes('1436848619796828322'), rel);
      assert.ok(!src.includes('DEV_GUILD_ID'), rel);
    }
  });
});
