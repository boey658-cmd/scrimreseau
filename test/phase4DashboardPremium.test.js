/**
 * Phase 4 — Snapshot entitlement dashboard (dates, limits, features honestes).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import {
  fetchGuildConfig,
  buildPublicEntitlementSnapshot,
} from '../src/internalHttp/configQueries.js';
import {
  bindEntitlementStore,
  clearEntitlementCache,
  PAID_GRACE_MS,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant } from '../src/services/entitlements/entitlementStore.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';

const GUILD = '1484520688726311012';
const ADMIN = '1009269632693174422';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p4-dash-'));
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

function grantGift(db, stmts, guildId, planKey, nowMs = Date.now()) {
  return insertEntitlementGrant({
    db,
    stmts,
    guildId,
    planKey,
    source: 'gift',
    startsAt: nowMs - 1000,
    endsAt: nowMs + 365 * 24 * 3600 * 1000,
    grantedBy: ADMIN,
    reason: 'phase4-test',
    idempotencyKey: `p4-${guildId}-${planKey}-${nowMs}-${Math.random()}`,
    nowMs,
  });
}

function grantPaidInGrace(db, stmts, guildId, planKey, nowMs) {
  const startsAt = nowMs - 20_000;
  const endsAt = nowMs - 5_000;
  return insertEntitlementGrant({
    db,
    stmts,
    guildId,
    planKey,
    source: 'paid',
    startsAt,
    endsAt,
    grantedBy: ADMIN,
    reason: 'phase4-grace',
    externalRef: 'stripe-secret-ref-do-not-leak',
    idempotencyKey: `p4-grace-${guildId}-${nowMs}`,
    nowMs: startsAt,
  });
}

describe('Phase 4 — public entitlement snapshot', () => {
  it('FREE implicite : dates null, limite 1, features locked', async () => {
    await withTempDb(async (_db, stmts) => {
      const snap = buildPublicEntitlementSnapshot(GUILD, { stmts });
      assert.equal(snap.plan_key, 'FREE');
      assert.equal(snap.tier, 0);
      assert.equal(snap.source, 'none');
      assert.equal(snap.status, 'active');
      assert.equal(snap.starts_at, null);
      assert.equal(snap.ends_at, null);
      assert.equal(snap.grace_ends_at, null);
      assert.equal(snap.limits.reception_channels, 1);
      assert.equal(snap.features.elo_channel_filters, false);
      assert.equal(snap.features.multi_reception_channels, false);
      assert.equal(snap.feature_details.elo_channel_filters.available, false);
      assert.equal(snap.feature_details.enhanced_structure_profile.implemented, true);
      assert.equal(snap.feature_details.enhanced_structure_profile.available, false);
      assert.ok(!('grant_id' in snap));
      assert.ok(!('external_ref' in snap));
    });
  });

  it('gift P2 expose source/dates sans secrets + features branchées only available', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grantGift(db, stmts, GUILD, 'P2', t0);
      clearEntitlementCache();
      const snap = buildPublicEntitlementSnapshot(GUILD, { stmts, nowMs: t0 });
      assert.equal(snap.plan_key, 'P2');
      assert.equal(snap.tier, 2);
      assert.equal(snap.source, 'gift');
      assert.equal(snap.status, 'active');
      assert.ok(snap.starts_at);
      assert.ok(snap.ends_at);
      assert.equal(snap.grace_ends_at, null);
      assert.equal(snap.limits.reception_channels, 4);
      assert.equal(snap.features.elo_channel_filters, true);
      assert.equal(snap.features.multi_reception_channels, true);
      assert.equal(snap.feature_details.premium_badge.entitled, true);
      assert.equal(snap.feature_details.premium_badge.implemented, true);
      assert.equal(snap.feature_details.premium_badge.available, true);
      const json = JSON.stringify(snap);
      assert.ok(!json.includes('stripe'));
      assert.ok(!json.includes('granted_by'));
      assert.ok(!json.includes('phase4-test'));
    });
  });

  it('grace paid : status grace + grace_ends_at', async () => {
    await withTempDb(async (db, stmts) => {
      const nowMs = Date.now();
      grantPaidInGrace(db, stmts, GUILD, 'P2', nowMs);
      clearEntitlementCache();
      const snap = buildPublicEntitlementSnapshot(GUILD, { stmts, nowMs });
      assert.equal(snap.plan_key, 'P2');
      assert.equal(snap.status, 'grace');
      assert.ok(snap.grace_ends_at);
      assert.equal(snap.features.elo_channel_filters, true);
      const graceMs = Date.parse(snap.grace_ends_at);
      assert.ok(Number.isFinite(graceMs));
      assert.ok(graceMs > nowMs);
      assert.ok(graceMs <= nowMs - 5_000 + PAID_GRACE_MS + 2_000);
      const json = JSON.stringify(snap);
      assert.ok(!json.includes('stripe-secret-ref'));
      assert.ok(!json.includes('idempotency'));
    });
  });

  it('GET config inclut usage enabled/paused + entitlement enrichi (read-only)', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grantGift(db, stmts, GUILD, 'P1', t0);
      for (let i = 0; i < 3; i++) {
        db.prepare(
          `INSERT INTO guild_game_channels (guild_id, channel_id, game_key, enabled, sort_order, created_at)
           VALUES (?, ?, 'league_of_legends', 1, ?, ?)`,
        ).run(GUILD, String(100000000000000000n + BigInt(i)), i, t0 + i);
      }
      clearEntitlementCache();
      const beforeGrants = db.prepare('SELECT COUNT(*) AS c FROM entitlement_grants').get().c;
      const beforeChannels = db
        .prepare('SELECT COUNT(*) AS c FROM guild_game_channels WHERE guild_id = ?')
        .get(GUILD).c;

      const cfg = fetchGuildConfig(db, GUILD, { stmts, nowMs: t0 });
      assert.equal(cfg.entitlement.plan_key, 'P1');
      assert.equal(cfg.entitlement.limits.reception_channels, 2);
      assert.equal(cfg.reception_channel_usage.configured, 3);
      assert.equal(cfg.reception_channel_usage.enabled, 3);
      assert.equal(cfg.reception_channel_usage.active, 2);
      assert.equal(cfg.reception_channel_usage.paused, 1);
      assert.equal(cfg.reception_channel_usage.limit, 2);
      assert.equal(
        cfg.reception_channels.filter((c) => c.paused_reason === 'PLAN_LIMIT').length,
        1,
      );
      assert.ok(cfg.elo_filter_rank_options.length >= 1);

      // Second read — no mutation
      fetchGuildConfig(db, GUILD, { stmts, nowMs: t0 });
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM entitlement_grants').get().c,
        beforeGrants,
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) AS c FROM guild_game_channels WHERE guild_id = ?').get(GUILD)
          .c,
        beforeChannels,
      );
    });
  });
});
