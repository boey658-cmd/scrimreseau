/**
 * SERVER LIST SPLIT — POST /internal/guilds/installation-status
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import {
  INSTALLATION_STATUS_MAX_GUILD_IDS,
  parseInstallationStatusBody,
  resolveInstallationStatus,
} from '../src/internalHttp/installationStatus.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';

const TEST_TOKEN = 'test-internal-token-install-status';
const GUILD_A = '1484520688726311012';
const GUILD_B = '1436848619796828322';
const GUILD_C = '1070686329991602240';
const PATH = '/internal/guilds/installation-status';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-install-status-'));
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

function makeClient(installedIds = []) {
  const set = new Set(installedIds);
  let hasCalls = 0;
  return {
    guilds: {
      cache: {
        has: (id) => {
          hasCalls += 1;
          return set.has(id);
        },
      },
      fetch: async () => {
        throw new Error('Discord REST interdit pour installation-status');
      },
    },
    _hasCalls: () => hasCalls,
  };
}

/** Proxy DB qui échoue sur prepare/exec — détecte accès SQLite accidentel. */
function makeDbGuard(realDb) {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare' || prop === 'exec' || prop === 'transaction' || prop === 'pragma') {
        return () => {
          throw new Error('SQLite interdit pour installation-status');
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** @type {import('node:http').Server | null} */
let testServer = null;
/** @type {{ stopAccepting?: () => void } | null} */
let testListener = null;

async function startTestServer(db, client) {
  const config = { enabled: true, port: 0, token: TEST_TOKEN };
  const { server, listener, host } = createInternalHttpServer({
    db,
    client,
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
 * @param {{ method?: string, token?: string | null, body?: unknown, rawBody?: string, contentType?: string | null }} [opts]
 */
function httpRequest(port, opts = {}) {
  const method = opts.method ?? 'POST';
  /** @type {Record<string, string>} */
  const headers = {};
  if (opts.token !== null) {
    headers.Authorization = `Bearer ${opts.token ?? TEST_TOKEN}`;
  }

  let bodyBuf = null;
  if (opts.rawBody !== undefined) {
    bodyBuf = Buffer.from(opts.rawBody, 'utf8');
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
      { hostname: '127.0.0.1', port, path: PATH, method, headers },
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

describe('installation-status — parse / resolve', () => {
  it('déduit bot_installed depuis cache.has uniquement ; ordre + dédup', () => {
    const client = makeClient([GUILD_A, GUILD_C]);
    const ids = parseInstallationStatusBody({
      guild_ids: [GUILD_B, GUILD_A, GUILD_B, GUILD_C],
    });
    assert.deepStrictEqual(ids, [GUILD_B, GUILD_A, GUILD_C]);

    const payload = resolveInstallationStatus({ client }, ids);
    assert.deepStrictEqual(payload, {
      guilds: [
        { guild_id: GUILD_B, bot_installed: false },
        { guild_id: GUILD_A, bot_installed: true },
        { guild_id: GUILD_C, bot_installed: true },
      ],
    });
    assert.strictEqual(client._hasCalls(), 3);
  });

  it('refuse extras, non-array, snowflake invalide, >200', () => {
    assert.throws(
      () => parseInstallationStatusBody({ guild_ids: [], extra: 1 }),
      (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => parseInstallationStatusBody({}),
      (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => parseInstallationStatusBody({ guild_ids: 'x' }),
      (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => parseInstallationStatusBody({ guild_ids: ['not-snowflake'] }),
      (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
    );
    const tooMany = Array.from({ length: INSTALLATION_STATUS_MAX_GUILD_IDS + 1 }, (_, i) =>
      String(1000000000000000000n + BigInt(i)),
    );
    assert.throws(
      () => parseInstallationStatusBody({ guild_ids: tooMany }),
      (err) => err instanceof ConfigWriteError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('client/cache absent => service_unavailable', () => {
    assert.throws(
      () => resolveInstallationStatus({ client: null }, [GUILD_A]),
      (err) => err instanceof ConfigWriteError && err.code === 'service_unavailable' && err.status === 503,
    );
    assert.throws(
      () => resolveInstallationStatus({ client: { guilds: {} } }, [GUILD_A]),
      (err) => err instanceof ConfigWriteError && err.code === 'service_unavailable',
    );
  });
});

describe('installation-status — HTTP', () => {
  beforeEach(() => {
    testServer = null;
    testListener = null;
  });
  afterEach(async () => {
    await stopTestServer();
  });

  it('Bearer absent/faux => 401 ; POST valide true/false ; ordre ; dédup ; pas d’extra', async () => {
    await withTempDb(async (db) => {
      const client = makeClient([GUILD_A]);
      const port = await startTestServer(makeDbGuard(db), /** @type {any} */ (client));

      assert.strictEqual(
        (await httpRequest(port, {
          token: null,
          body: { guild_ids: [GUILD_A] },
        })).status,
        401,
      );
      assert.strictEqual(
        (await httpRequest(port, {
          token: 'wrong',
          body: { guild_ids: [GUILD_A] },
        })).status,
        401,
      );

      const ok = await httpRequest(port, {
        body: { guild_ids: [GUILD_B, GUILD_A, GUILD_B] },
      });
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(ok.body, {
        guilds: [
          { guild_id: GUILD_B, bot_installed: false },
          { guild_id: GUILD_A, bot_installed: true },
        ],
      });
      assert.strictEqual(ok.body.guilds.length, 2);
      for (const g of ok.body.guilds) {
        assert.deepStrictEqual(Object.keys(g).sort(), ['bot_installed', 'guild_id']);
      }
    });
  });

  it('body vide / malformed / absent / non-array / snowflake / >200 => 400', async () => {
    await withTempDb(async (db) => {
      const port = await startTestServer(makeDbGuard(db), /** @type {any} */ (makeClient()));

      assert.strictEqual(
        (await httpRequest(port, { rawBody: '   ' })).status,
        400,
      );
      assert.strictEqual(
        (await httpRequest(port, { rawBody: '{bad' })).status,
        400,
      );
      assert.strictEqual(
        (await httpRequest(port, { body: {} })).status,
        400,
      );
      assert.strictEqual(
        (await httpRequest(port, { body: { guild_ids: null } })).status,
        400,
      );
      assert.strictEqual(
        (await httpRequest(port, { body: { guild_ids: ['abc'] } })).status,
        400,
      );

      const tooMany = Array.from({ length: INSTALLATION_STATUS_MAX_GUILD_IDS + 1 }, (_, i) =>
        String(1100000000000000000n + BigInt(i)),
      );
      const over = await httpRequest(port, { body: { guild_ids: tooMany } });
      assert.strictEqual(over.status, 400);
      assert.strictEqual(over.body.error, 'VALIDATION_ERROR');
    });
  });

  it('client/cache absent => 503 ; GET/PUT/PATCH/DELETE => 405', async () => {
    await withTempDb(async (db) => {
      const portNoClient = await startTestServer(makeDbGuard(db), null);
      const unavailable = await httpRequest(portNoClient, {
        body: { guild_ids: [GUILD_A] },
      });
      assert.strictEqual(unavailable.status, 503);
      assert.strictEqual(unavailable.body.error, 'service_unavailable');
      await stopTestServer();

      const port = await startTestServer(makeDbGuard(db), /** @type {any} */ (makeClient([GUILD_A])));
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        const res = await httpRequest(port, {
          method,
          body: method === 'GET' || method === 'DELETE'
            ? undefined
            : { guild_ids: [GUILD_A] },
        });
        assert.strictEqual(res.status, 405, method);
      }
    });
  });

  it('régression : GET overview/config/network + PATCH config restent OK', async () => {
    await withTempDb(async (db, stmts) => {
      const client = makeClient([GUILD_A]);
      // DB réelle pour les GET/PATCH config (pas le guard)
      const port = await startTestServer(db, /** @type {any} */ (client));

      const overview = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/internal/guilds/${GUILD_A}/overview`,
            method: 'GET',
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
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
        req.end();
      });
      assert.strictEqual(overview.status, 200);
      assert.strictEqual(overview.body.bot_installed, true);

      const getCfg = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: `/internal/guilds/${GUILD_A}/config`,
            method: 'GET',
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              resolve({ status: res.statusCode });
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(getCfg.status, 200);

      const network = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/internal/network/overview',
            method: 'GET',
            headers: { Authorization: `Bearer ${TEST_TOKEN}` },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(network.status, 200);

      void stmts;
    });
  });
});
