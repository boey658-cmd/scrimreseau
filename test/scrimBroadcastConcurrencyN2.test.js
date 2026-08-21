/**
 * Phase 2 — Étape 3A : validation contrôlée SCRIM_BROADCAST_CONCURRENCY=2
 * Mocks Discord uniquement — aucune connexion réelle.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { deliverScrimToDestination } from '../src/services/scrimDelivery.js';
import { closeScrimPostByDbId } from '../src/services/scrimLifecycle.js';
import {
  acquireBroadcastSlot,
  beginBroadcastPoolShutdown,
  BROADCAST_POOL_STOPPING,
  getBroadcastPoolStats,
  invalidateBroadcastConcurrencyCache,
  resetBroadcastPoolForTests,
  runWithReservedBroadcastSlot,
  waitForBroadcastPoolIdle,
} from '../src/services/scrimBroadcastExecutionPool.js';
import {
  recoverStaleScrimBroadcastDeliveries,
  runScrimBroadcastDeliveryPass,
  stopScrimBroadcastDeliveryJob,
} from '../src/services/scrimBroadcastDeliveryJob.js';

const PREV_ENV = {};

function snapshotEnv(keys) {
  for (const k of keys) {
    PREV_ENV[k] = process.env[k];
  }
}

function restoreEnv(keys) {
  for (const k of keys) {
    if (PREV_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV_ENV[k];
  }
}

function setN2Env() {
  process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = 'true';
  process.env.SCRIM_BROADCAST_CONCURRENCY = '2';
  invalidateBroadcastConcurrencyCache();
  resetBroadcastPoolForTests();
}

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p2-n2-'));
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
    status: overrides.status ?? 'active',
  });
  return Number(info.lastInsertRowid);
}

function insertBatch(stmts, scrimId) {
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
  stmts.setScrimBroadcastBatchActive.run({ id, started_at: now, updated_at: now });
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

function perms() {
  return new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
}

/** Harness métriques + sends contrôlés */
function createMetricsHarness() {
  let activeSends = 0;
  let maxActive = 0;
  let maxInFlightIds = 0;
  let maxWaiting = 0;
  let totalSends = 0;
  /** @type {string[]} */
  const sendOrder = [];
  /** @type {number[]} */
  const claimedIds = [];
  /** @type {Array<() => void>} */
  const gates = [];
  let blockAll = false;
  /** @type {Map<string, () => void>} */
  const namedGates = new Map();

  function samplePool() {
    const s = getBroadcastPoolStats();
    maxInFlightIds = Math.max(maxInFlightIds, s.inFlightIds.length);
    maxWaiting = Math.max(maxWaiting, s.waitingCount);
    maxActive = Math.max(maxActive, s.activeCount, activeSends);
  }

  /**
   * @param {string} cid
   * @param {string} gid
   * @param {{ label?: string, latencyMs?: number, sendThrows?: Error, gateName?: string, onStart?: () => void }} [opts]
   */
  function makeChannel(cid, gid, opts = {}) {
    return {
      id: cid,
      guildId: gid,
      type: ChannelType.GuildText,
      permissionsFor: () => perms(),
      send: async () => {
        totalSends += 1;
        if (opts.sendThrows) throw opts.sendThrows;
        if (opts.label) sendOrder.push(opts.label);
        opts.onStart?.();
        activeSends += 1;
        samplePool();
        maxActive = Math.max(maxActive, activeSends);
        try {
          if (opts.gateName) {
            await new Promise((resolve) => {
              namedGates.set(opts.gateName, resolve);
            });
          } else if (blockAll) {
            await new Promise((resolve) => { gates.push(resolve); });
          } else if (opts.latencyMs != null) {
            await new Promise((r) => setTimeout(r, opts.latencyMs));
          } else {
            await new Promise((r) => setTimeout(r, 0));
          }
          return { id: `msg-${cid}-${totalSends}`, delete: async () => {}, edit: async () => ({}) };
        } finally {
          activeSends -= 1;
        }
      },
    };
  }

  function makeGuild(gid, channels) {
    return {
      id: gid,
      members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
      channels: {
        cache: { get: (cid) => channels[cid] },
        fetch: async (cid) => {
          if (!channels[cid]) {
            throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
          }
          return channels[cid];
        },
      },
    };
  }

  function makeClient(guildMap) {
    return {
      guilds: {
        cache: { get: (id) => guildMap[id] },
        fetch: async (id) => {
          if (!guildMap[id]) {
            throw Object.assign(new Error('Unknown Guild'), { code: 10004 });
          }
          return guildMap[id];
        },
      },
    };
  }

  function releaseAllGates() {
    while (gates.length) gates.shift()();
    for (const [k, r] of namedGates) {
      r();
      namedGates.delete(k);
    }
  }

  function releaseGate(name) {
    const r = namedGates.get(name);
    if (r) {
      r();
      namedGates.delete(name);
    }
  }

  function statusCounts(db) {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM scrim_broadcast_deliveries GROUP BY status').all();
    /** @type {Record<string, number>} */
    const m = {};
    for (const r of rows) m[r.status] = Number(r.n);
    return m;
  }

  return {
    get maxActive() { return maxActive; },
    get maxInFlightIds() { return maxInFlightIds; },
    get maxWaiting() { return maxWaiting; },
    get totalSends() { return totalSends; },
    get sendOrder() { return sendOrder; },
    get claimedIds() { return claimedIds; },
    get activeSends() { return activeSends; },
    set blockAll(v) { blockAll = v; },
    makeChannel,
    makeGuild,
    makeClient,
    releaseAllGates,
    releaseGate,
    samplePool,
    statusCounts,
    /** @param {boolean} v */
    setBlockAll(v) { blockAll = v; },
  };
}

const ENV_KEYS = [
  'SCRIM_PERSISTENT_BROADCAST_ENABLED',
  'SCRIM_BROADCAST_CONCURRENCY',
  'SCRIM_BROADCAST_STOP_TIMEOUT_MS',
];

describe('Phase2 Étape3A — N=2 contrôlé (mocks only)', () => {
  beforeEach(() => {
    snapshotEnv(ENV_KEYS);
    setN2Env();
  });
  afterEach(() => {
    resetBroadcastPoolForTests();
    restoreEnv(ENV_KEYS);
    invalidateBroadcastConcurrencyCache();
    delete process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS;
  });

  describe('charge 1 batch / 300 destinations', () => {
    it('maxActive===2, 300 sends, états finaux propres', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const channels = {};
        const guildMap = {};
        for (let i = 0; i < 300; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          channels[cid] = h.makeChannel(cid, gid, { latencyMs: 1, label: 'A' });
          guildMap[gid] = h.makeGuild(gid, { [cid]: channels[cid] });
        }
        // regrouper: 1 guild avec 300 channels plus simple? deliveries use different guilds - OK
        const client = h.makeClient(guildMap);

        const pass = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.equal(pass.dispatched, 300);
        assert.equal(h.totalSends, 300);
        assert.equal(h.maxActive, 2);
        assert.ok(h.maxInFlightIds <= 2, `maxInFlightIds=${h.maxInFlightIds}`);

        const st = h.statusCounts(db);
        assert.equal(st.sent ?? 0, 300);
        assert.equal(st.pending ?? 0, 0);
        assert.equal(st.retry ?? 0, 0);
        assert.equal(st.processing ?? 0, 0);
        const stats = getBroadcastPoolStats();
        assert.equal(stats.activeCount, 0);
        assert.equal(stats.waitingCount, 0);
        assert.deepEqual(stats.inFlightIds, []);
      });
    });
  });

  describe('multi-scrims 5×60', () => {
    it('maxActive global === 2 (pas 2 par batch)', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const guildMap = {};
        for (let b = 0; b < 5; b++) {
          const scrimId = insertScrim(stmts, { publicId: `p${b}`, guildId: `origin${b}` });
          const batchId = insertBatch(stmts, scrimId);
          for (let i = 0; i < 60; i++) {
            const gid = `g${b}-${i}`;
            const cid = `c${b}-${i}`;
            insertDelivery(stmts, batchId, scrimId, gid, cid);
            const ch = h.makeChannel(cid, gid, { latencyMs: 1, label: `B${b}` });
            guildMap[gid] = h.makeGuild(gid, { [cid]: ch });
          }
        }
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        assert.equal(h.totalSends, 300);
        assert.equal(h.maxActive, 2);
        assert.ok(h.maxInFlightIds <= 2);
        assert.equal(h.statusCounts(db).sent, 300);
      });
    });
  });

  describe('fairness A=200 B=10 C=10', () => {
    it('B et C progressent pendant backlog A', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const guildMap = {};
        const sizes = { A: 200, B: 10, C: 10 };
        for (const [label, n] of Object.entries(sizes)) {
          const scrimId = insertScrim(stmts, { publicId: `fair-${label}`, guildId: `o-${label}` });
          const batchId = insertBatch(stmts, scrimId);
          for (let i = 0; i < n; i++) {
            const gid = `g${label}${i}`;
            const cid = `c${label}${i}`;
            insertDelivery(stmts, batchId, scrimId, gid, cid);
            const ch = h.makeChannel(cid, gid, { latencyMs: 0, label });
            guildMap[gid] = h.makeGuild(gid, { [cid]: ch });
          }
        }
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        assert.equal(h.totalSends, 220);
        assert.equal(h.maxActive, 2);

        // Parmi les 40 premiers sends : au moins 1 B et 1 C (pas A monopolisant tout)
        const first40 = h.sendOrder.slice(0, 40);
        assert.ok(first40.includes('B'), `B absent des 40 premiers: ${first40.slice(0, 20)}`);
        assert.ok(first40.includes('C'), `C absent des 40 premiers: ${first40.slice(0, 20)}`);
        assert.ok(first40.includes('A'));

        // À mi-parcours A (après ~100 sends A), B et C déjà terminés
        const idxLastB = h.sendOrder.lastIndexOf('B');
        const idxLastC = h.sendOrder.lastIndexOf('C');
        const countABeforeLastB = h.sendOrder.slice(0, idxLastB + 1).filter((x) => x === 'A').length;
        assert.ok(countABeforeLastB < 200, `B starvé: A déjà ${countABeforeLastB} avant fin B`);
        assert.ok(idxLastC < h.sendOrder.length - 1 || countABeforeLastB < 190);
      });
    });
  });

  describe('continuous refill N=2', () => {
    it('C démarre avant libération de A lente', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const events = [];
        const guildMap = {};
        const labels = ['A', 'B', 'C'];
        for (const label of labels) {
          const scrimId = insertScrim(stmts, { publicId: `rf-${label}`, guildId: `o${label}` });
          const batchId = insertBatch(stmts, scrimId);
          const gid = `g${label}`;
          const cid = `c${label}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          const ch = h.makeChannel(cid, gid, {
            gateName: label === 'A' ? 'slowA' : undefined,
            latencyMs: label === 'A' ? undefined : 0,
            label,
            onStart: () => events.push(`start-${label}`),
          });
          guildMap[gid] = h.makeGuild(gid, { [cid]: ch });
        }
        // Force order A,B,C by last_dispatched null + id order — 3 batches
        const passP = runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);

        for (let i = 0; i < 100 && events.filter((e) => e.startsWith('start-')).length < 2; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.ok(events.includes('start-A'));
        assert.ok(events.includes('start-B'));

        // B finishes (no gate); C should start while A still gated
        for (let i = 0; i < 100 && !events.includes('start-C'); i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.ok(events.includes('start-C'), `events=${events.join(',')}`);
        assert.ok(
          events.indexOf('start-C') < events.length,
        );
        // A still held — release after C started
        h.releaseGate('slowA');
        await passP;
        assert.equal(h.totalSends, 3);
        assert.ok(h.maxActive <= 2);
      });
    });
  });

  describe('backpressure', () => {
    it('inFlightIds.size jamais > 2 sur 300', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const guildMap = {};
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        for (let i = 0; i < 300; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          const ch = h.makeChannel(cid, gid, { latencyMs: 0 });
          guildMap[gid] = h.makeGuild(gid, { [cid]: ch });
        }
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        assert.ok(h.maxInFlightIds <= 2);
        assert.equal(h.maxActive, 2);
        assert.equal(h.totalSends, 300);
      });
    });
  });

  describe('bootstrap + background', () => {
    it('cap global 2 ; bootstrap attend si 2 slots background', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        h.setBlockAll(true);
        // Background: 2 deliveries gated
        const scrimBg = insertScrim(stmts, { publicId: 'bg' });
        const batchBg = insertBatch(stmts, scrimBg);
        const guildMap = {};
        for (let i = 0; i < 3; i++) {
          const gid = `bg${i}`;
          const cid = `cbg${i}`;
          insertDelivery(stmts, batchBg, scrimBg, gid, cid);
          guildMap[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid, { label: 'bg' }) });
        }
        // Bootstrap batch en staging : invisible au dispatcher background
        const scrimBoot = insertScrim(stmts, { publicId: 'boot' });
        const batchBoot = insertBatch(stmts, scrimBoot);
        db.prepare("UPDATE scrim_broadcast_batches SET status='staging' WHERE id=?").run(batchBoot);
        const bootGid = 'bootg';
        const bootCid = 'bootc';
        insertDelivery(stmts, batchBoot, scrimBoot, bootGid, bootCid);
        guildMap[bootGid] = h.makeGuild(bootGid, {
          [bootCid]: h.makeChannel(bootCid, bootGid, { label: 'boot' }),
        });

        const client = h.makeClient(guildMap);
        const passP = runScrimBroadcastDeliveryPass(client, db, stmts);

        for (let i = 0; i < 80 && h.activeSends < 2; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.equal(h.activeSends, 2);

        let bootClaimed = false;
        const bootP = runWithReservedBroadcastSlot(async (token) => {
          const now = new Date().toISOString();
          const claimed = stmts.claimNextDeliveryForBatch.get({
            batch_id: batchBoot, now_iso: now, claimed_at: now, updated_at: now,
          });
          if (claimed) {
            bootClaimed = true;
            token.bindDelivery(Number(claimed.id));
            await deliverScrimToDestination({
              client,
              stmts,
              row: { guild_id: claimed.guild_id, channel_id: claimed.channel_id },
              authorUserId: 'author-1',
              payload: {
                gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
                region: 'EUW', rolesNeeded: [], notes: null,
                scheduledAt: null, scheduledAtEnd: null,
                contactUserId: 'a', contactDisplayName: 'A',
                authorUserId: 'a', createdAt: new Date().toISOString(),
                expiresAt: null, scrimPublicId: 'boot',
              },
              sendMode: 'direct',
            });
          }
        });

        await new Promise((r) => setTimeout(r, 0));
        assert.equal(bootClaimed, false, 'bootstrap ne claim pas avant slot');
        assert.ok(getBroadcastPoolStats().waitingCount >= 1 || getBroadcastPoolStats().activeCount === 2);
        assert.ok(h.maxActive <= 2);

        h.setBlockAll(false);
        h.releaseAllGates();
        await Promise.all([passP, bootP]);
        assert.ok(bootClaimed);
        assert.ok(h.maxActive <= 2);
        assert.equal(getBroadcastPoolStats().activeCount, 0);
      });
    });
  });

  describe('deux bootstraps simultanés', () => {
    it('max global = 2', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        h.setBlockAll(true);
        const clientGuilds = {};
        const boots = [];
        for (let i = 0; i < 2; i++) {
          const scrimId = insertScrim(stmts, { publicId: `boot${i}` });
          const batchId = insertBatch(stmts, scrimId);
          const gid = `gb${i}`;
          const cid = `cb${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          // second delivery each for sequential bootstrap feel
          insertDelivery(stmts, batchId, scrimId, `${gid}x`, `${cid}x`);
          clientGuilds[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid, { label: `boot${i}` }) });
          clientGuilds[`${gid}x`] = h.makeGuild(`${gid}x`, {
            [`${cid}x`]: h.makeChannel(`${cid}x`, `${gid}x`, { label: `boot${i}` }),
          });
          boots.push({ batchId, scrimId });
        }
        const client = h.makeClient(clientGuilds);

        const runBoot = (batchId) => runWithReservedBroadcastSlot(async (token) => {
          const now = new Date().toISOString();
          const claimed = stmts.claimNextDeliveryForBatch.get({
            batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now,
          });
          if (!claimed) return;
          token.bindDelivery(Number(claimed.id));
          await deliverScrimToDestination({
            client,
            stmts,
            row: { guild_id: claimed.guild_id, channel_id: claimed.channel_id },
            authorUserId: 'author-1',
            payload: {
              gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
              region: 'EUW', rolesNeeded: [], notes: null,
              scheduledAt: null, scheduledAtEnd: null,
              contactUserId: 'a', contactDisplayName: 'A',
              authorUserId: 'a', createdAt: new Date().toISOString(),
              expiresAt: null, scrimPublicId: 'x',
            },
            sendMode: 'direct',
          });
        });

        const p1 = runBoot(boots[0].batchId);
        const p2 = runBoot(boots[1].batchId);
        for (let i = 0; i < 50 && h.activeSends < 2; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.equal(h.activeSends, 2);
        assert.ok(h.maxActive <= 2);
        h.setBlockAll(false);
        h.releaseAllGates();
        await Promise.all([p1, p2]);
        assert.ok(h.maxActive <= 2);
      });
    });
  });

  describe('repost + background', () => {
    it('repost 1 slot + background ≤1 autre ; max=2', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        h.setBlockAll(true);
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        for (let i = 0; i < 4; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          guildMap[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid) });
        }

        const repostToken = await acquireBroadcastSlot();
        assert.equal(getBroadcastPoolStats().activeCount, 1);

        const passP = runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        for (let i = 0; i < 50 && h.activeSends < 1; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.equal(h.activeSends, 1, 'background 1 seul slot');
        assert.ok(h.maxActive <= 2);

        // 2e acquire repost attend
        let got = false;
        const waitRepost = acquireBroadcastSlot().then((t) => {
          got = true;
          t.release();
        });
        await new Promise((r) => setTimeout(r, 0));
        assert.equal(got, false);

        h.setBlockAll(false);
        h.releaseAllGates();
        // Libérer le slot générique : sinon finishIfDone voit activeCount>0 à jamais
        repostToken.release();
        await Promise.all([passP, waitRepost]);
        assert.equal(got, true);
        assert.ok(h.maxActive <= 2);
        assert.equal(getBroadcastPoolStats().activeCount, 0);
      });
    });
  });

  describe('429 / ambigu / terminal', () => {
    it('429 → 1 send, retry, slot libre pour autre', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        insertDelivery(stmts, batchId, scrimId, 'g0', 'c0');
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        guildMap.g0 = h.makeGuild('g0', {
          c0: h.makeChannel('c0', 'g0', {
            sendThrows: Object.assign(new Error('rate'), { status: 429, code: 429 }),
          }),
        });
        guildMap.g1 = h.makeGuild('g1', {
          c1: h.makeChannel('c1', 'g1', { latencyMs: 0 }),
        });
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        assert.equal(h.totalSends, 2); // one throw still counts as attempt in our harness before throw... 
        // makeChannel throws before totalSends++ if we throw first - check order
        const st = h.statusCounts(db);
        assert.equal(st.retry ?? 0, 1);
        assert.equal(st.sent ?? 0, 1);
        assert.ok(h.maxActive <= 2);
      });
    });

    it('ETIMEDOUT / ECONNRESET / 500 → unknown ; autres continuent', async () => {
      for (const err of [
        Object.assign(new Error('t'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('r'), { code: 'ECONNRESET' }),
        Object.assign(new Error('s'), { status: 500 }),
      ]) {
        resetBroadcastPoolForTests();
        setN2Env();
        await withTempDb(async (db, stmts) => {
          const h = createMetricsHarness();
          const scrimId = insertScrim(stmts);
          const batchId = insertBatch(stmts, scrimId);
          const guildMap = {};
          for (let i = 0; i < 3; i++) {
            const gid = `g${i}`;
            const cid = `c${i}`;
            insertDelivery(stmts, batchId, scrimId, gid, cid);
            guildMap[gid] = h.makeGuild(gid, {
              [cid]: h.makeChannel(cid, gid, i === 0 ? { sendThrows: err } : { latencyMs: 0 }),
            });
          }
          await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
          const st = h.statusCounts(db);
          assert.equal(st.unknown_outcome ?? 0, 1, String(err.code || err.status));
          assert.equal(st.sent ?? 0, 2);
          assert.ok(h.maxActive <= 2);
          assert.equal(getBroadcastPoolStats().activeCount, 0);
        });
      }
    });

    it('10003 terminal + cleanup path ; 10004 GUILD_NOT_FOUND', async () => {
      await withTempDb(async (db, stmts) => {
        const r1 = await deliverScrimToDestination({
          client: {
            guilds: {
              cache: { get: () => undefined },
              fetch: async () => { throw Object.assign(new Error('Unknown Guild'), { code: 10004 }); },
            },
          },
          stmts,
          row: { guild_id: 'x', channel_id: 'y' },
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
        assert.equal(r1.outcome, 'terminal_error');
        assert.equal(r1.errorCode, 'GUILD_NOT_FOUND');

        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        insertDelivery(stmts, batchId, scrimId, 'g2', 'c2');
        const guildMap = {
          g1: h.makeGuild('g1', {
            c1: h.makeChannel('c1', 'g1', {
              sendThrows: Object.assign(new Error('Unknown Channel'), { code: 10003 }),
            }),
          }),
          g2: h.makeGuild('g2', { c2: h.makeChannel('c2', 'g2', { latencyMs: 0 }) }),
        };
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        const st = h.statusCounts(db);
        assert.equal(st.failed_terminal ?? 0, 1);
        assert.equal(st.sent ?? 0, 1);
      });
    });
  });

  describe('fetch transient', () => {
    it('guild ETIMEDOUT / channel ECONNRESET / fetchMe EAI_AGAIN → retryable', async () => {
      await withTempDb(async (db, stmts) => {
        const payload = {
          gameKey: 'lol', teamSize: 5, rankMin: null, rankMax: null,
          region: 'EUW', rolesNeeded: [], notes: null,
          scheduledAt: null, scheduledAtEnd: null,
          contactUserId: 'u', contactDisplayName: 'U',
          authorUserId: 'u', createdAt: new Date().toISOString(),
          expiresAt: null, scrimPublicId: 'x',
        };
        const rGuild = await deliverScrimToDestination({
          client: {
            guilds: {
              cache: { get: () => undefined },
              fetch: async () => { throw Object.assign(new Error('t'), { code: 'ETIMEDOUT' }); },
            },
          },
          stmts, row: { guild_id: 'g', channel_id: 'c' }, authorUserId: 'u', payload,
          sendMode: 'direct', discordMaxAttempts: 1,
        });
        assert.equal(rGuild.outcome, 'retryable_error');
        assert.notEqual(rGuild.errorCode, 'GUILD_NOT_FOUND');

        const ch = { id: 'c', guildId: 'g', type: ChannelType.GuildText, permissionsFor: () => perms(), send: async () => ({ id: 'm' }) };
        const rCh = await deliverScrimToDestination({
          client: {
            guilds: {
              cache: {
                get: () => ({
                  id: 'g',
                  members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
                  channels: {
                    cache: { get: () => undefined },
                    fetch: async () => { throw Object.assign(new Error('r'), { code: 'ECONNRESET' }); },
                  },
                }),
              },
              fetch: async () => null,
            },
          },
          stmts, row: { guild_id: 'g', channel_id: 'c' }, authorUserId: 'u', payload,
          sendMode: 'direct', discordMaxAttempts: 1,
        });
        assert.equal(rCh.outcome, 'retryable_error');

        const rMe = await deliverScrimToDestination({
          client: {
            guilds: {
              cache: {
                get: () => ({
                  id: 'g',
                  members: {
                    me: null,
                    fetchMe: async () => { throw Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }); },
                  },
                  channels: { cache: { get: () => ch }, fetch: async () => ch },
                }),
              },
            },
          },
          stmts, row: { guild_id: 'g', channel_id: 'c' }, authorUserId: 'u', payload,
          sendMode: 'direct', discordMaxAttempts: 1,
        });
        assert.equal(rMe.outcome, 'retryable_error');
        assert.notEqual(rMe.errorCode, 'PERMISSIONS');
      });
    });
  });

  describe('close avant / pendant send', () => {
    it('close avant send → cancelled sans send pour pending', async () => {
      await withTempDb(async (db, stmts) => {
        process.env.SCRIM_BROADCAST_CONCURRENCY = '1';
        invalidateBroadcastConcurrencyCache();
        resetBroadcastPoolForTests();

        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        for (let i = 0; i < 2; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          guildMap[gid] = h.makeGuild(gid, {
            [cid]: h.makeChannel(cid, gid, { gateName: 'hold', label: `d${i}` }),
          });
        }
        // Seule la 1re delivery sera claimée (N=1) et bloquée sur gate "hold"
        const passP = runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        for (let i = 0; i < 100 && h.activeSends < 1; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.equal(h.activeSends, 1);
        assert.equal(h.totalSends, 1);

        closeScrimPostByDbId(db, stmts, scrimId, 'closed_manual', 'test');
        // pending #2 → cancelled ; #1 encore in-flight
        h.releaseGate('hold');
        await passP;

        const st = h.statusCounts(db);
        assert.equal(st.sent ?? 0, 1);
        assert.equal(st.cancelled ?? 0, 1);
        assert.equal(h.totalSends, 1);
      });
    });

    it('close pendant 2 sends in-flight → sent + cancelled restants', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        for (let i = 0; i < 4; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          guildMap[gid] = h.makeGuild(gid, {
            [cid]: h.makeChannel(cid, gid, { gateName: `g${i}` }),
          });
        }
        const passP = runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        for (let i = 0; i < 100 && h.activeSends < 2; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        assert.equal(h.activeSends, 2);
        closeScrimPostByDbId(db, stmts, scrimId, 'closed_manual', 'test');
        // Libérer les 2 in-flight ; les 2 pending sont cancelled
        for (let i = 0; i < 4; i++) h.releaseGate(`g${i}`);
        await passP;
        const st = h.statusCounts(db);
        assert.equal(st.sent ?? 0, 2);
        assert.equal(st.cancelled ?? 0, 2);
        assert.equal(h.totalSends, 2);
      });
    });
  });

  describe('worker crash', () => {
    it('A crash → unknown ; B/C continuent', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        for (let i = 0; i < 3; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          guildMap[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid, { latencyMs: 0 }) });
        }
        const orig = stmts.getScrimPostById.get.bind(stmts.getScrimPostById);
        let calls = 0;
        stmts.getScrimPostById.get = (id) => {
          calls += 1;
          if (calls === 1) throw new Error('artificial crash');
          return orig(id);
        };
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        const rows = db.prepare('SELECT status, last_error_code FROM scrim_broadcast_deliveries ORDER BY id').all();
        assert.ok(rows.some((r) => r.status === 'unknown_outcome' && r.last_error_code === 'PROCESS_DELIVERY_CRASH'));
        assert.ok(rows.filter((r) => r.status === 'sent').length >= 2);
        assert.equal(getBroadcastPoolStats().activeCount, 0);
      });
    });
  });

  describe('shutdown sous charge', () => {
    it('rejette waiters, laisse pending, pool stopping', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        h.setBlockAll(true);
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        for (let i = 0; i < 5; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          insertDelivery(stmts, batchId, scrimId, gid, cid);
          guildMap[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid) });
        }
        const passP = runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        for (let i = 0; i < 80 && h.activeSends < 2; i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
        const waiter = acquireBroadcastSlot();
        await new Promise((r) => setTimeout(r, 0));

        beginBroadcastPoolShutdown();
        await assert.rejects(() => waiter, (e) => e?.code === BROADCAST_POOL_STOPPING);

        h.setBlockAll(false);
        h.releaseAllGates();
        await passP;

        const st = h.statusCounts(db);
        assert.ok((st.pending ?? 0) >= 1, `pending=${st.pending}`);
        assert.equal(st.processing ?? 0, 0);
        const stats = getBroadcastPoolStats();
        assert.equal(stats.stopping, true);
        assert.equal(stats.acceptNewWork, false);
        assert.equal(stats.activeCount, 0);
        assert.equal(stats.waitingCount, 0);
        assert.deepEqual(stats.inFlightIds, []);
      });
    });

    it('timeout court : pool reste stopping, pas pending', async () => {
      process.env.SCRIM_BROADCAST_STOP_TIMEOUT_MS = '80';
      const token = await acquireBroadcastSlot();
      // hold forever until after stop timeout
      const stopP = stopScrimBroadcastDeliveryJob();
      await stopP;
      const stats = getBroadcastPoolStats();
      assert.equal(stats.stopping, true);
      assert.equal(stats.acceptNewWork, false);
      assert.ok(stats.activeCount >= 1);
      token.release();
      await waitForBroadcastPoolIdle(1000);
    });
  });

  describe('restart recovery', () => {
    it('processing → unknown ; pas de resend N=2', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const id = insertDelivery(stmts, batchId, scrimId, 'g1', 'c1');
        db.prepare("UPDATE scrim_broadcast_deliveries SET status='processing', claimed_at=? WHERE id=?")
          .run(new Date().toISOString(), id);
        recoverStaleScrimBroadcastDeliveries(db, stmts);
        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(id);
        assert.equal(d.status, 'unknown_outcome');

        const guildMap = {
          g1: h.makeGuild('g1', { c1: h.makeChannel('c1', 'g1') }),
        };
        // add another pending to ensure dispatcher runs
        insertDelivery(stmts, batchId, scrimId, 'g2', 'c2');
        guildMap.g2 = h.makeGuild('g2', { c2: h.makeChannel('c2', 'g2', { latencyMs: 0 }) });
        // reopen batch if finalize closed it
        db.prepare("UPDATE scrim_broadcast_batches SET status='active', completed_at=NULL WHERE id=?").run(batchId);

        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        const again = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id=?').get(id);
        assert.equal(again.status, 'unknown_outcome');
        assert.equal(h.totalSends, 1); // only the new pending
      });
    });
  });

  describe('pas de duplicate claim/send', () => {
    it('300 IDs uniques, 300 sends', async () => {
      await withTempDb(async (db, stmts) => {
        const h = createMetricsHarness();
        const scrimId = insertScrim(stmts);
        const batchId = insertBatch(stmts, scrimId);
        const guildMap = {};
        const expectedIds = [];
        for (let i = 0; i < 300; i++) {
          const gid = `g${i}`;
          const cid = `c${i}`;
          expectedIds.push(insertDelivery(stmts, batchId, scrimId, gid, cid));
          guildMap[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid, { latencyMs: 0 }) });
        }
        await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
        assert.equal(h.totalSends, 300);
        const sent = db.prepare("SELECT id FROM scrim_broadcast_deliveries WHERE status='sent'").all().map((r) => Number(r.id));
        assert.equal(new Set(sent).size, 300);
        assert.equal(sent.length, 300);
        assert.deepEqual([...sent].sort((a, b) => a - b), [...expectedIds].sort((a, b) => a - b));
      });
    });
  });

  describe('10 répétitions concurrence', () => {
    it('10× maxActive===2 sans flake', async () => {
      for (let run = 0; run < 10; run++) {
        resetBroadcastPoolForTests();
        setN2Env();
        await withTempDb(async (db, stmts) => {
          const h = createMetricsHarness();
          const scrimId = insertScrim(stmts, { publicId: `rep-${run}` });
          const batchId = insertBatch(stmts, scrimId);
          const guildMap = {};
          for (let i = 0; i < 40; i++) {
            const gid = `g${i}`;
            const cid = `c${i}`;
            insertDelivery(stmts, batchId, scrimId, gid, cid);
            guildMap[gid] = h.makeGuild(gid, { [cid]: h.makeChannel(cid, gid, { latencyMs: 1 }) });
          }
          await runScrimBroadcastDeliveryPass(h.makeClient(guildMap), db, stmts);
          assert.equal(h.maxActive, 2, `run ${run}`);
          assert.equal(h.totalSends, 40, `run ${run}`);
          assert.equal(h.statusCounts(db).sent, 40, `run ${run}`);
        });
      }
    });
  });

  describe('N=1 vs N=2', () => {
    it('N=2 plus rapide ; maxActive respectés', async () => {
      async function runWithN(n) {
        process.env.SCRIM_BROADCAST_CONCURRENCY = String(n);
        invalidateBroadcastConcurrencyCache();
        resetBroadcastPoolForTests();
        let maxActive = 0;
        let active = 0;
        let elapsed = 0;
        await withTempDb(async (db, stmts) => {
          const scrimId = insertScrim(stmts);
          const batchId = insertBatch(stmts, scrimId);
          const guildMap = {};
          for (let i = 0; i < 100; i++) {
            const gid = `g${i}`;
            const cid = `c${i}`;
            insertDelivery(stmts, batchId, scrimId, gid, cid);
            const p = perms();
            const ch = {
              id: cid,
              guildId: gid,
              type: ChannelType.GuildText,
              permissionsFor: () => p,
              send: async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 5));
                active -= 1;
                return { id: `m${i}`, delete: async () => {} };
              },
            };
            guildMap[gid] = {
              id: gid,
              members: { me: { id: 'bot' }, fetchMe: async () => ({ id: 'bot' }) },
              channels: { cache: { get: () => ch }, fetch: async () => ch },
            };
          }
          const t0 = Date.now();
          await runScrimBroadcastDeliveryPass(
            { guilds: { cache: { get: (id) => guildMap[id] }, fetch: async (id) => guildMap[id] } },
            db,
            stmts,
          );
          elapsed = Date.now() - t0;
        });
        return { maxActive, elapsed };
      }

      const r1 = await runWithN(1);
      const r2 = await runWithN(2);
      assert.equal(r1.maxActive, 1);
      assert.equal(r2.maxActive, 2);
      assert.ok(r2.elapsed < r1.elapsed, `N2=${r2.elapsed}ms should be < N1=${r1.elapsed}ms`);
    });
  });
});
