/**
 * Phase 2 — Multi-salons Premium : quotas, add/remove/reorder, downgrade/upgrade,
 * destination discovery, concurrence, security, FREE non-régression.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import {
  listActiveReceptionDestinationsForGame,
  listEffectiveReceptionDestinationsForGame,
  buildReceptionChannelsDashboardView,
  applyReceptionChannelLimit,
} from '../src/services/receptionChannels.js';
import {
  bindEntitlementStore,
  clearEntitlementCache,
  getLimit,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant } from '../src/services/entitlements/entitlementStore.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';

const GUILD = '1484520688726311012';
const GUILD_B = '1436848619796828322';
const GUILD_C = '1399999999999999999';
const ADMIN = '1009269632693174422';

function ch(n) {
  return String(100000000000000000n + BigInt(n));
}

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p2-ms-'));
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
    for (const g of [GUILD, GUILD_B, GUILD_C]) {
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: g,
        bypass_member_minimum: 1,
        updated_by: ADMIN,
        updated_at: new Date().toISOString(),
        note: 'phase2-test',
      });
    }
    await fn(db, stmts, dir);
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
 * @param {string} guildId
 * @param {string} planKey
 * @param {number} [nowMs]
 */
function grantPlan(db, stmts, guildId, planKey, nowMs = Date.now()) {
  return insertEntitlementGrant({
    db,
    stmts,
    guildId,
    planKey,
    source: 'gift',
    startsAt: nowMs - 1000,
    endsAt: nowMs + 365 * 24 * 3600 * 1000,
    grantedBy: ADMIN,
    reason: 'phase2-test',
    idempotencyKey: `p2-${guildId}-${planKey}-${nowMs}-${Math.random()}`,
    nowMs,
  });
}

/** Force FREE immédiat (dates passées — le resolver lit les dates, pas seulement status). */
function expireAllGrants(db, guildId) {
  const endsAt = Date.now() - 60_000;
  const startsAt = endsAt - 1000;
  db.prepare(
    `UPDATE entitlement_grants
     SET starts_at = ?, ends_at = ?, grace_ends_at = NULL, status = 'expired', updated_at = ?
     WHERE guild_id = ?`,
  ).run(startsAt, endsAt, Date.now(), guildId);
  clearEntitlementCache();
}

/**
 * Insert N reception channels with contiguous sort_order.
 * @param {import('better-sqlite3').Database} db
 * @param {string} guildId
 * @param {number} count
 * @param {{ enabled?: boolean, startN?: number }} [opts]
 */
function seedChannels(db, guildId, count, opts = {}) {
  const enabled = opts.enabled === false ? 0 : 1;
  const startN = opts.startN ?? 1;
  const now = Date.now();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const channelId = ch(startN + i);
    ids.push(channelId);
    db.prepare(`
      INSERT INTO guild_game_channels
        (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, channelId, UI_PRIMARY_GAME_KEY, enabled, i, now + i, now + i);
  }
  return ids;
}

function makeTextChannel(channelId, guildId = GUILD) {
  const perms = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return {
    id: channelId,
    type: ChannelType.GuildText,
    guildId,
    guild: { id: guildId },
    permissionsFor: () => perms,
  };
}

function makeWriteCtx(db, stmts, channelsMap = new Map()) {
  const guild = {
    id: GUILD,
    ownerId: ADMIN,
    memberCount: 200,
    members: {
      me: {
        id: 'bot',
        permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      },
      fetch: async () => ({
        id: ADMIN,
        permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
      }),
      fetchMe: async () => guild.members.me,
    },
    channels: {
      cache: {
        get: (id) => channelsMap.get(id) ?? null,
      },
      fetch: async (id) => channelsMap.get(id) ?? null,
    },
  };
  return {
    client: {
      guilds: {
        cache: { get: () => guild },
        fetch: async () => guild,
      },
    },
    guild,
    db,
    stmts,
    guildId: GUILD,
    actorDiscordUserId: ADMIN,
  };
}

describe('Phase 2 — modèle enabled=user_enabled + effective calculé', () => {
  it('enabled=0 jamais réactivé par upgrade plan', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P2');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 3);
      db.prepare(
        `UPDATE guild_game_channels SET enabled = 0 WHERE channel_id = ?`,
      ).run(ids[1]);

      assert.equal(getLimit(GUILD, 'reception_channels', { stmts, bypassCache: true }), 4);
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY);
      const forG = dest.filter((d) => d.guild_id === GUILD);
      assert.equal(forG.length, 2);
      assert.deepEqual(
        forG.map((d) => d.channel_id),
        [ids[0], ids[2]],
      );

      // Downgrade FREE
      expireAllGrants(db, GUILD);
      assert.equal(getLimit(GUILD, 'reception_channels', { stmts, bypassCache: true }), 1);
      const destFree = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.equal(destFree.length, 1);
      assert.equal(destFree[0].channel_id, ids[0]);

      // Re-gift P2 — salon user-disabled reste off
      grantPlan(db, stmts, GUILD, 'P2', Date.now() + 10);
      clearEntitlementCache();
      const destUp = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.equal(destUp.length, 2);
      assert.ok(!destUp.some((d) => d.channel_id === ids[1]));
    });
  });

  it('dashboard view pausedReason PLAN_LIMIT sans write', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 4); // > limit 2
      const view = buildReceptionChannelsDashboardView(stmts, GUILD);
      assert.equal(view.receptionChannelUsage.limit, 2);
      assert.equal(view.receptionChannelUsage.active, 2);
      assert.equal(view.receptionChannelUsage.configured, 4);
      assert.equal(view.receptionChannels.filter((c) => c.effectiveActive).length, 2);
      assert.equal(
        view.receptionChannels.filter((c) => c.pausedReason === 'PLAN_LIMIT').length,
        2,
      );
      assert.deepEqual(
        view.receptionChannels.filter((c) => c.effectiveActive).map((c) => c.channelId),
        [ids[0], ids[1]],
      );
      // Aucune row enabled flippée
      const still = db.prepare(
        `SELECT COUNT(*) AS n FROM guild_game_channels WHERE guild_id = ? AND enabled = 1`,
      ).get(GUILD);
      assert.equal(still.n, 4);
    });
  });
});

describe('Phase 2 — quotas add FREE/P1/P2/P3', () => {
  async function assertAddUntilLimit(planKey, limit) {
    await withTempDb(async (db, stmts) => {
      if (planKey !== 'FREE') {
        grantPlan(db, stmts, GUILD, planKey);
        clearEntitlementCache();
      }
      assert.equal(getLimit(GUILD, 'reception_channels', { stmts, bypassCache: true }), limit);

      const channels = new Map();
      for (let i = 1; i <= limit + 1; i++) {
        channels.set(ch(i), makeTextChannel(ch(i)));
      }
      const ctx = makeWriteCtx(db, stmts, channels);

      for (let i = 1; i <= limit; i++) {
        const r = await applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_add',
          channel_id: ch(i),
        });
        assert.equal(r.noop, false);
      }

      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_add',
          channel_id: ch(limit + 1),
        }),
        (err) => err instanceof ConfigWriteError
          && err.code === 'RECEPTION_CHANNEL_LIMIT_REACHED'
          && err.status === 403,
      );

      const count = db.prepare(
        `SELECT COUNT(*) AS n FROM guild_game_channels WHERE guild_id = ? AND game_key = ?`,
      ).get(GUILD, UI_PRIMARY_GAME_KEY);
      assert.equal(count.n, limit);

      const dest = listEffectiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.equal(dest.length, limit);
    });
  }

  it('FREE: 1 OK, 2 refus', async () => {
    await assertAddUntilLimit('FREE', 1);
  });
  it('P1: 2 OK, 3 refus', async () => {
    await assertAddUntilLimit('P1', 2);
  });
  it('P2: 4 OK, 5 refus', async () => {
    await assertAddUntilLimit('P2', 4);
  });
  it('P3: 10 OK, 11 refus', async () => {
    await assertAddUntilLimit('P3', 10);
  });

  it('add duplicate => RECEPTION_CHANNEL_ALREADY_EXISTS', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const channels = new Map([[ch(1), makeTextChannel(ch(1))]]);
      const ctx = makeWriteCtx(db, stmts, channels);
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_add',
        channel_id: ch(1),
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_add',
          channel_id: ch(1),
        }),
        (err) => err instanceof ConfigWriteError && err.code === 'RECEPTION_CHANNEL_ALREADY_EXISTS',
      );
    });
  });
});

describe('Phase 2 — remove / reorder / set_enabled', () => {
  it('remove DELETE config uniquement + normalize sort_order', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P2');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 3);
      const ctx = makeWriteCtx(db, stmts);
      const r = await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_remove',
        channel_id: ids[1],
      });
      assert.equal(r.noop, false);
      const rows = db.prepare(
        `SELECT channel_id, sort_order FROM guild_game_channels
         WHERE guild_id = ? ORDER BY sort_order ASC`,
      ).all(GUILD);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].channel_id, ids[0]);
      assert.equal(rows[0].sort_order, 0);
      assert.equal(rows[1].channel_id, ids[2]);
      assert.equal(rows[1].sort_order, 1);

      // Idempotent
      const r2 = await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_remove',
        channel_id: ids[1],
      });
      assert.equal(r2.noop, true);
    });
  });

  it('reorder inversé + downgrade respecte nouvel ordre', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P2');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 4); // A B C D
      const ctx = makeWriteCtx(db, stmts);
      const reversed = [...ids].reverse();
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_reorder',
        channel_ids: reversed,
      });
      const rows = db.prepare(
        `SELECT channel_id FROM guild_game_channels WHERE guild_id = ? ORDER BY sort_order`,
      ).all(GUILD);
      assert.deepEqual(rows.map((r) => r.channel_id), reversed);

      // Downgrade P1 → 2 premiers = D C
      expireAllGrants(db, GUILD);
      grantPlan(db, stmts, GUILD, 'P1', Date.now() + 50);
      clearEntitlementCache();
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.deepEqual(dest.map((d) => d.channel_id), [reversed[0], reversed[1]]);
    });
  });

  it('reorder: duplicate / missing / foreign refusés', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 2);
      const ctx = makeWriteCtx(db, stmts);

      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_reorder',
          channel_ids: [ids[0], ids[0]],
        }),
        (e) => e.code === 'INVALID_ORDER',
      );
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_reorder',
          channel_ids: [ids[0]],
        }),
        (e) => e.code === 'INVALID_ORDER',
      );
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_reorder',
          channel_ids: [ids[0], ids[1], ch(99)],
        }),
        (e) => e.code === 'INVALID_ORDER' || e.code === 'RECEPTION_CHANNEL_NOT_FOUND',
      );
    });
  });

  it('set_enabled disable volontaire + upgrade ne réactive pas', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P2');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 3);
      const ctx = makeWriteCtx(db, stmts);
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_set_enabled',
        channel_id: ids[1],
        enabled: false,
      });
      let dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.deepEqual(dest.map((d) => d.channel_id), [ids[0], ids[2]]);

      // noop disable déjà disabled
      const noop = await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_set_enabled',
        channel_id: ids[1],
        enabled: false,
      });
      assert.equal(noop.noop, true);

      // downgrade FREE puis upgrade P2
      expireAllGrants(db, GUILD);
      grantPlan(db, stmts, GUILD, 'P2', Date.now() + 99);
      clearEntitlementCache();
      dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.ok(!dest.some((d) => d.channel_id === ids[1]));
    });
  });
});

describe('Phase 2 — downgrade / upgrade', () => {
  it('P3 8 → P1 : 2 actifs / 6 paused, aucun DELETE', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P3');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 8);
      expireAllGrants(db, GUILD);
      grantPlan(db, stmts, GUILD, 'P1', Date.now() + 1);
      clearEntitlementCache();

      const cfg = fetchGuildConfig(db, GUILD, { stmts });
      assert.equal(cfg.reception_channel_usage.configured, 8);
      assert.equal(cfg.reception_channel_usage.active, 2);
      assert.equal(cfg.reception_channel_usage.limit, 2);
      assert.equal(cfg.reception_channels.filter((c) => c.paused_reason === 'PLAN_LIMIT').length, 6);
      assert.deepEqual(
        cfg.reception_channels.filter((c) => c.effective_active).map((c) => c.channel_id),
        [ids[0], ids[1]],
      );
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM guild_game_channels WHERE guild_id = ?`).get(GUILD).n,
        8,
      );
    });
  });

  it('P2 4 → FREE : 1 actif / 3 paused', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P2');
      clearEntitlementCache();
      seedChannels(db, GUILD, 4);
      expireAllGrants(db, GUILD);
      const cfg = fetchGuildConfig(db, GUILD, { stmts });
      assert.equal(cfg.reception_channel_usage.active, 1);
      assert.equal(cfg.reception_channel_usage.limit, 1);
      assert.equal(cfg.reception_channels.filter((c) => c.paused_reason === 'PLAN_LIMIT').length, 3);
    });
  });

  it('P3 8 → P1 → P3 : 8 actifs à nouveau', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P3');
      clearEntitlementCache();
      seedChannels(db, GUILD, 8);
      expireAllGrants(db, GUILD);
      grantPlan(db, stmts, GUILD, 'P1', Date.now() + 1);
      clearEntitlementCache();
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
          .filter((d) => d.guild_id === GUILD).length,
        2,
      );
      expireAllGrants(db, GUILD);
      grantPlan(db, stmts, GUILD, 'P3', Date.now() + 2);
      clearEntitlementCache();
      assert.equal(
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
          .filter((d) => d.guild_id === GUILD).length,
        8,
      );
    });
  });
});

describe('Phase 2 — multi-guild destinations (7 messages)', () => {
  it('FREE1 + P1 2 + P2 4 = 7 destinations distinctes', async () => {
    await withTempDb(async (db, stmts) => {
      seedChannels(db, GUILD, 1, { startN: 1 });
      grantPlan(db, stmts, GUILD_B, 'P1');
      seedChannels(db, GUILD_B, 2, { startN: 10 });
      grantPlan(db, stmts, GUILD_C, 'P2');
      seedChannels(db, GUILD_C, 4, { startN: 20 });
      clearEntitlementCache();

      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY);
      assert.equal(dest.length, 7);
      const keys = new Set(dest.map((d) => `${d.guild_id}:${d.channel_id}`));
      assert.equal(keys.size, 7);
    });
  });
});

describe('Phase 2 — security / fuzz', () => {
  it('refuse channel_id invalides', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ctx = makeWriteCtx(db, stmts);
      for (const bad of ['', 'abc', '1', 'x'.repeat(40)]) {
        await assert.rejects(
          () => applyGuildConfigSectionWrite(ctx, {
            section: 'reception_channels_add',
            channel_id: bad,
          }),
          (e) => e instanceof ConfigWriteError,
        );
      }
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_add',
          channel_id: null,
        }),
        (e) => e.code === 'VALIDATION_ERROR',
      );
    });
  });

  it('ignore mass assignment effective_active / limit injectés', async () => {
    await withTempDb(async (db, stmts) => {
      const channels = new Map([
        [ch(1), makeTextChannel(ch(1))],
        [ch(2), makeTextChannel(ch(2))],
      ]);
      const ctx = makeWriteCtx(db, stmts, channels);
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channels_add',
        channel_id: ch(1),
        limit: 999,
        effective_active: true,
        paused_reason: null,
      });
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_add',
          channel_id: ch(2),
          limit: 999,
        }),
        (e) => e.code === 'RECEPTION_CHANNEL_LIMIT_REACHED',
      );
    });
  });

  it('set_enabled refuse non-boolean', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      const ids = seedChannels(db, GUILD, 1);
      const ctx = makeWriteCtx(db, stmts);
      await assert.rejects(
        () => applyGuildConfigSectionWrite(ctx, {
          section: 'reception_channels_set_enabled',
          channel_id: ids[0],
          enabled: 1,
        }),
        (e) => e.code === 'VALIDATION_ERROR',
      );
    });
  });
});

describe('Phase 2 — concurrence quota race-safe', () => {
  it('2 add simultanés sur dernier slot P1 => max 2 rows', async () => {
    await withTempDb(async (db, stmts, dir) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      seedChannels(db, GUILD, 1, { startN: 1 });

      // Deux connexions SQLite sur le même fichier
      const Database = (await import('better-sqlite3')).default;
      const dbPath = path.join(dir, 'test.db');
      const db2 = new Database(dbPath);
      try {
        db2.pragma('journal_mode = WAL');
        db2.pragma('busy_timeout = 5000');
        const stmts2 = prepareStatements(db2);

        const cA = ch(2);
        const cB = ch(3);

        const runAdd = (database, statements, channelId) => {
          const limit = getLimit(GUILD, 'reception_channels', { stmts: statements, bypassCache: true });
          const tx = database.transaction(() => {
            const countRow = statements.countConfiguredChannelsByGuildGame.get(
              GUILD,
              UI_PRIMARY_GAME_KEY,
            );
            if (Number(countRow?.n ?? 0) >= limit) {
              throw new ConfigWriteError(403, 'RECEPTION_CHANNEL_LIMIT_REACHED');
            }
            const maxSort = statements.maxSortOrderByGuildGame.get(GUILD, UI_PRIMARY_GAME_KEY);
            statements.insertReceptionChannelAtOrder.run({
              guild_id: GUILD,
              channel_id: channelId,
              game_key: UI_PRIMARY_GAME_KEY,
              enabled: 1,
              sort_order: Number(maxSort?.max_sort ?? -1) + 1,
              created_at: Date.now(),
            });
          });
          tx();
        };

        let ok = 0;
        let denied = 0;
        const results = await Promise.allSettled([
          Promise.resolve().then(() => {
            runAdd(db, stmts, cA);
            ok += 1;
          }),
          Promise.resolve().then(() => {
            runAdd(db2, stmts2, cB);
            ok += 1;
          }),
        ]);

        for (const r of results) {
          if (r.status === 'rejected') {
            denied += 1;
            assert.ok(
              r.reason instanceof ConfigWriteError
                && r.reason.code === 'RECEPTION_CHANNEL_LIMIT_REACHED',
            );
          }
        }

        const n = db.prepare(
          `SELECT COUNT(*) AS n FROM guild_game_channels WHERE guild_id = ?`,
        ).get(GUILD).n;
        assert.ok(n <= 2, `expected <=2 rows, got ${n}`);
        assert.ok(ok >= 1);
        assert.ok(denied + ok === 2);
      } finally {
        db2.close();
      }
    });
  });
});

describe('Phase 2 — performance discovery 100 guilds', () => {
  it('destination discovery ~1000 max sans N+1 visible (cache entitlement)', async () => {
    await withTempDb(async (db, stmts) => {
      // 50 FREE (1) + 30 P1 (2) + 15 P2 (4) + 5 P3 (10) = 50+60+60+50 = 220 dest
      for (let i = 0; i < 50; i++) {
        const g = String(200000000000000000n + BigInt(i));
        seedChannels(db, g, 1, { startN: 1000 + i * 20 });
      }
      for (let i = 0; i < 30; i++) {
        const g = String(210000000000000000n + BigInt(i));
        grantPlan(db, stmts, g, 'P1', Date.now() + i);
        seedChannels(db, g, 2, { startN: 2000 + i * 20 });
      }
      for (let i = 0; i < 15; i++) {
        const g = String(220000000000000000n + BigInt(i));
        grantPlan(db, stmts, g, 'P2', Date.now() + i);
        seedChannels(db, g, 4, { startN: 3000 + i * 20 });
      }
      for (let i = 0; i < 5; i++) {
        const g = String(230000000000000000n + BigInt(i));
        grantPlan(db, stmts, g, 'P3', Date.now() + i);
        seedChannels(db, g, 10, { startN: 4000 + i * 20 });
      }
      clearEntitlementCache();

      const t0 = Date.now();
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY);
      const elapsed = Date.now() - t0;
      assert.equal(dest.length, 50 + 60 + 60 + 50);
      assert.ok(elapsed < 5000, `discovery trop lente: ${elapsed}ms`);
    });
  });
});

describe('Phase 2 — FREE legacy replace + read safety', () => {
  it('FREE reception_channel replace change le salon unique', async () => {
    await withTempDb(async (db, stmts) => {
      const channels = new Map([
        [ch(1), makeTextChannel(ch(1))],
        [ch(2), makeTextChannel(ch(2))],
      ]);
      const ctx = makeWriteCtx(db, stmts, channels);
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channel',
        channel_id: ch(1),
      });
      await applyGuildConfigSectionWrite(ctx, {
        section: 'reception_channel',
        channel_id: ch(2),
      });
      const rows = db.prepare(
        `SELECT channel_id FROM guild_game_channels WHERE guild_id = ?`,
      ).all(GUILD);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].channel_id, ch(2));
    });
  });

  it('bug DB 20 rows P1 → read n utilise que 2', async () => {
    await withTempDb(async (db, stmts) => {
      grantPlan(db, stmts, GUILD, 'P1');
      clearEntitlementCache();
      seedChannels(db, GUILD, 20);
      const dest = listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY)
        .filter((d) => d.guild_id === GUILD);
      assert.equal(dest.length, 2);
      assert.equal(applyReceptionChannelLimit(GUILD, dest, { stmts }).length, 2);
    });
  });
});

describe('Phase 2 — alias listEffective', () => {
  it('alias identique à listActive', async () => {
    await withTempDb(async (db, stmts) => {
      seedChannels(db, GUILD, 1);
      assert.deepEqual(
        listEffectiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY),
        listActiveReceptionDestinationsForGame(stmts, UI_PRIMARY_GAME_KEY),
      );
    });
  });
});
