/**
 * Phase 6 — Personnalisation locale embeds, presets, preview.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { listAppliedSchemaMigrations } from '../src/database/schemaMigrations.js';
import { fetchGuildConfig } from '../src/internalHttp/configQueries.js';
import {
  closeInternalHttpServer,
  createInternalHttpServer,
  listenInternalHttpServer,
} from '../src/internalHttp/server.js';
import {
  bindEntitlementStore,
  canUseFeature,
  clearEntitlementCache,
} from '../src/services/entitlements/index.js';
import { insertEntitlementGrant } from '../src/services/entitlements/entitlementStore.js';
import { applyGuildConfigSectionWrite } from '../src/services/guildConfigWrites.js';
import { ConfigWriteError } from '../src/services/configWriteError.js';
import {
  normalizeOptionalEmbedColor,
  normalizeOptionalEmbedEmoji,
  embedColorHexToInt,
} from '../src/services/embedCustomizationValidation.js';
import {
  applyEmbedPreset,
  createEmbedPreset,
  deleteEmbedPreset,
  getEmbedCustomization,
  upsertEmbedCustomization,
} from '../src/services/embedCustomizationStore.js';
import {
  resolveDestinationEmbedOptions,
  resolveEffectiveEmbedStyle,
} from '../src/services/embedCustomizationResolver.js';
import {
  buildGuildEmbedPreview,
  buildSampleScrimEmbedPayload,
} from '../src/services/embedPreview.js';
import {
  buildScrimClosedMessageEditOptions,
  buildScrimEmbed,
  SCRIM_EMBED_COLOR_ACTIVE,
  SCRIM_EMBED_COLOR_CLOSED_MANUAL,
} from '../src/services/scrimEmbedBuilder.js';
import { stopDashboardRefreshJob } from '../src/services/networkDashboard.js';
import { makeAuthzClient } from './helpers/internalHttpAuthzMock.js';

const GUILD_A = '1484520688726311012';
const GUILD_B = '1484520688726311013';
const GUILD_C = '1484520688726311014';
const ADMIN = '1009269632693174422';

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-p6-embed-'));
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

function grant(db, stmts, guildId, planKey, nowMs = Date.now()) {
  return insertEntitlementGrant({
    db,
    stmts,
    guildId,
    planKey,
    source: 'gift',
    startsAt: nowMs - 1000,
    endsAt: nowMs + 86_400_000,
    grantedBy: ADMIN,
    reason: 'phase6',
    idempotencyKey: `p6-${guildId}-${planKey}-${nowMs}-${Math.random()}`,
    nowMs,
  });
}

function mockCtx(db, stmts, guildId) {
  return {
    client: {},
    guild: { id: guildId, name: 'G' },
    db,
    stmts,
    guildId,
    actorDiscordUserId: ADMIN,
  };
}

describe('Phase 6 — validation couleur/emoji', () => {
  it('accepte #RRGGBB et refuse shorthand / http / alpha', () => {
    assert.equal(normalizeOptionalEmbedColor('#ff00aa'), '#FF00AA');
    assert.equal(embedColorHexToInt('#FF00AA'), 0xff00aa);
    assert.throws(() => normalizeOptionalEmbedColor('#FFF'), (e) => e.code === 'INVALID_EMBED_COLOR');
    assert.throws(() => normalizeOptionalEmbedColor('red'), (e) => e.code === 'INVALID_EMBED_COLOR');
  });

  it('emoji Unicode OK ; @everyone / mentions / ASCII refusés', () => {
    assert.equal(normalizeOptionalEmbedEmoji('🔥'), '🔥');
    assert.throws(() => normalizeOptionalEmbedEmoji('@everyone'), (e) => e.code === 'INVALID_EMOJI');
    assert.throws(() => normalizeOptionalEmbedEmoji('<@123>'), (e) => e.code === 'INVALID_EMOJI');
    assert.throws(() => normalizeOptionalEmbedEmoji('fire'), (e) => e.code === 'INVALID_EMOJI');
  });
});

describe('Phase 6 — entitlement gates + downgrade', () => {
  it('FREE/P1 ignore stored ; P2 effective ; downgrade conserve', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      upsertEmbedCustomization(db, GUILD_A, {
        color_hex: '#FF0000',
        emoji: '🔥',
        active_preset_id: null,
      }, t0);

      clearEntitlementCache();
      assert.equal(canUseFeature(GUILD_A, 'local_embed_customization', { stmts, nowMs: t0 }), false);
      let style = resolveEffectiveEmbedStyle(db, GUILD_A, { stmts, nowMs: t0 });
      assert.equal(style.colorHex, null);
      assert.equal(style.emoji, null);

      grant(db, stmts, GUILD_A, 'P1', t0);
      clearEntitlementCache();
      assert.equal(canUseFeature(GUILD_A, 'local_embed_customization', { stmts, nowMs: t0 }), false);

      grant(db, stmts, GUILD_A, 'P2', t0);
      clearEntitlementCache();
      assert.equal(canUseFeature(GUILD_A, 'local_embed_customization', { stmts, nowMs: t0 }), true);
      assert.equal(canUseFeature(GUILD_A, 'embed_presets', { stmts, nowMs: t0 }), true);
      assert.equal(canUseFeature(GUILD_A, 'live_preview', { stmts, nowMs: t0 }), true);
      style = resolveEffectiveEmbedStyle(db, GUILD_A, { stmts, nowMs: t0 });
      assert.equal(style.colorHex, '#FF0000');
      assert.equal(style.emoji, '🔥');

      // expire P2
      const tExp = t0 + 86_400_000 + 1;
      clearEntitlementCache();
      style = resolveEffectiveEmbedStyle(db, GUILD_A, { stmts, nowMs: tExp });
      assert.equal(style.colorHex, null);
      assert.ok(getEmbedCustomization(db, GUILD_A)?.color_hex === '#FF0000');
    });
  });
});

describe('Phase 6 — cross-guild isolation + lifecycle colors', () => {
  it('A rouge / B bleu / C default ; close conserve styles', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grant(db, stmts, GUILD_A, 'P2', t0);
      grant(db, stmts, GUILD_B, 'P3', t0);
      clearEntitlementCache();
      upsertEmbedCustomization(db, GUILD_A, {
        color_hex: '#FF0000',
        emoji: '🔥',
        active_preset_id: null,
      }, t0);
      upsertEmbedCustomization(db, GUILD_B, {
        color_hex: '#0000FF',
        emoji: '💧',
        active_preset_id: null,
      }, t0);

      const sample = buildSampleScrimEmbedPayload();
      const aOpts = resolveDestinationEmbedOptions({
        db, guildId: GUILD_A, stmts, nowMs: t0, status: 'active',
      });
      const bOpts = resolveDestinationEmbedOptions({
        db, guildId: GUILD_B, stmts, nowMs: t0, status: 'active',
      });
      const cOpts = resolveDestinationEmbedOptions({
        db, guildId: GUILD_C, stmts, nowMs: t0, status: 'active',
      });

      const embedA = buildScrimEmbed(sample, 'fr', {
        color: aOpts.colorInt,
        emojiPrefix: aOpts.emojiPrefix,
      });
      const embedB = buildScrimEmbed(sample, 'fr', {
        color: bOpts.colorInt,
        emojiPrefix: bOpts.emojiPrefix,
      });
      const embedC = buildScrimEmbed(sample, 'fr', {
        color: cOpts.colorInt,
        emojiPrefix: cOpts.emojiPrefix,
      });

      assert.equal(embedA.data.color, 0xff0000);
      assert.equal(embedB.data.color, 0x0000ff);
      assert.equal(embedC.data.color, SCRIM_EMBED_COLOR_ACTIVE);
      assert.ok(String(embedA.data.description).startsWith('🔥'));
      assert.ok(String(embedB.data.description).startsWith('💧'));
      assert.ok(!String(embedC.data.description).startsWith('🔥'));

      // payload global immutable
      assert.equal(sample.rank, 'Or');

      const closeA = buildScrimClosedMessageEditOptions(
        'closed_manual',
        {
          game_key: 'league_of_legends',
          rank_key: 'Or',
          scheduled_date: '01/01/2026',
          scheduled_time: '21:00',
          format_key: 'BO1',
          contact_user_id: '1',
          tags: '[]',
        },
        'fr',
        { color: aOpts.colorInt, emojiPrefix: aOpts.emojiPrefix },
      );
      const closeC = buildScrimClosedMessageEditOptions(
        'closed_manual',
        {
          game_key: 'league_of_legends',
          rank_key: 'Or',
          scheduled_date: '01/01/2026',
          scheduled_time: '21:00',
          format_key: 'BO1',
          contact_user_id: '1',
          tags: '[]',
        },
        'fr',
        { color: cOpts.colorInt, emojiPrefix: cOpts.emojiPrefix },
      );
      assert.equal(closeA.embeds[0].data.color, 0xff0000);
      assert.equal(closeC.embeds[0].data.color, SCRIM_EMBED_COLOR_CLOSED_MANUAL);
    });
  });
});

describe('Phase 6 — presets CRUD + IDOR', () => {
  it('create/apply/delete + cross-guild impossible', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grant(db, stmts, GUILD_A, 'P2', t0);
      grant(db, stmts, GUILD_B, 'P2', t0);
      clearEntitlementCache();

      const p = createEmbedPreset(db, GUILD_A, {
        name: 'Rouge',
        color_hex: '#FF0000',
        emoji: '🔥',
      }, t0);
      applyEmbedPreset(db, GUILD_A, p.id, t0);
      assert.equal(getEmbedCustomization(db, GUILD_A)?.active_preset_id, p.id);

      assert.equal(getEmbedCustomization(db, GUILD_B), null);

      // B cannot apply A's preset id
      assert.throws(
        () => applyEmbedPreset(db, GUILD_B, p.id),
        (e) => e instanceof ConfigWriteError && e.code === 'PRESET_NOT_FOUND',
      );

      deleteEmbedPreset(db, GUILD_A, p.id);
      assert.equal(getEmbedCustomization(db, GUILD_A)?.active_preset_id, null);
    });
  });

  it('FREE write customization → FEATURE_NOT_AVAILABLE', async () => {
    await withTempDb(async (db, stmts) => {
      clearEntitlementCache();
      await assert.rejects(
        () =>
          applyGuildConfigSectionWrite(mockCtx(db, stmts, GUILD_A), {
            section: 'embed_customization',
            color_hex: '#FF0000',
            emoji: null,
          }),
        (e) => e.code === 'FEATURE_NOT_AVAILABLE',
      );
    });
  });
});

describe('Phase 6 — preview no-write + fidelity', () => {
  it('preview utilise le même builder et ne mute pas DB', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grant(db, stmts, GUILD_A, 'P2', t0);
      clearEntitlementCache();
      const before = listAppliedSchemaMigrations(db);
      const preview = buildGuildEmbedPreview(db, GUILD_A, {
        color_hex: '#00FF00',
        emoji: '🔥',
        stmts,
        nowMs: t0,
      });
      assert.equal(preview.color_hex, '#00FF00');
      assert.equal(preview.embed.color, 0x00ff00);
      assert.ok(String(preview.embed.description).startsWith('🔥'));
      assert.equal(getEmbedCustomization(db, GUILD_A), null);
      assert.deepEqual(listAppliedSchemaMigrations(db), before);

      const prod = buildScrimEmbed(buildSampleScrimEmbedPayload(), 'fr', {
        color: 0x00ff00,
        emojiPrefix: '🔥',
      });
      assert.equal(prod.data.color, preview.embed.color);
      assert.equal(prod.data.description, preview.embed.description);
    });
  });

  it('invalid style → fallback validation (couleur invalide rejetée)', async () => {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grant(db, stmts, GUILD_A, 'P2', t0);
      clearEntitlementCache();
      assert.throws(
        () => buildGuildEmbedPreview(db, GUILD_A, {
          color_hex: 'not-a-color',
          stmts,
          nowMs: t0,
        }),
        (e) => e instanceof ConfigWriteError && e.status === 400,
      );
    });
  });
});

describe('Phase 6 — HTTP embed-preview authz', () => {
  const TOKEN = 'test-embed-preview-token';

  async function withPreviewServer(clientOpts, fn) {
    await withTempDb(async (db, stmts) => {
      const t0 = Date.now();
      grant(db, stmts, GUILD_A, 'P2', t0);
      clearEntitlementCache();
      const client = makeAuthzClient(GUILD_A, ADMIN, clientOpts);
      const { server, listener, host } = createInternalHttpServer({
        db,
        client,
        stmts,
        config: { enabled: true, port: 0, token: TOKEN },
        port: 0,
      });
      const bound = await listenInternalHttpServer(server, host, 0);
      try {
        await fn({ port: bound.port, db, stmts, t0 });
      } finally {
        if (listener?.stopAccepting) listener.stopAccepting();
        await closeInternalHttpServer(server);
      }
    });
  }

  function postPreview(port, guildId, body) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/internal/guilds/${guildId}/embed-preview`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  it('Administrator → preview OK', async () => {
    await withPreviewServer({ manageGuild: false, administrator: true }, async ({ port }) => {
      const res = await postPreview(port, GUILD_A, {
        actor_discord_user_id: ADMIN,
        color_hex: '#112233',
        source: 'web',
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.embed);
    });
  });

  it('ManageGuild only → denied', async () => {
    await withPreviewServer({ manageGuild: true, administrator: false }, async ({ port }) => {
      const res = await postPreview(port, GUILD_A, {
        actor_discord_user_id: ADMIN,
        color_hex: '#112233',
        source: 'web',
      });
      assert.equal(res.status, 403);
    });
  });

  it('member → denied', async () => {
    await withPreviewServer({ manageGuild: false, administrator: false }, async ({ port }) => {
      const res = await postPreview(port, GUILD_A, {
        actor_discord_user_id: ADMIN,
        color_hex: '#112233',
        source: 'web',
      });
      assert.equal(res.status, 403);
    });
  });

  it('Guild A actor → Guild B → denied', async () => {
    await withPreviewServer({ manageGuild: false, administrator: true }, async ({ port }) => {
      const res = await postPreview(port, GUILD_B, {
        actor_discord_user_id: ADMIN,
        color_hex: '#112233',
        source: 'web',
      });
      // 403 not member / 409 guild unreachable — jamais 200
      assert.ok([403, 409].includes(res.status), `status=${res.status}`);
    });
  });

  it('preview HTTP → no DB write', async () => {
    await withPreviewServer({ manageGuild: false, administrator: true }, async ({ port, db }) => {
      assert.equal(getEmbedCustomization(db, GUILD_A), null);
      const res = await postPreview(port, GUILD_A, {
        actor_discord_user_id: ADMIN,
        color_hex: '#AABBCC',
        emoji: '✨',
        source: 'web',
      });
      assert.equal(res.status, 200);
      assert.equal(getEmbedCustomization(db, GUILD_A), null);
    });
  });
});

describe('Phase 6 — migration + dashboard view', () => {
  it('migration present + config expose embed_customization', async () => {
    await withTempDb(async (db, stmts) => {
      const applied = listAppliedSchemaMigrations(db);
      assert.ok(applied.includes('20260923_05_guild_embed_customization'));
      const cfg = fetchGuildConfig(db, GUILD_A, { stmts });
      assert.ok(cfg.embed_customization);
      assert.equal(cfg.embed_customization.feature_available, false);
      assert.ok(Array.isArray(cfg.embed_customization.presets));
    });
  });
});
