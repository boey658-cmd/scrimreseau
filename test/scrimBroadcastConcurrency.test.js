/**
 * Tests Phase 2 — Étape 2 : pool global, concurrence, fairness, fetch réseau.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  deliverScrimToDestination,
  buildPersistentDeliveryNonce,
  PERSISTENT_DELIVERY_NONCE_MAX_LEN,
} from '../src/services/scrimDelivery.js';
import {
  parseBroadcastConcurrency,
  getConfiguredConcurrency,
  invalidateBroadcastConcurrencyCache,
  runWithBroadcastSlot,
  runWithReservedBroadcastSlot,
  acquireBroadcastSlot,
  getBroadcastPoolStats,
  resetBroadcastPoolForTests,
  beginBroadcastPoolShutdown,
  waitForBroadcastPoolIdle,
  isDeliveryInFlight,
  tryReserveBroadcastSlot,
  bindBroadcastSlotDelivery,
  setBroadcastSlotFreedHandler,
  BROADCAST_POOL_STOPPING,
} from '../src/services/scrimBroadcastExecutionPool.js';
import {
  runScrimBroadcastDeliveryPass,
  recoverStaleScrimBroadcastDeliveries,
  wakeScrimBroadcastDeliveryJob,
  getBroadcastDeliveryJobDebugState,
  stopScrimBroadcastDeliveryJob,
  startScrimBroadcastDeliveryJob,
} from '../src/services/scrimBroadcastDeliveryJob.js';
import { createGracefulShutdown } from '../src/services/shutdownOrchestrator.js';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p2-conc-'));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  closeDb();
  const db = getDb();
  const stmts = prepareStatements(db);
  try {
    await fn(db, stmts);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function insertScrim(stmts, overrides = {}) {
  const info = stmts.insertScrimPostRow.run({
    scrim_public_id: overrides.publicId ?? `pub-${Math.random().toString(36).slice(2, 10)}`,
    author_user_id: 'author-1',
    origin_guild_id: overrides.guildId ?? 'g-origin',
    source_guild_id: overrides.guildId ?? 'g-origin',
    game_key: 'lol',
    rank_key: 'Platinum',
    format_key: 'BO1',
    contact_user_id: 'author-1',
    contact_display_name: 'Author',
    scheduled_date: '27/07/2026',
    scheduled_time: '20:00',
    scheduled_at: new Date(Date.now() + 7200000).toISOString(),
    scheduled_at_end: null,
    tags: JSON.stringify({}),
    multi_opgg_url: null,
    elo_precision: null,
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
    created_at: Date.now(),
    status: 'active',
  });
  return Number(info.lastInsertRowid);
}

function insertBatch(stmts, scrimId, status = 'active') {
  const now = new Date().toISOString();
  const info = stmts.insertScrimBroadcastBatch.run({
    scrim_post_db_id: scrimId,
    operation_type: 'initial',
    generation: 0,
    target_count: 10,
    created_at: now,
    updated_at: now,
  });
  const id = Number(info.lastInsertRowid);
  if (status === 'active') {
    stmts.setScrimBroadcastBatchActive.run({ id, started_at: now, updated_at: now });
  }
  return id;
}

function insertDelivery(stmts, batchId, scrimId, guildId, channelId) {
  const now = new Date().toISOString();
  const info = stmts.insertScrimBroadcastDelivery.run({
    batch_id: batchId,
    scrim_post_db_id: scrimId,
    guild_id: guildId,
    channel_id: channelId,
    game_key: 'lol',
    operation_type: 'initial',
    generation: 0,
    priority: 0,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
  });
  return Number(info.lastInsertRowid);
}

function mockClient(guildMap) {
  return {
    guilds: {
      cache: {
        get: (id) => guildMap[id] ?? undefined,
      },
      fetch: async (id) => {
        if (guildMap[id]) return guildMap[id];
        const err = Object.assign(new Error('Unknown Guild'), { code: 10004 });
        throw err;
      },
    },
  };
}

function mockGuild(id, channels, { fetchThrows } = {}) {
  const channelCache = {
    get: (cid) => channels[cid] ?? undefined,
  };
  return {
    id,
    members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
    channels: {
      cache: channelCache,
      fetch: async (cid) => {
        if (fetchThrows) throw fetchThrows;
        if (channels[cid]) return channels[cid];
        const err = Object.assign(new Error('Unknown Channel'), { code: 10003 });
        throw err;
      },
    },
  };
}

function mockChannel(id, guildId, { onSend, sendThrows } = {}) {
  const perms = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return {
    id,
    guildId,
    type: ChannelType.GuildText,
    permissionsFor: () => perms,
    send: async (payload) => {
      if (sendThrows) throw sendThrows;
      if (onSend) await onSend(payload);
      return { id: `msg-${id}-${Date.now()}`, delete: async () => {} };
    },
  };
}

describe('Phase2 Étape2 — concurrency pool', () => {
  beforeEach(() => {
    resetBroadcastPoolForTests();
    invalidateBroadcastConcurrencyCache();
    delete process.env.SCRIM_BROADCAST_CONCURRENCY;
  });
  afterEach(() => {
    resetBroadcastPoolForTests();
    delete process.env.SCRIM_BROADCAST_CONCURRENCY;
    invalidateBroadcastConcurrencyCache();
  });

  describe('TEST A — parseBroadcastConcurrency', () => {
    it('absent / vide → 1', () => {
      assert.equal(parseBroadcastConcurrency(undefined), 1);
      assert.equal(parseBroadcastConcurrency(''), 1);
      assert.equal(parseBroadcastConcurrency('  '), 1);
    });
    it('1,2,10,20', () => {
      assert.equal(parseBroadcastConcurrency('1'), 1);
      assert.equal(parseBroadcastConcurrency('2'), 2);
      assert.equal(parseBroadcastConcurrency('10'), 10);
      assert.equal(parseBroadcastConcurrency('20'), 20);
    });
    it('0 / négatif / NaN → 1', () => {
      assert.equal(parseBroadcastConcurrency('0'), 1);
      assert.equal(parseBroadcastConcurrency('-5'), 1);
      assert.equal(parseBroadcastConcurrency('NaN'), 1);
      assert.equal(parseBroadcastConcurrency('abc'), 1);
    });
    it('999 → cap 20', () => {
      assert.equal(parseBroadcastConcurrency('999'), 20);
    });
  });

  describe('TEST B/C — max concurrent slots', () => {
    it('concurrency=2 → jamais plus de 2 runWithBroadcastSlot simultanés', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '2';
      invalidateBroadcastConcurrencyCache();
      assert.equal(getConfiguredConcurrency(), 2);

      let active = 0;
      let maxActive = 0;
      const gates = [];

      const tasks = [1, 2, 3, 4].map((id) =>
        runWithBroadcastSlot(id, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => gates.push(r));
          active -= 1;
        }),
      );

      // Laisse démarrer les 2 premiers
      await new Promise((r) => setImmediate(r));
      assert.equal(maxActive, 2);
      assert.equal(getBroadcastPoolStats().inFlight, 2);

      // Libère progressivement jusqu’à idle
      for (let i = 0; i < 20; i++) {
        while (gates.length) gates.shift()();
        if (getBroadcastPoolStats().inFlight === 0) break;
        await new Promise((r) => setImmediate(r));
      }
      await Promise.all(tasks);
      assert.ok(maxActive <= 2);
      assert.equal(getBroadcastPoolStats().inFlight, 0);
    });
  });

  describe('TEST F — continuous refill', () => {
    it('quand un slot se libère, la suivante démarre avant la fin de la lente', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '2';
      invalidateBroadcastConcurrencyCache();

      /** @type {Array<() => void>} */
      const releaseSlow = [];
      let started = [];

      const p1 = runWithBroadcastSlot(101, async () => {
        started.push(101);
        await new Promise((r) => releaseSlow.push(r));
      });
      const p2 = runWithBroadcastSlot(102, async () => {
        started.push(102);
        // rapide
      });

      await new Promise((r) => setImmediate(r));
      assert.deepEqual(started.slice().sort(), [101, 102]);

      let p3Started = false;
      const p3 = runWithBroadcastSlot(103, async () => {
        p3Started = true;
        started.push(103);
      });

      // p2 déjà fini → p3 doit démarrer alors que p1 (lente) tourne encore
      await p2;
      await new Promise((r) => setImmediate(r));
      assert.equal(p3Started, true);
      assert.ok(isDeliveryInFlight(101));

      releaseSlow.forEach((r) => r());
      await Promise.all([p1, p3]);
    });
  });

  describe('TEST I/J — runtime recovery vs in-flight', () => {
    it('in-flight stale temporellement → PAS unknown', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const delivId = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status='processing', claimed_at=? WHERE id=?")
          .run(staleTime, delivId);

        bindBroadcastSlotDelivery(delivId);
        assert.equal(isDeliveryInFlight(delivId), true);

        const client = mockClient({});
        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(delivId);
        assert.equal(d.status, 'processing');
      });
    });

    it('stale non in-flight → unknown_outcome', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const delivId = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status='processing', claimed_at=? WHERE id=?")
          .run(staleTime, delivId);

        const client = mockClient({});
        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(delivId);
        assert.equal(d.status, 'unknown_outcome');
      });
    });
  });

  describe('TEST K — startup processing → unknown', () => {
    it('recoverStaleScrimBroadcastDeliveries', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const delivId = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        db.prepare("UPDATE scrim_broadcast_deliveries SET status='processing', claimed_at=? WHERE id=?")
          .run(new Date().toISOString(), delivId);
        recoverStaleScrimBroadcastDeliveries(db, stmts);
        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(delivId);
        assert.equal(d.status, 'unknown_outcome');
      });
    });
  });

  describe('TEST D/E — fairness multi-batch', () => {
    it('getNextActiveBatchDueForDispatch respecte last_dispatched_at', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimA = insertScrim(stmts, { guildId: 'gA' });
        const scrimB = insertScrim(stmts, { guildId: 'gB' });
        const batchA = insertBatch(stmts, scrimA);
        const batchB = insertBatch(stmts, scrimB);
        insertDelivery(stmts, batchA, scrimA, 'gA', 'cA');
        insertDelivery(stmts, batchB, scrimB, 'gB', 'cB');
        const now = new Date().toISOString();
        const older = new Date(Date.now() - 120000).toISOString();
        db.prepare('UPDATE scrim_broadcast_batches SET last_dispatched_at=? WHERE id=?').run(now, batchA);
        db.prepare('UPDATE scrim_broadcast_batches SET last_dispatched_at=? WHERE id=?').run(older, batchB);

        const next = stmts.getNextActiveBatchDueForDispatch.get({ now_iso: now });
        assert.ok(next);
        assert.equal(Number(next.id), batchB, 'B (last_dispatched plus ancien) avant A');
      });
    });

    it('concurrency=2 drain 3 batches sans dépasser 2 in-flight', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '2';
      invalidateBroadcastConcurrencyCache();

      await withTempDb(async (db, stmts) => {
        let active = 0;
        let maxActive = 0;

        const mk = (gid, cid) => mockChannel(cid, gid, {
          onSend: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 15));
            active -= 1;
          },
        });

        const scrims = [1, 2, 3].map((i) => insertScrim(stmts, { guildId: `g${i}` }));
        const batches = scrims.map((sid, i) => {
          const bid = insertBatch(stmts, sid);
          insertDelivery(stmts, bid, sid, `g${i + 1}`, `c${i + 1}`);
          return bid;
        });
        void batches;

        const client = mockClient({
          g1: mockGuild('g1', { c1: mk('g1', 'c1') }),
          g2: mockGuild('g2', { c2: mk('g2', 'c2') }),
          g3: mockGuild('g3', { c3: mk('g3', 'c3') }),
        });

        const pass = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.equal(pass.dispatched, 3);
        assert.ok(maxActive <= 2, `maxActive=${maxActive}`);
      });
    });
  });

  describe('TEST H — exact claim two slots', () => {
    it('deux claims → IDs distincts', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        insertDelivery(stmts, batchId, scrimId, 'g2', 'c2');
        const now = new Date().toISOString();
        const a = stmts.claimNextDeliveryForBatch.get({
          batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now,
        });
        const b = stmts.claimNextDeliveryForBatch.get({
          batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now,
        });
        assert.ok(a && b);
        assert.notEqual(a.id, b.id);
      });
    });
  });

  describe('TEST S — fetch guild réseau / UnknownGuild', () => {
    it('ETIMEDOUT sur guilds.fetch → retryable_error pas GUILD_NOT_FOUND', async () => {
      await withTempDb(async (db, stmts) => {
        const client = {
          guilds: {
            cache: { get: () => undefined },
            fetch: async () => {
              throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
            },
          },
        };
        const result = await deliverScrimToDestination({
          client,
          stmts,
          row: { guild_id: 'missing', channel_id: 'c' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          delayMs: 0,
          sendMode: 'direct',
          discordMaxAttempts: 1,
        });
        assert.equal(result.outcome, 'retryable_error');
        assert.notEqual(result.errorCode, 'GUILD_NOT_FOUND');
      });
    });

    it('10004 Unknown Guild → terminal_error GUILD_NOT_FOUND', async () => {
      await withTempDb(async (db, stmts) => {
        const client = {
          guilds: {
            cache: { get: () => undefined },
            fetch: async () => {
              throw Object.assign(new Error('Unknown Guild'), { code: 10004 });
            },
          },
        };
        const result = await deliverScrimToDestination({
          client,
          stmts,
          row: { guild_id: 'gone', channel_id: 'c' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          delayMs: 0,
          sendMode: 'direct',
          discordMaxAttempts: 1,
        });
        assert.equal(result.outcome, 'terminal_error');
        assert.equal(result.errorCode, 'GUILD_NOT_FOUND');
      });
    });
  });

  describe('TEST P — shutdown n’accepte plus de slots', () => {
    it('beginBroadcastPoolShutdown refuse nouvelles acquisitions', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      let released;
      const running = runWithBroadcastSlot(1, async () => {
        await new Promise((r) => { released = r; });
      });
      await new Promise((r) => setImmediate(r));
      beginBroadcastPoolShutdown();
      await assert.rejects(
        () => runWithBroadcastSlot(2, async () => {}),
        (err) => err && err.code === BROADCAST_POOL_STOPPING,
      );
      released();
      await running;
      const idle = await waitForBroadcastPoolIdle(1000);
      assert.equal(idle.idle, true);
    });
  });

  describe('TEST Q — slot accounting tryReserve', () => {
    it('tryReserve / release respecte la limite', () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      const t1 = tryReserveBroadcastSlot();
      assert.ok(t1);
      assert.equal(tryReserveBroadcastSlot(), null);
      t1.bindDelivery(42);
      assert.equal(isDeliveryInFlight(42), true);
      t1.release();
      assert.equal(isDeliveryInFlight(42), false);
      const t2 = tryReserveBroadcastSlot();
      assert.ok(t2);
      t2.release();
      assert.equal(getBroadcastPoolStats().activeCount, 0);
      assert.equal(getBroadcastPoolStats().waitingCount, 0);
    });
  });

  describe('fairness query', () => {
    it('getNextActiveBatchDueForDispatch ignore retries futurs', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const future = new Date(Date.now() + 3600000).toISOString();
        const id = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        db.prepare("UPDATE scrim_broadcast_deliveries SET status='retry', next_attempt_at=? WHERE id=?")
          .run(future, id);
        const now = new Date().toISOString();
        const row = stmts.getNextActiveBatchDueForDispatch.get({ now_iso: now });
        assert.equal(row, undefined);
      });
    });
  });

  describe('TEST V — repost guard statement', () => {
    it('hasOpenPersistentBroadcastForScrim détecte batch active', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        insertBatch(stmts, scrimId);
        const open = stmts.hasOpenPersistentBroadcastForScrim.get(scrimId, scrimId);
        assert.ok(open);
      });
    });
  });

  // ───────── Étape 2B ─────────

  describe('2B — waiters rejetés au shutdown', () => {
    it('100 waiters → tous rejetés, waitingCount=0', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      let releaseFirst;
      const first = acquireBroadcastSlot().then(async (token) => {
        await new Promise((r) => { releaseFirst = r; });
        token.release();
      });
      await new Promise((r) => setImmediate(r));

      const waiters = Array.from({ length: 100 }, () => acquireBroadcastSlot());
      await new Promise((r) => setImmediate(r));
      assert.equal(getBroadcastPoolStats().waitingCount, 100);

      beginBroadcastPoolShutdown();
      const results = await Promise.allSettled(waiters);
      assert.equal(results.every((r) => r.status === 'rejected'), true);
      assert.equal(results.every((r) => r.status === 'rejected' && r.reason?.code === BROADCAST_POOL_STOPPING), true);
      assert.equal(getBroadcastPoolStats().waitingCount, 0);

      releaseFirst();
      await first;
      await waitForBroadcastPoolIdle(2000);
      assert.equal(getBroadcastPoolStats().activeCount, 0);
    });
  });

  describe('2B — bootstrap slot avant claim / shutdown race', () => {
    it('concurrency=1 slot occupé → delivery reste pending ; shutdown rejette sans claim', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();

      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId, 'staging');
        // leave staging? claim works on any batch - use active
        db.prepare("UPDATE scrim_broadcast_batches SET status='active' WHERE id=?").run(batchId);
        const delivId = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');

        let releaseHold;
        const hold = acquireBroadcastSlot().then(async (token) => {
          await new Promise((r) => { releaseHold = r; });
          token.release();
        });
        await new Promise((r) => setImmediate(r));

        let claimedInside = false;
        const bootstrap = runWithReservedBroadcastSlot(async (token) => {
          const now = new Date().toISOString();
          const claimed = stmts.claimNextDeliveryForBatch.get({
            batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now,
          });
          if (claimed) {
            claimedInside = true;
            token.bindDelivery(Number(claimed.id));
          }
        });

        await new Promise((r) => setImmediate(r));
        // Pendant l’attente : delivery toujours pending
        const before = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(delivId);
        assert.equal(before.status, 'pending');
        assert.equal(getBroadcastPoolStats().waitingCount, 1);
        assert.equal(getBroadcastPoolStats().inFlightIds.length, 0);

        beginBroadcastPoolShutdown();
        await assert.rejects(() => bootstrap, (e) => e?.code === BROADCAST_POOL_STOPPING);

        const after = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(delivId);
        assert.equal(after.status, 'pending');
        assert.equal(claimedInside, false);
        assert.equal(getBroadcastPoolStats().waitingCount, 0);
        assert.equal(getBroadcastPoolStats().inFlightIds.length, 0);

        releaseHold();
        await hold;
      });
    });
  });

  describe('2B — inflight leak', () => {
    it('acquire rejeté avant bind → aucun deliveryId dans inFlight', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      const holdToken = await acquireBroadcastSlot();
      const pending = acquireBroadcastSlot();
      await new Promise((r) => setImmediate(r));
      beginBroadcastPoolShutdown();
      await assert.rejects(() => pending, (e) => e?.code === BROADCAST_POOL_STOPPING);
      assert.deepEqual(getBroadcastPoolStats().inFlightIds, []);
      holdToken.release();
      assert.equal(getBroadcastPoolStats().activeCount, 0);
      assert.equal(getBroadcastPoolStats().waitingCount, 0);
    });
  });

  describe('2B — stop ne réouvre pas le pool', () => {
    it('après stopScrimBroadcastDeliveryJob → stopping reste true', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      await stopScrimBroadcastDeliveryJob();
      const s = getBroadcastPoolStats();
      assert.equal(s.stopping, true);
      assert.equal(s.acceptNewWork, false);
      resetBroadcastPoolForTests();
    });

    it('job démarré puis flag OFF → shutdown appelle stop (pool stopping)', async () => {
      const prevFlag = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      const prevStop = process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS;
      process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = '1';
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS = '200';
      invalidateBroadcastConcurrencyCache();
      resetBroadcastPoolForTests();

      try {
        await withTempDb(async (db, stmts) => {
          const client = { guilds: { cache: { get: () => undefined } } };
          startScrimBroadcastDeliveryJob(client, db, stmts);
          assert.equal(getBroadcastDeliveryJobDebugState().jobStarted, true);

          // Simule flag OFF après démarrage (bug historique : skip stop)
          process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = '0';

          let stopCalls = 0;
          const shutdown = createGracefulShutdown({
            steps: [
              {
                name: 'arrêt du worker diffusion persistante',
                phase: 'persistent_broadcast_job_stop',
                stop: async () => {
                  stopCalls += 1;
                  await stopScrimBroadcastDeliveryJob();
                },
              },
            ],
            getClient: () => null,
            closeDb: () => {},
            onExit: () => {},
          });
          await shutdown('SIGTERM');

          assert.equal(stopCalls, 1);
          assert.equal(getBroadcastDeliveryJobDebugState().jobStarted, false);
          const s = getBroadcastPoolStats();
          assert.equal(s.stopping, true);
          assert.equal(s.acceptNewWork, false);
          assert.equal(s.waitingCount, 0);
          assert.equal(tryReserveBroadcastSlot(), null);
        });
      } finally {
        if (prevFlag === undefined) delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
        else process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = prevFlag;
        if (prevStop === undefined) delete process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS;
        else process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS = prevStop;
        resetBroadcastPoolForTests();
      }
    });

    it('job jamais démarré + flag OFF → stop idempotent sans erreur', async () => {
      const prevFlag = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS = '100';
      resetBroadcastPoolForTests();
      try {
        assert.equal(getBroadcastDeliveryJobDebugState().jobStarted, false);
        await assert.doesNotReject(() => stopScrimBroadcastDeliveryJob());
        const s = getBroadcastPoolStats();
        assert.equal(s.stopping, true);
        assert.equal(s.acceptNewWork, false);
        assert.equal(getBroadcastDeliveryJobDebugState().jobStarted, false);
      } finally {
        if (prevFlag === undefined) delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
        else process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = prevFlag;
        delete process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS;
        resetBroadcastPoolForTests();
      }
    });
  });

  describe('2B — fairness A/B/C multi-delivery', () => {
    it('concurrency=3 → premiers 3 slots = A,B,C un chacun', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '3';
      invalidateBroadcastConcurrencyCache();

      await withTempDb(async (db, stmts) => {
        /** @type {Array<() => void>} */
        const resolvers = [];
        /** @type {string[]} */
        const startedBatches = [];
        let blockSends = true;

        const makeChannel = (gid, cid, batchLabel) => {
          const perms = new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]);
          return {
            id: cid,
            guildId: gid,
            type: ChannelType.GuildText,
            permissionsFor: () => perms,
            send: () => new Promise((resolve) => {
              const finish = () => resolve({ id: `msg-${cid}`, delete: async () => {} });
              if (!blockSends) {
                finish();
                return;
              }
              startedBatches.push(batchLabel);
              resolvers.push(finish);
            }),
          };
        };

        const labels = ['A', 'B', 'C'];
        const guildMap = {};
        for (const label of labels) {
          const scrimId = insertScrim(stmts, { guildId: `g${label}`, publicId: `pub-${label}` });
          const batchId = insertBatch(stmts, scrimId);
          for (let i = 0; i < 10; i++) {
            insertDelivery(stmts, batchId, scrimId, `g${label}`, `c${label}-${i}`);
          }
          const channels = {};
          for (let i = 0; i < 10; i++) {
            channels[`c${label}-${i}`] = makeChannel(`g${label}`, `c${label}-${i}`, label);
          }
          guildMap[`g${label}`] = mockGuild(`g${label}`, channels);
        }

        const client = mockClient(guildMap);
        const passPromise = runScrimBroadcastDeliveryPass(client, db, stmts);

        try {
          for (let i = 0; i < 200 && startedBatches.length < 3; i++) {
            await new Promise((r) => setTimeout(r, 0));
          }
          assert.equal(startedBatches.length, 3, `started=${startedBatches.join(',')}`);
          assert.deepEqual([...startedBatches].sort(), ['A', 'B', 'C']);

          resolvers.shift()?.();
          for (let i = 0; i < 200 && startedBatches.length < 4; i++) {
            await new Promise((r) => setTimeout(r, 0));
          }
          assert.ok(startedBatches.length >= 4, `started=${startedBatches.join(',')}`);
          const first4 = startedBatches.slice(0, 4);
          assert.ok(new Set(first4).size >= 3, `first4=${first4.join(',')}`);
        } finally {
          blockSends = false;
          while (resolvers.length) resolvers.shift()();
          await passPromise;
        }
        assert.equal(getBroadcastPoolStats().activeCount, 0);
      });
    });
  });

  describe('2B — sticky wake', () => {
    it('wake pendant activité → wakeRequested sticky, pas de sleep poll requis', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      await withTempDb(async (db, stmts) => {
        /** @type {(() => void) | null} */
        let releaseSend = null;
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c2');

        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const ch1 = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: () => new Promise((resolve) => {
            wakeScrimBroadcastDeliveryJob();
            assert.equal(getBroadcastDeliveryJobDebugState().wakeRequested, true);
            releaseSend = () => resolve({ id: 'msg-c1', delete: async () => {} });
          }),
        };
        const ch2 = {
          id: 'c2',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async () => ({ id: 'msg-c2', delete: async () => {} }),
        };
        const client = mockClient({ g1: mockGuild('g1', { c1: ch1, c2: ch2 }) });

        const p = runScrimBroadcastDeliveryPass(client, db, stmts);
        try {
          for (let i = 0; i < 200 && !releaseSend; i++) {
            await new Promise((r) => setTimeout(r, 0));
          }
          assert.ok(releaseSend, 'premier send non démarré');
          assert.equal(getBroadcastDeliveryJobDebugState().wakeRequested, true);
          releaseSend();
          await p;
        } catch (e) {
          if (releaseSend) releaseSend();
          throw e;
        }
        const pending = db.prepare("SELECT COUNT(*) AS n FROM scrim_broadcast_deliveries WHERE status='pending'").get();
        assert.equal(pending.n, 0);
      });
    });
  });

  describe('2B — fetchMe ETIMEDOUT', () => {
    it('fetchMe timeout → retryable_error pas PERMISSIONS', async () => {
      await withTempDb(async (db, stmts) => {
        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const channel = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async () => ({ id: 'm' }),
        };
        const guild = {
          id: 'g1',
          members: {
            me: null,
            fetchMe: async () => {
              throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
            },
          },
          channels: {
            cache: { get: () => channel },
            fetch: async () => channel,
          },
        };
        const result = await deliverScrimToDestination({
          client: mockClient({ g1: guild }),
          stmts,
          row: { guild_id: 'g1', channel_id: 'c1' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          sendMode: 'direct',
          discordMaxAttempts: 1,
        });
        assert.equal(result.outcome, 'retryable_error');
        assert.notEqual(result.errorCode, 'PERMISSIONS');
      });
    });
  });

  describe('2B — send ambigu at-most-once', () => {
    async function runSendCase(sendThrows) {
      let sendCount = 0;
      /** @type {any} */
      let result;
      await withTempDb(async (db, stmts) => {
        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const ch = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async () => {
            sendCount += 1;
            if (sendThrows) throw sendThrows;
            return { id: 'msg' };
          },
        };
        result = await deliverScrimToDestination({
          client: mockClient({ g1: mockGuild('g1', { c1: ch }) }),
          stmts,
          row: { guild_id: 'g1', channel_id: 'c1' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          sendMode: 'direct',
          deliveryId: 42,
        });
      });
      return { result, sendCount };
    }

    it('ETIMEDOUT → unknown_outcome, 1 send', async () => {
      const { result, sendCount } = await runSendCase(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );
      assert.equal(result.outcome, 'unknown_outcome');
      assert.equal(sendCount, 1);
    });
    it('ECONNRESET → unknown_outcome, 1 send', async () => {
      const { result, sendCount } = await runSendCase(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
      );
      assert.equal(result.outcome, 'unknown_outcome');
      assert.equal(sendCount, 1);
    });
    it('HTTP 500 → unknown_outcome, 1 send', async () => {
      const { result, sendCount } = await runSendCase(
        Object.assign(new Error('server'), { status: 500 }),
      );
      assert.equal(result.outcome, 'unknown_outcome');
      assert.equal(sendCount, 1);
    });
    it('Unknown Channel → terminal', async () => {
      const { result, sendCount } = await runSendCase(
        Object.assign(new Error('Unknown Channel'), { code: 10003 }),
      );
      assert.equal(result.outcome, 'terminal_error');
      assert.equal(sendCount, 1);
    });
    it('429 → retryable_error', async () => {
      const { result, sendCount } = await runSendCase(
        Object.assign(new Error('rate'), { status: 429, code: 429 }),
      );
      assert.equal(result.outcome, 'retryable_error');
      assert.equal(sendCount, 1);
    });
  });

  describe('Étape4 — nonce + enforceNonce (persistent direct)', () => {
    it('buildPersistentDeliveryNonce déterministe et ≤25', () => {
      assert.equal(buildPersistentDeliveryNonce(123), 'sr:123');
      assert.equal(buildPersistentDeliveryNonce('123'), 'sr:123');
      assert.equal(buildPersistentDeliveryNonce(123), buildPersistentDeliveryNonce(123));
      assert.notEqual(buildPersistentDeliveryNonce(123), buildPersistentDeliveryNonce(124));
      const huge = buildPersistentDeliveryNonce(Number.MAX_SAFE_INTEGER);
      assert.ok(huge.length <= PERSISTENT_DELIVERY_NONCE_MAX_LEN, huge);
      assert.throws(() => buildPersistentDeliveryNonce(null));
      assert.throws(() => buildPersistentDeliveryNonce(undefined));
      assert.throws(() => buildPersistentDeliveryNonce(0));
      assert.throws(() => buildPersistentDeliveryNonce(-1));
      assert.throws(() => buildPersistentDeliveryNonce(NaN));
      assert.throws(() => buildPersistentDeliveryNonce(''));
    });

    it('channel.send reçoit nonce + enforceNonce ; 1 send — contrat retries REST internes', async () => {
      // discord.js REST retries (default 3) réutilisent le même request body → même nonce.
      await withTempDb(async (db, stmts) => {
        /** @type {any} */
        let captured = null;
        let sendCount = 0;
        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const ch = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async (payload) => {
            sendCount += 1;
            captured = payload;
            return { id: 'msg-1' };
          },
        };
        const result = await deliverScrimToDestination({
          client: mockClient({ g1: mockGuild('g1', { c1: ch }) }),
          stmts,
          row: { guild_id: 'g1', channel_id: 'c1' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          sendMode: 'direct',
          deliveryId: 123,
        });
        assert.equal(result.outcome, 'sent');
        assert.equal(sendCount, 1);
        assert.equal(captured.nonce, 'sr:123');
        assert.equal(captured.enforceNonce, true);
        assert.ok(Array.isArray(captured.embeds) && captured.embeds.length >= 1);
      });
    });

    it('direct sans deliveryId → NONCE_REQUIRED, 0 send', async () => {
      await withTempDb(async (db, stmts) => {
        let sendCount = 0;
        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const ch = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async () => { sendCount += 1; return { id: 'm' }; },
        };
        const result = await deliverScrimToDestination({
          client: mockClient({ g1: mockGuild('g1', { c1: ch }) }),
          stmts,
          row: { guild_id: 'g1', channel_id: 'c1' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          sendMode: 'direct',
        });
        assert.equal(result.outcome, 'terminal_error');
        assert.equal(result.errorCode, 'NONCE_REQUIRED');
        assert.equal(sendCount, 0);
      });
    });

    it('background pass : nonce = id delivery claimée', async () => {
      await withTempDb(async (db, stmts) => {
        // Scrim/batch factices pour décaler les ids AUTOINCREMENT
        insertScrim(stmts, { publicId: 'pad' });
        insertBatch(stmts, insertScrim(stmts, { publicId: 'pad2' }));

        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const deliveryId = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        assert.notEqual(deliveryId, batchId);
        assert.notEqual(deliveryId, scrimId);
        /** @type {any} */
        let captured = null;
        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const ch = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async (payload) => {
            captured = payload;
            return { id: `msg-${deliveryId}`, delete: async () => {} };
          },
        };
        await runScrimBroadcastDeliveryPass(
          mockClient({ g1: mockGuild('g1', { c1: ch }) }),
          db,
          stmts,
        );
        assert.equal(captured.nonce, `sr:${deliveryId}`);
        assert.equal(captured.enforceNonce, true);
        assert.notEqual(captured.nonce, `sr:${batchId}`);
        assert.notEqual(captured.nonce, `sr:${scrimId}`);
      });
    });

    it('bootstrap-like : nonce depuis claimed.id (même helper)', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        const now = new Date().toISOString();
        const claimed = stmts.claimNextDeliveryForBatch.get({
          batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now,
        });
        assert.ok(claimed);
        /** @type {any} */
        let captured = null;
        const perms = new PermissionsBitField([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ]);
        const ch = {
          id: 'c1',
          guildId: 'g1',
          type: ChannelType.GuildText,
          permissionsFor: () => perms,
          send: async (payload) => {
            captured = payload;
            return { id: 'msg-boot' };
          },
        };
        await deliverScrimToDestination({
          client: mockClient({ g1: mockGuild('g1', { c1: ch }) }),
          stmts,
          row: { guild_id: 'g1', channel_id: 'c1' },
          authorUserId: 'u',
          payload: {
            gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
            region: 'EUW', rolesNeeded: [], notes: null,
            scheduledAt: null, scheduledAtEnd: null,
            contactUserId: 'u', contactDisplayName: 'U',
            authorUserId: 'u', createdAt: new Date().toISOString(),
            expiresAt: null, scrimPublicId: 'x',
          },
          sendMode: 'direct',
          deliveryId: Number(claimed.id),
        });
        assert.equal(captured.nonce, buildPersistentDeliveryNonce(claimed.id));
        assert.equal(captured.enforceNonce, true);
      });
    });
  });

  describe('2B — processDelivery crash → unknown', () => {
    it('throw après claim → unknown_outcome PROCESS_DELIVERY_CRASH, slot libre', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      await withTempDb(async (db, stmts) => {
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c2');

        // Force throw dans processDelivery après claim (avant/pendant payload)
        const origGet = stmts.getScrimPostById.get.bind(stmts.getScrimPostById);
        let calls = 0;
        stmts.getScrimPostById.get = (id) => {
          calls += 1;
          if (calls === 1) throw new Error('artificial processDelivery crash');
          return origGet(id);
        };

        const ch1 = mockChannel('c1', 'g1');
        const ch2 = mockChannel('c2', 'g1');
        const client = mockClient({ g1: mockGuild('g1', { c1: ch1, c2: ch2 }) });
        const pass = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.ok(pass.dispatched >= 1);
        const statuses = db.prepare('SELECT status, last_error_code FROM scrim_broadcast_deliveries ORDER BY id').all();
        const unk = statuses.find((s) => s.status === 'unknown_outcome' && s.last_error_code === 'PROCESS_DELIVERY_CRASH');
        assert.ok(unk, `statuses=${JSON.stringify(statuses)}`);
        assert.equal(getBroadcastPoolStats().activeCount, 0);
        // Dispatcher continue : 2e delivery traitée
        assert.ok(statuses.some((s) => s.status === 'sent'), `statuses=${JSON.stringify(statuses)}`);
      });
    });
  });

  describe('2B — repost consomme slot global', () => {
    it('concurrency=1 : persistent actif → acquire repost attend', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();
      const persistent = await acquireBroadcastSlot();
      assert.equal(getBroadcastPoolStats().activeCount, 1);

      let repostGotSlot = false;
      const repostP = acquireBroadcastSlot().then((token) => {
        repostGotSlot = true;
        token.release();
      });
      await new Promise((r) => setImmediate(r));
      assert.equal(repostGotSlot, false);
      assert.equal(getBroadcastPoolStats().waitingCount, 1);

      persistent.release();
      await repostP;
      assert.equal(repostGotSlot, true);
      assert.equal(getBroadcastPoolStats().activeCount, 0);
    });

    it('concurrency=2 : max global <=2 avec 2 persists + 1 waiter', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '2';
      invalidateBroadcastConcurrencyCache();
      const a = await acquireBroadcastSlot();
      const b = await acquireBroadcastSlot();
      assert.equal(getBroadcastPoolStats().activeCount, 2);
      assert.equal(tryReserveBroadcastSlot(), null);
      const waiting = acquireBroadcastSlot();
      await new Promise((r) => setImmediate(r));
      assert.equal(getBroadcastPoolStats().waitingCount, 1);
      a.release();
      const c = await waiting;
      assert.equal(getBroadcastPoolStats().activeCount, 2);
      b.release();
      c.release();
      assert.equal(getBroadcastPoolStats().activeCount, 0);
    });
  });

  // ───────── Étape 2C ─────────

  describe('2C — generic slot release wakes dispatcher', () => {
    it('acquire générique (repost) bloque puis libère → pass drain immédiatement', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();

      await withTempDb(async (db, stmts) => {
        const generic = await acquireBroadcastSlot();
        assert.equal(getBroadcastPoolStats().activeCount, 1);
        assert.deepEqual(getBroadcastPoolStats().inFlightIds, []);

        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');

        let sendCount = 0;
        const ch = mockChannel('c1', 'g1', {
          onSend: async () => { sendCount += 1; },
        });
        const client = mockClient({ g1: mockGuild('g1', { c1: ch }) });

        const passPromise = runScrimBroadcastDeliveryPass(client, db, stmts);

        // Tant que le slot générique est tenu : aucun send
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.equal(sendCount, 0, 'aucun send tant que slot générique occupé');
        assert.equal(getBroadcastPoolStats().activeCount, 1);

        generic.release();

        const pass = await passPromise;
        assert.ok(pass.dispatched >= 1);
        assert.equal(sendCount, 1);
        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE batch_id=?').get(batchId);
        assert.equal(d.status, 'sent');
        assert.equal(getBroadcastPoolStats().activeCount, 0);
        assert.equal(getBroadcastPoolStats().waitingCount, 0);
        assert.deepEqual(getBroadcastPoolStats().inFlightIds, []);
      });
    });

    it('tryReserve sans batch ne notifie pas (pas de récursion) ; acquire sans claim notifie', async () => {
      process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
      invalidateBroadcastConcurrencyCache();

      let freed = 0;
      setBroadcastSlotFreedHandler(() => { freed += 1; });

      const reserved = tryReserveBroadcastSlot();
      assert.ok(reserved);
      reserved.release(); // unbound dispatcher token
      assert.equal(freed, 0, 'tryReserve unbound release ne doit pas notifier');

      const generic = await acquireBroadcastSlot();
      generic.release(); // unbound generic
      assert.equal(freed, 1, 'acquire unbound release doit notifier');

      setBroadcastSlotFreedHandler(null);
      assert.equal(getBroadcastPoolStats().activeCount, 0);
    });
  });
});
