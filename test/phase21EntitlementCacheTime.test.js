/**
 * Phase 2.1 — Cache entitlement borné par la prochaine frontière temporelle.
 * Les dates priment toujours sur le TTL 30s.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';
import {
  bindEntitlementStore,
  clearEntitlementCache,
  invalidateEntitlementCache,
  getCachedEffectiveEntitlement,
  getLimit,
  getPlan,
  resolveEffectiveEntitlement,
  grantPremiumGift,
  revokePremiumGrant,
  runEntitlementExpirationPass,
  computeNextEntitlementTransitionAt,
  computeEntitlementCacheExpiresAt,
  ENTITLEMENT_CACHE_TTL_MS,
  PAID_GRACE_MS,
  _entitlementCacheSize,
  _getEntitlementCacheEntry,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant as insertGrant } from '../src/services/entitlements/entitlementStore.js';
import { listActiveReceptionDestinationsForGame } from '../src/services/receptionChannels.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';

const GUILD = '1484520688726311012';
const ADMIN = '1009269632693174422';
const T0 = 1_700_000_000_000;
const TTL = ENTITLEMENT_CACHE_TTL_MS;

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p21-cache-'));
  const prev = process.env.SQLITE_PATH;
  const prevOwner = process.env.SCRIMRESEAU_OWNER_ID;
  process.env.SQLITE_PATH = path.join(dir, 'test.db');
  process.env.SCRIMRESEAU_OWNER_ID = ADMIN;
  try {
    closeDb();
    clearEntitlementCache();
    const db = getDb();
    const stmts = prepareStatements(db);
    bindEntitlementStore(stmts);
    await fn(db, stmts);
  } finally {
    stopDashboardRefreshJob();
    clearEntitlementCache();
    bindEntitlementStore(null);
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    if (prevOwner === undefined) delete process.env.SCRIMRESEAU_OWNER_ID;
    else process.env.SCRIMRESEAU_OWNER_ID = prevOwner;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {any} stmts
 * @param {object} p
 */
function grant(db, stmts, p) {
  return insertGrant({
    db,
    stmts,
    guildId: GUILD,
    grantedBy: ADMIN,
    reason: p.reason ?? 'p21',
    nowMs: p.nowMs ?? p.startsAt,
    ...p,
  });
}

function seedReceptionChannels(db, count) {
  const ids = [];
  const now = T0;
  for (let i = 0; i < count; i++) {
    const channelId = String(100000000000000001n + BigInt(i));
    ids.push(channelId);
    db.prepare(`
      INSERT INTO guild_game_channels
        (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(GUILD, channelId, UI_PRIMARY_GAME_KEY, i, now + i, now + i);
  }
  return ids;
}

describe('Phase 2.1 — computeNextEntitlementTransitionAt', () => {
  it('min des frontières futures starts/ends/grace', () => {
    const grants = [
      {
        id: 1,
        status: 'active',
        source: 'paid',
        starts_at: T0 - 1000,
        ends_at: T0 + 10_000,
        grace_ends_at: T0 + 10_000 + PAID_GRACE_MS,
      },
      {
        id: 2,
        status: 'scheduled',
        source: 'gift',
        starts_at: T0 + 5_000,
        ends_at: T0 + 20_000,
        grace_ends_at: null,
      },
    ];
    assert.equal(computeNextEntitlementTransitionAt(grants, T0), T0 + 5_000);
    assert.equal(computeNextEntitlementTransitionAt(grants, T0 + 5_000), T0 + 10_000);
    // À ends_at paid : prochaine = ends gift (avant grace 7j)
    assert.equal(computeNextEntitlementTransitionAt(grants, T0 + 10_000), T0 + 20_000);
    // Après gift ends : grace paid
    assert.equal(
      computeNextEntitlementTransitionAt(grants, T0 + 20_000),
      T0 + 10_000 + PAID_GRACE_MS,
    );
  });

  it('expiresAt = min(ttl, nextTransition)', () => {
    const grants = [
      {
        id: 1,
        status: 'active',
        source: 'gift',
        starts_at: T0,
        ends_at: T0 + 5_000,
        grace_ends_at: null,
      },
    ];
    assert.equal(
      computeEntitlementCacheExpiresAt(grants, T0, TTL),
      T0 + 5_000,
    );
    assert.equal(
      computeEntitlementCacheExpiresAt(grants, T0, 1_000),
      T0 + 1_000,
    );
    // loin de toute frontière
    assert.equal(
      computeEntitlementCacheExpiresAt(
        [{ id: 1, status: 'active', source: 'gift', starts_at: T0, ends_at: T0 + 120_000, grace_ends_at: null }],
        T0,
        TTL,
      ),
      T0 + TTL,
    );
  });

  it('fail-closed : erreur itération → nowMs', () => {
    const grants = [];
    Object.defineProperty(grants, 'length', { value: 1 });
    Object.defineProperty(grants, '0', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    assert.equal(computeEntitlementCacheExpiresAt(/** @type {any} */ (grants), T0, TTL), T0);
  });
});

describe('Phase 2.1 — frontières temporelles (fake clock)', () => {
  beforeEach(() => clearEntitlementCache());
  afterEach(() => clearEntitlementCache());

  it('1. P2 gift ends_at +5s TTL 30s → immédiat après ends_at (pas de grace)', async () => {
    await withTempDb(async (db, stmts) => {
      const endsAt = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P2',
        source: 'gift',
        startsAt: T0,
        endsAt,
      });

      const before = getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts, ttlMs: TTL });
      assert.equal(before.planKey, 'P2');
      const entry = _getEntitlementCacheEntry(GUILD);
      assert.ok(entry);
      assert.equal(entry.expiresAt, endsAt); // pas T0+1+30000

      // encore avant ends_at — hit
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt - 1, stmts, ttlMs: TTL }).planKey,
        'P2',
      );

      // exactement ends_at (exclusif) → FREE immédiatement
      clearEntitlementCache(); // force resolve path with same cache key timing
      // Without clear: expiresAt === endsAt ⇒ hit.expiresAt > endsAt is false ⇒ miss
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt, stmts, ttlMs: TTL }).planKey,
        'FREE',
      );
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt + 1, stmts, ttlMs: TTL }).planKey,
        'FREE',
      );
    });
  });

  it('2. Paid P2 → grace puis FREE immédiatement à grace_ends_at', async () => {
    await withTempDb(async (db, stmts) => {
      const endsAt = T0 + 5_000;
      const graceEnds = endsAt + PAID_GRACE_MS;
      grant(db, stmts, {
        planKey: 'P2',
        source: 'paid',
        startsAt: T0,
        endsAt,
      });

      getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts, ttlMs: TTL });
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, endsAt);

      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt, stmts, ttlMs: TTL }).planKey,
        'P2',
      );
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt, stmts, ttlMs: TTL }).status,
        'grace',
      );
      const duringGrace = _getEntitlementCacheEntry(GUILD);
      assert.ok(duringGrace);
      assert.equal(duringGrace.expiresAt, Math.min(endsAt + TTL, graceEnds));

      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: graceEnds, stmts, ttlMs: TTL }).planKey,
        'FREE',
      );
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: graceEnds + 1, stmts, ttlMs: TTL }).planKey,
        'FREE',
      );
    });
  });

  it('3. Gift P2 ends_at → FREE immédiat (pas de grace)', async () => {
    await withTempDb(async (db, stmts) => {
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: T0, endsAt: T0 + 5_000,
      });
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 5_000, stmts }).planKey,
        'FREE',
      );
    });
  });

  it('4. FREE + gift P2 scheduled +5s → P2 à starts_at', async () => {
    await withTempDb(async (db, stmts) => {
      const start = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: start, endsAt: start + 10_000, nowMs: T0,
      });

      const freeSnap = getCachedEffectiveEntitlement(GUILD, { nowMs: T0, stmts, ttlMs: TTL });
      assert.equal(freeSnap.planKey, 'FREE');
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, start);

      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: start - 1, stmts, ttlMs: TTL }).planKey,
        'FREE',
      );
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: start, stmts, ttlMs: TTL }).planKey,
        'P2',
      );
    });
  });

  it('5. Paid P1 + gift P2 scheduled → P2 à starts_at gift', async () => {
    await withTempDb(async (db, stmts) => {
      grant(db, stmts, {
        planKey: 'P1', source: 'paid', startsAt: T0, endsAt: T0 + 60_000,
      });
      const giftStart = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: giftStart, endsAt: giftStart + 10_000, nowMs: T0,
      });

      const s0 = getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts, ttlMs: TTL });
      assert.equal(s0.planKey, 'P1');
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, giftStart);

      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: giftStart, stmts, ttlMs: TTL }).planKey,
        'P2',
      );
    });
  });

  it('6. Gift P2 expire + paid P1 reste → P1 immédiat', async () => {
    await withTempDb(async (db, stmts) => {
      grant(db, stmts, {
        planKey: 'P1', source: 'paid', startsAt: T0, endsAt: T0 + 60_000,
      });
      const giftEnd = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: T0, endsAt: giftEnd,
      });

      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts, ttlMs: TTL }).planKey,
        'P2',
      );
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, giftEnd);

      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: giftEnd, stmts, ttlMs: TTL }).planKey,
        'P1',
      );
    });
  });

  it('7. P3 expire → FREE → destinations 10 → 1 immédiat', async () => {
    await withTempDb(async (db, stmts) => {
      seedReceptionChannels(db, 10);
      const endsAt = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P3', source: 'gift', startsAt: T0, endsAt,
      });

      assert.equal(getLimit(GUILD, 'reception_channels', { nowMs: endsAt - 1, stmts }), 10);
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, { nowMs: endsAt - 1 })
          .filter((d) => d.guild_id === GUILD).length,
        10,
      );

      // Warm cache juste avant
      getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt - 1, stmts, ttlMs: TTL });
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, endsAt);

      assert.equal(getLimit(GUILD, 'reception_channels', { nowMs: endsAt, stmts }), 1);
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, { nowMs: endsAt })
          .filter((d) => d.guild_id === GUILD).length,
        1,
      );
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, { nowMs: endsAt + 1 })
          .filter((d) => d.guild_id === GUILD).length,
        1,
      );
    });
  });

  it('8. Cache hit loin de transition conserve TTL', async () => {
    await withTempDb(async (db, stmts) => {
      grant(db, stmts, {
        planKey: 'P1', source: 'gift', startsAt: T0, endsAt: T0 + 120_000,
      });
      getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts, ttlMs: TTL });
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, T0 + 1 + TTL);

      const mid = T0 + 1 + 10_000;
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: mid, stmts, ttlMs: TTL }).planKey,
        'P1',
      );
      // toujours la même entrée (hit)
      assert.equal(_getEntitlementCacheEntry(GUILD)?.expiresAt, T0 + 1 + TTL);
    });
  });

  it('9. Invalidation explicite avant TTL', async () => {
    await withTempDb(async (db, stmts) => {
      const g = grantPremiumGift({
        db, stmts, guildId: GUILD, planKey: 'P2',
        startsAt: T0, endsAt: T0 + 60_000, grantedBy: ADMIN, reason: 'x',
        skipAdminCheck: true, nowMs: T0,
      });
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts }).planKey,
        'P2',
      );
      revokePremiumGrant({
        db, stmts, grantId: g.id, revokedBy: ADMIN, revokeReason: 'r',
        skipAdminCheck: true, nowMs: T0 + 2,
      });
      assert.equal(
        getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 3, stmts }).planKey,
        'FREE',
      );
    });
  });

  it('10. Restart / resolve hors cache selon dates', async () => {
    await withTempDb(async (db, stmts) => {
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: T0, endsAt: T0 + 5_000,
      });
      clearEntitlementCache();
      assert.equal(resolveEffectiveEntitlement(stmts, GUILD, T0 + 4_999).planKey, 'P2');
      assert.equal(resolveEffectiveEntitlement(stmts, GUILD, T0 + 5_000).planKey, 'FREE');
      // Simule restart : clear + rebind
      clearEntitlementCache();
      assert.equal(getPlan(GUILD, { nowMs: T0 + 5_001, stmts, bypassCache: true }), 'FREE');
    });
  });
});

describe('Phase 2.1 — multi-salons après expiration (intégration)', () => {
  it('P2 4 salons : T-1ms = 4 dest ; T et T+1ms = 1 dest (FREE)', async () => {
    await withTempDb(async (db, stmts) => {
      seedReceptionChannels(db, 4);
      const endsAt = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: T0, endsAt,
      });

      // Warm cache
      getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt - 1, stmts, ttlMs: TTL });

      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, { nowMs: endsAt - 1 })
          .filter((d) => d.guild_id === GUILD).length,
        4,
      );
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, { nowMs: endsAt })
          .filter((d) => d.guild_id === GUILD).length,
        1,
      );
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY, { nowMs: endsAt + 1 })
          .filter((d) => d.guild_id === GUILD).length,
        1,
      );
    });
  });
});

describe('Phase 2.1 — concurrence cache / expiration', () => {
  it('read pendant expiration + job + invalidate : pas de Premium prolongé', async () => {
    await withTempDb(async (db, stmts) => {
      const endsAt = T0 + 5_000;
      grant(db, stmts, {
        planKey: 'P2', source: 'gift', startsAt: T0, endsAt,
      });
      getCachedEffectiveEntitlement(GUILD, { nowMs: T0 + 1, stmts, ttlMs: TTL });

      const results = await Promise.all([
        Promise.resolve(getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt, stmts, ttlMs: TTL })),
        Promise.resolve(runEntitlementExpirationPass(stmts, endsAt)),
        Promise.resolve(invalidateEntitlementCache(GUILD)),
        Promise.resolve(getCachedEffectiveEntitlement(GUILD, { nowMs: endsAt + 1, stmts, ttlMs: TTL })),
      ]);

      assert.equal(results[0].planKey, 'FREE');
      assert.equal(results[3].planKey, 'FREE');
      assert.ok(results[1].normalized >= 0);
      assert.equal(getLimit(GUILD, 'reception_channels', { nowMs: endsAt + 2, stmts }), 1);
    });
  });
});
