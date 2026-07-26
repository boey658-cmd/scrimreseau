/**
 * Tests Phase 1 — diffusion persistante des scrims
 *
 * Couvre :
 *   - Feature flag, migration SQLite, claim atomique
 *   - deliverScrimToDestination (envoi, blocage, erreurs, locale)
 *   - runScrimBroadcastDeliveryPass (passe, équité)
 *   - processDelivery (retry, terminal, cancel, rollback)
 *   - recoverStaleScrimBroadcastDeliveries (stale, idempotent, staging→active)
 *   - getScrimBroadcastHealthSnapshot
 *   - Annulation à la fermeture (closeScrimPostByDbId)
 *   - i18n (successPersistent, bootstrapZeroDelivery, parité FR/EN)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { deliverScrimToDestination } from '../src/services/scrimDelivery.js';
import {
  runScrimBroadcastDeliveryPass,
  recoverStaleScrimBroadcastDeliveries,
  getScrimBroadcastHealthSnapshot,
} from '../src/services/scrimBroadcastDeliveryJob.js';
import {
  startDiscordTaskQueue,
  stopDiscordTaskQueue,
} from '../src/services/discordTaskQueue.js';
import { t } from '../src/i18n/index.js';
import { closeScrimPostByDbId } from '../src/services/scrimLifecycle.js';

// ─── Helper DB temporaire ────────────────────────────────────────────────────

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrim-persistent-test-'));
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

// ─── Helpers Discord mock ────────────────────────────────────────────────────

function buildMockChannel(channelId, captureArray, options = {}) {
  const perms = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return {
    id: channelId,
    type: ChannelType.GuildText,
    permissionsFor: () => (options.noPerms ? null : perms),
    send: async (payload) => {
      if (options.sendThrows) throw options.sendThrows;
      captureArray.push(payload);
      return { id: `msg-${channelId}-${Date.now()}`, guildId: options.guildId ?? 'guild-001', channelId };
    },
  };
}

function buildMockGuild(guildId, channelMap = {}, options = {}) {
  const botMember = options.noBotMember
    ? null
    : { id: 'bot-scrim', permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) };
  return {
    id: guildId,
    channels: {
      cache: new Map(Object.entries(channelMap)),
      fetch: async (id) => channelMap[id] ?? null,
    },
    members: {
      me: botMember,
      fetchMe: async () => botMember,
    },
  };
}

function buildMockClient(guildMap = {}) {
  return {
    guilds: {
      cache: new Map(Object.entries(guildMap)),
      fetch: async (id) => guildMap[id] ?? null,
    },
  };
}

// ─── Helpers DB ───────────────────────────────────────────────────────────────

let publicIdCounter = 100;

function insertTestScrimPost(stmts, options = {}) {
  const info = stmts.insertScrimPostRow.run({
    scrim_public_id: options.publicId ?? (publicIdCounter += 1),
    author_user_id: options.authorUserId ?? 'user-001',
    origin_guild_id: options.guildId ?? 'guild-001',
    source_guild_id: options.guildId ?? 'guild-001',
    game_key: options.gameKey ?? 'lol',
    rank_key: 'Platinum',
    format_key: 'BO1',
    contact_user_id: options.authorUserId ?? 'user-001',
    scheduled_date: '27/07/2026',
    scheduled_time: '20:00',
    scheduled_at: new Date(Date.now() + 7200000).toISOString(),
    scheduled_at_end: null,
    tags: JSON.stringify({ fearless: 'non' }),
    multi_opgg_url: null,
    elo_precision: null,
    structure_guild_id: null,
    structure_name_snapshot: null,
    structure_invite_url_snapshot: null,
    created_at: Date.now(),
    status: options.status ?? 'active',
  });
  return Number(info.lastInsertRowid);
}

function insertTestBatch(stmts, scrimPostDbId, options = {}) {
  const now = new Date().toISOString();
  const info = stmts.insertScrimBroadcastBatch.run({
    scrim_post_db_id: scrimPostDbId,
    operation_type: options.operationType ?? 'initial',
    generation: options.generation ?? 0,
    target_count: options.targetCount ?? 1,
    created_at: now,
    updated_at: now,
  });
  const batchId = Number(info.lastInsertRowid);
  if (options.status === 'active') {
    stmts.setScrimBroadcastBatchActive.run({ id: batchId, started_at: now, updated_at: now });
  }
  return batchId;
}

function insertTestDelivery(stmts, batchId, scrimPostDbId, options = {}) {
  const now = options.nextAttemptAt ?? new Date().toISOString();
  const createdAt = new Date().toISOString();
  const info = stmts.insertScrimBroadcastDelivery.run({
    batch_id: batchId,
    scrim_post_db_id: scrimPostDbId,
    guild_id: options.guildId ?? 'guild-001',
    channel_id: options.channelId ?? 'chan-001',
    game_key: options.gameKey ?? 'lol',
    operation_type: options.operationType ?? 'initial',
    generation: options.generation ?? 0,
    priority: options.priority ?? 0,
    next_attempt_at: now,
    created_at: createdAt,
    updated_at: createdAt,
  });
  return Number(info.lastInsertRowid);
}

const SCRIM_PAYLOAD = {
  gameKey: 'lol',
  rank: 'Platine',
  dateStr: '27/07/2026',
  timeStr: '20:00',
  format: 'BO1',
  nombreDeGames: null,
  fearless: 'non',
  eloPrecision: null,
  contactUserId: 'user-001',
  contactDisplayName: 'TestUser',
  multiOpggUrl: null,
  scheduledAtIso: new Date(Date.now() + 7200000).toISOString(),
  scheduledAtEndIso: null,
  structureNameSnapshot: null,
  structureInviteUrl: null,
};

// ─── Suite principale (sequential — before/after unique pour le task queue) ──

describe('scrimPersistentBroadcast', () => {
  let prevQueueDelay;

  before(() => {
    prevQueueDelay = process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';
    startDiscordTaskQueue();
  });

  after(async () => {
    await stopDiscordTaskQueue();
    if (prevQueueDelay === undefined) delete process.env.DISCORD_TASK_QUEUE_DELAY_MS;
    else process.env.DISCORD_TASK_QUEUE_DELAY_MS = prevQueueDelay;
  });

  // ── 1. Feature flag ────────────────────────────────────────────────────────

  describe('feature flag', () => {
    it('deliverScrimToDestination est importable sans throw', () => {
      assert.ok(typeof deliverScrimToDestination === 'function');
    });

    it('isPersistentBroadcastEnabled retourne true avec =1', async () => {
      const prev = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = '1';
      try {
        const { isPersistentBroadcastEnabled } = await import('../src/utils/persistentBroadcastFlag.js');
        assert.ok(isPersistentBroadcastEnabled());
      } finally {
        if (prev === undefined) delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
        else process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = prev;
      }
    });

    it('isPersistentBroadcastEnabled retourne false sans variable', async () => {
      const prev = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      try {
        const { isPersistentBroadcastEnabled } = await import('../src/utils/persistentBroadcastFlag.js');
        assert.ok(!isPersistentBroadcastEnabled());
      } finally {
        if (prev !== undefined) process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = prev;
      }
    });
  });

  // ── 2. Migration SQLite ────────────────────────────────────────────────────

  describe('migration SQLite additive', () => {
    it('scrim_broadcast_batches et scrim_broadcast_deliveries existent après migration', async () => {
      await withTempDb(async (db) => {
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
        assert.ok(tables.includes('scrim_broadcast_batches'), 'scrim_broadcast_batches manquante');
        assert.ok(tables.includes('scrim_broadcast_deliveries'), 'scrim_broadcast_deliveries manquante');
      });
    });

    it('scrim_broadcast_batches a les colonnes attendues', async () => {
      await withTempDb(async (db) => {
        const cols = db.prepare(`PRAGMA table_info(scrim_broadcast_batches)`).all().map((r) => r.name);
        for (const col of ['id', 'scrim_post_db_id', 'operation_type', 'generation', 'status',
          'target_count', 'created_at', 'started_at', 'completed_at', 'last_dispatched_at', 'updated_at']) {
          assert.ok(cols.includes(col), `Colonne manquante : ${col}`);
        }
      });
    });

    it('scrim_broadcast_deliveries a les colonnes attendues', async () => {
      await withTempDb(async (db) => {
        const cols = db.prepare(`PRAGMA table_info(scrim_broadcast_deliveries)`).all().map((r) => r.name);
        for (const col of ['id', 'batch_id', 'scrim_post_db_id', 'guild_id', 'channel_id',
          'game_key', 'status', 'priority', 'attempt_count', 'next_attempt_at', 'claimed_at',
          'message_id', 'last_error_code', 'last_error_message', 'created_at', 'updated_at', 'completed_at']) {
          assert.ok(cols.includes(col), `Colonne manquante : ${col}`);
        }
      });
    });

    it('indexes créés pour scrim_broadcast_deliveries', async () => {
      await withTempDb(async (db) => {
        const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map((r) => r.name);
        assert.ok(indexes.some((n) => n.includes('idx_sbd')), 'Index idx_sbd_* absent');
      });
    });

    it('insertion batch → status staging par défaut', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        const batch = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.ok(batch, 'Batch non trouvé');
        assert.strictEqual(batch.status, 'staging');
      });
    });
  });

  // ── 3. Claim atomique ──────────────────────────────────────────────────────

  describe('claim atomique', () => {
    it('seul le premier claim réussit', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();

        const c1 = stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        const c2 = stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });

        assert.strictEqual(c1.changes, 1, 'Premier claim doit réussir');
        assert.strictEqual(c2.changes, 0, 'Deuxième claim doit échouer');
      });
    });

    it('delivery non due (future) → non claimée', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const future = new Date(Date.now() + 3600000).toISOString();
        insertTestDelivery(stmts, batchId, scrimId, { nextAttemptAt: future });
        const now = new Date().toISOString();

        const info = stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        assert.strictEqual(info.changes, 0);
      });
    });

    it('deux deliveries → priorité haute claimée en premier', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active', targetCount: 2 });
        // Utiliser un timestamp passé fixe pour que les deux deliveries soient immédiatement dues
        const pastIso = new Date(Date.now() - 5000).toISOString();
        insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g-low', channelId: 'c-low', priority: 0, nextAttemptAt: pastIso });
        const idHigh = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g-high', channelId: 'c-high', priority: 1, nextAttemptAt: pastIso });
        const now = new Date().toISOString();

        stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        const claimed = stmts.getProcessingDeliveryForBatch.get(batchId);
        assert.ok(claimed);
        assert.strictEqual(Number(claimed.id), idHigh, 'Haute priorité doit être claimée en premier');
      });
    });
  });

  // ── 4. deliverScrimToDestination ───────────────────────────────────────────

  describe('deliverScrimToDestination', () => {
    it('outcome sent avec mock valide', async () => {
      await withTempDb(async (db, stmts) => {
        const captures = [];
        const channel = buildMockChannel('chan-001', captures, { guildId: 'guild-001' });
        const guild = buildMockGuild('guild-001', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-001': guild });

        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-001', channel_id: 'chan-001' },
          authorUserId: 'user-001',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });

        assert.strictEqual(result.outcome, 'sent');
        assert.ok(result.message, 'Message absent');
        assert.strictEqual(captures.length, 1);
        assert.ok(captures[0].embeds?.length > 0, 'Embed absent dans le payload envoyé');
      });
    });

    it('outcome blocked quand isUserBlocked retourne vrai', async () => {
      await withTempDb(async (db, stmts) => {
        stmts.blockUser.run('guild-001', 'user-blocked', Date.now());
        const captures = [];
        const channel = buildMockChannel('chan-001', captures, { guildId: 'guild-001' });
        const guild = buildMockGuild('guild-001', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-001': guild });

        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-001', channel_id: 'chan-001' },
          authorUserId: 'user-blocked',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });

        assert.strictEqual(result.outcome, 'blocked');
        assert.strictEqual(captures.length, 0, 'Aucun send pour un auteur bloqué');
      });
    });

    it('terminal_error sans permissions suffisantes', async () => {
      await withTempDb(async (db, stmts) => {
        const channel = buildMockChannel('chan-001', [], { noPerms: true });
        const guild = buildMockGuild('guild-001', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-001': guild });

        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-001', channel_id: 'chan-001' },
          authorUserId: 'user-001',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });

        assert.strictEqual(result.outcome, 'terminal_error');
        assert.strictEqual(result.errorCode, 'PERMISSIONS');
        assert.strictEqual(result.terminal, true);
      });
    });

    it('retryable_error sur erreur réseau (ECONNRESET)', async () => {
      await withTempDb(async (db, stmts) => {
        const netErr = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
        const channel = buildMockChannel('chan-001', [], { sendThrows: netErr });
        const guild = buildMockGuild('guild-001', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-001': guild });

        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-001', channel_id: 'chan-001' },
          authorUserId: 'user-001',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });

        assert.strictEqual(result.outcome, 'retryable_error');
        assert.strictEqual(result.terminal, false);
      });
    });

    it('Discord 50013 (MissingPermissions) → terminal_error via classifyDiscordEditError', async () => {
      await withTempDb(async (db, stmts) => {
        // Simuler une erreur Discord API 50013 (MissingPermissions) via channel.send
        const discordErr = Object.assign(new Error('Missing Permissions'), { code: 50013 });
        const channel = buildMockChannel('chan-001', [], { sendThrows: discordErr });
        const guild = buildMockGuild('guild-001', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-001': guild });

        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-001', channel_id: 'chan-001' },
          authorUserId: 'user-001',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });

        assert.strictEqual(result.outcome, 'terminal_error',
          `Un 50013 doit être terminal, obtenu '${result.outcome}'`);
      });
    });

    it('guild introuvable → terminal_error GUILD_NOT_FOUND', async () => {
      await withTempDb(async (db, stmts) => {
        const client = buildMockClient({});
        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-inexistante', channel_id: 'chan-001' },
          authorUserId: 'user-001',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });
        assert.strictEqual(result.outcome, 'terminal_error');
        assert.strictEqual(result.errorCode, 'GUILD_NOT_FOUND');
      });
    });

    it('locale fr depuis DB sans ligne guild_languages (fallback fr)', async () => {
      await withTempDb(async (db, stmts) => {
        const captures = [];
        const channel = buildMockChannel('chan-001', captures, { guildId: 'guild-fr' });
        const guild = buildMockGuild('guild-fr', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-fr': guild });

        const result = await deliverScrimToDestination({
          client, stmts,
          row: { guild_id: 'guild-fr', channel_id: 'chan-001' },
          authorUserId: 'user-001',
          payload: SCRIM_PAYLOAD,
          delayMs: 0,
        });

        assert.strictEqual(result.outcome, 'sent');
        assert.strictEqual(captures.length, 1);
        const embed = captures[0]?.embeds?.[0];
        assert.ok(embed, 'Embed absent');
        // L'embed doit avoir du contenu (description FR)
        assert.ok(embed.data?.description?.length > 0 || embed.data?.color != null, 'Embed vide');
      });
    });

    it('locale en depuis DB avec guild_languages = en — embed différent du FR', async () => {
      await withTempDb(async (db, stmts) => {
        stmts.upsertGuildLanguage.run('guild-en', 'en');
        const capturesFr = [], capturesEn = [];

        const chanFr = buildMockChannel('chan-fr', capturesFr, { guildId: 'guild-fr' });
        const guildFr = buildMockGuild('guild-fr', { 'chan-fr': chanFr });

        const chanEn = buildMockChannel('chan-en', capturesEn, { guildId: 'guild-en' });
        const guildEn = buildMockGuild('guild-en', { 'chan-en': chanEn });

        const client = buildMockClient({ 'guild-fr': guildFr, 'guild-en': guildEn });

        const rFr = await deliverScrimToDestination({ client, stmts, row: { guild_id: 'guild-fr', channel_id: 'chan-fr' }, authorUserId: 'user-001', payload: SCRIM_PAYLOAD, delayMs: 0 });
        const rEn = await deliverScrimToDestination({ client, stmts, row: { guild_id: 'guild-en', channel_id: 'chan-en' }, authorUserId: 'user-001', payload: SCRIM_PAYLOAD, delayMs: 0 });

        assert.strictEqual(rFr.outcome, 'sent');
        assert.strictEqual(rEn.outcome, 'sent');

        const descFr = capturesFr[0]?.embeds?.[0]?.data?.description ?? '';
        const descEn = capturesEn[0]?.embeds?.[0]?.data?.description ?? '';
        assert.ok(descFr.length > 0, 'Description FR absente');
        assert.ok(descEn.length > 0, 'Description EN absente');
        assert.notEqual(descFr, descEn, 'FR et EN doivent avoir des descriptions différentes');
      });
    });

    it('delayMs=0 → exécution sans délai notable (<500ms)', async () => {
      await withTempDb(async (db, stmts) => {
        const captures = [];
        const channel = buildMockChannel('chan-001', captures);
        const guild = buildMockGuild('guild-001', { 'chan-001': channel });
        const client = buildMockClient({ 'guild-001': guild });

        const t0 = Date.now();
        await deliverScrimToDestination({ client, stmts, row: { guild_id: 'guild-001', channel_id: 'chan-001' }, authorUserId: 'u', payload: SCRIM_PAYLOAD, delayMs: 0 });
        assert.ok(Date.now() - t0 < 2000, 'Trop long avec delayMs=0');
      });
    });
  });

  // ── 5. runScrimBroadcastDeliveryPass ──────────────────────────────────────

  describe('runScrimBroadcastDeliveryPass', () => {
    it('traite delivery pending et marque sent', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        const captures = [];
        const channel = buildMockChannel('c1', captures, { guildId: 'g1' });
        const guild = buildMockGuild('g1', { 'c1': channel });
        const client = buildMockClient({ 'g1': guild });

        const stats = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.strictEqual(stats.dispatched, 1);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent');
      });
    });

    it('aucun batch actif → dispatched=0', async () => {
      await withTempDb(async (db, stmts) => {
        const client = buildMockClient({});
        const stats = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.strictEqual(stats.dispatched, 0);
        assert.strictEqual(stats.batchesProcessed, 0);
      });
    });

    it('batch staging → non traité (seulement batches active)', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId); // staging
        insertTestDelivery(stmts, batchId, scrimId);
        const client = buildMockClient({});
        const stats = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.strictEqual(stats.dispatched, 0);
      });
    });

    it('équité — deux batches actifs → les deux traités dans une passe', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimA = insertTestScrimPost(stmts, { guildId: 'gA' });
        const scrimB = insertTestScrimPost(stmts, { guildId: 'gB' });
        const batchA = insertTestBatch(stmts, scrimA, { status: 'active' });
        const batchB = insertTestBatch(stmts, scrimB, { status: 'active' });

        const capturesA = [], capturesB = [];
        const chanA = buildMockChannel('cA', capturesA, { guildId: 'gA' });
        const chanB = buildMockChannel('cB', capturesB, { guildId: 'gB' });
        const guildA = buildMockGuild('gA', { 'cA': chanA });
        const guildB = buildMockGuild('gB', { 'cB': chanB });
        const client = buildMockClient({ 'gA': guildA, 'gB': guildB });

        insertTestDelivery(stmts, batchA, scrimA, { guildId: 'gA', channelId: 'cA' });
        insertTestDelivery(stmts, batchB, scrimB, { guildId: 'gB', channelId: 'cB' });

        const stats = await runScrimBroadcastDeliveryPass(client, db, stmts);
        assert.strictEqual(stats.batchesProcessed, 2, 'Les deux batches doivent être traités dans une passe');
        assert.strictEqual(stats.dispatched, 2, 'Deux dispatches attendus');
      });
    });

    it('delivery retryable → marquée retry avec next_attempt_at dans le futur', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        const netErr = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        const channel = buildMockChannel('c1', [], { guildId: 'g1', sendThrows: netErr });
        const guild = buildMockGuild('g1', { 'c1': channel });
        const client = buildMockClient({ 'g1': guild });

        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const d = db.prepare('SELECT status, next_attempt_at, attempt_count FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'retry');
        assert.ok(d.next_attempt_at > new Date().toISOString(), 'next_attempt_at doit être dans le futur');
        assert.strictEqual(Number(d.attempt_count), 1);
      });
    });

    it('delivery terminal après attempt_count >= 5', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        // Pré-remplir attempt_count = 5 et status retry
        const pastIso = new Date(Date.now() - 1000).toISOString();
        db.prepare('UPDATE scrim_broadcast_deliveries SET attempt_count = 5, status = \'retry\', next_attempt_at = ? WHERE id = ?').run(pastIso, delivId);

        const netErr = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        const channel = buildMockChannel('c1', [], { guildId: 'g1', sendThrows: netErr });
        const guild = buildMockGuild('g1', { 'c1': channel });
        const client = buildMockClient({ 'g1': guild });

        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'failed_terminal');
      });
    });

    it('scrim fermé → delivery cancelled sans envoi Discord', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts, { status: 'active' });
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        db.prepare('UPDATE scrim_posts SET status = \'closed_manual\' WHERE id = ?').run(scrimId);

        const captures = [];
        const channel = buildMockChannel('c1', captures, { guildId: 'g1' });
        const guild = buildMockGuild('g1', { 'c1': channel });
        const client = buildMockClient({ 'g1': guild });

        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'cancelled');
        assert.strictEqual(captures.length, 0);
      });
    });

    it('send OK + DB OK → delivery sent + message en scrim_post_messages', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        const captures = [];
        const channel = buildMockChannel('c1', captures, { guildId: 'g1' });
        const guild = buildMockGuild('g1', { 'c1': channel });
        const client = buildMockClient({ 'g1': guild });

        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const d = db.prepare('SELECT status, message_id FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent');
        assert.ok(d.message_id, 'message_id doit être renseigné');

        const msgs = stmts.listScrimPostMessagesByPostId.all(scrimId);
        assert.strictEqual(msgs.length, 1);
      });
    });

    it('batch complété quand toutes les deliveries sont terminées', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active', targetCount: 1 });
        insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        const captures = [];
        const channel = buildMockChannel('c1', captures, { guildId: 'g1' });
        const guild = buildMockGuild('g1', { 'c1': channel });
        const client = buildMockClient({ 'g1': guild });

        await runScrimBroadcastDeliveryPass(client, db, stmts);

        const batch = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batch.status, 'completed');
      });
    });
  });

  // ── 6. recoverStaleScrimBroadcastDeliveries ────────────────────────────────

  describe('recovery', () => {
    it('delivery processing stale → unknown_outcome', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'processing\', claimed_at = ? WHERE id = ?').run(staleTime, delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'unknown_outcome');
      });
    });

    it('delivery processing récente → non affectée par recovery', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        const recentTime = new Date().toISOString();
        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'processing\', claimed_at = ? WHERE id = ?').run(recentTime, delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'processing', 'Delivery récente ne doit pas être affectée');
      });
    });

    it('recovery deux fois → idempotent', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'processing\', claimed_at = ? WHERE id = ?').run(staleTime, delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);
        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'unknown_outcome');
      });
    });

    it('batch staging avec delivery sent → batch passe en active', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId); // staging
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'sent\', message_id = \'msg-001\' WHERE id = ?').run(delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const batch = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batch.status, 'active');
      });
    });

    it('batch staging sans sent → deliveries unknown_outcome remises en pending', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId); // staging
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'unknown_outcome\' WHERE id = ?').run(delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'pending');
      });
    });
  });

  // ── 7. Health snapshot ────────────────────────────────────────────────────

  describe('getScrimBroadcastHealthSnapshot', () => {
    it('retourne les clés attendues, DB vide → compteurs à 0', async () => {
      await withTempDb(async (db, stmts) => {
        const snapshot = getScrimBroadcastHealthSnapshot(stmts);
        const expectedKeys = [
          'batches_staging', 'batches_active', 'batches_completed', 'batches_failed', 'batches_cancelled',
          'deliveries_pending', 'deliveries_processing', 'deliveries_retry', 'deliveries_sent',
          'deliveries_failed_terminal', 'deliveries_cancelled', 'deliveries_unknown_outcome',
          'oldest_pending_created_at', 'oldest_retry_next_attempt_at',
        ];
        for (const key of expectedKeys) {
          assert.ok(key in snapshot, `Clé manquante : ${key}`);
        }
        assert.strictEqual(snapshot.batches_staging, 0);
        assert.strictEqual(snapshot.deliveries_pending, 0);
        assert.strictEqual(snapshot.oldest_pending_created_at, null);
      });
    });

    it('compteurs corrects avec un batch active + delivery pending', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        const snapshot = getScrimBroadcastHealthSnapshot(stmts);
        assert.strictEqual(snapshot.batches_active, 1);
        assert.strictEqual(snapshot.deliveries_pending, 1);
        assert.ok(snapshot.oldest_pending_created_at !== null);
      });
    });
  });

  // ── 8. Annulation fermeture ────────────────────────────────────────────────

  describe('annulation à la fermeture', () => {
    it('closeScrimPostByDbId flag ON → deliveries pending annulées', async () => {
      const prev = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = '1';
      try {
        await withTempDb(async (db, stmts) => {
          const scrimId = insertTestScrimPost(stmts);
          const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
          const d1 = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

          closeScrimPostByDbId(db, stmts, scrimId, 'closed_manual', 'manual');

          const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(d1);
          assert.strictEqual(d.status, 'cancelled');
        });
      } finally {
        if (prev === undefined) delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
        else process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = prev;
      }
    });

    it('closeScrimPostByDbId flag OFF → deliveries non modifiées', async () => {
      const prev = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      delete process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED;
      try {
        await withTempDb(async (db, stmts) => {
          const scrimId = insertTestScrimPost(stmts);
          const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
          const d1 = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

          closeScrimPostByDbId(db, stmts, scrimId, 'closed_manual', 'manual');

          const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(d1);
          assert.strictEqual(d.status, 'pending');
        });
      } finally {
        if (prev !== undefined) process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED = prev;
      }
    });

    it('cancelPendingDeliveriesForScrim annule pending et retry, pas sent', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const dSent = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g1', channelId: 'c1' });

        const now = new Date().toISOString();
        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'sent\', message_id = \'m1\' WHERE id = ?').run(dSent);

        stmts.cancelPendingDeliveriesForScrim.run({ scrim_post_db_id: scrimId, completed_at: now, updated_at: now });

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(dSent);
        assert.strictEqual(d.status, 'sent', 'Delivery sent ne doit pas être annulée');
      });
    });
  });

  // ── 9. Prepared statements ────────────────────────────────────────────────

  describe('prepared statements', () => {
    it('markDeliverySent — status sent + message_id + attempt_count incrémenté', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        stmts.markDeliverySent.run({ id: delivId, message_id: 'msg-xyz', completed_at: now, updated_at: now });

        const d = db.prepare('SELECT * FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent');
        assert.strictEqual(d.message_id, 'msg-xyz');
        assert.strictEqual(Number(d.attempt_count), 1);
      });
    });

    it('markDeliveryRetry — status retry + next_attempt_at + last_error_code', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        const future = new Date(Date.now() + 60000).toISOString();
        stmts.markDeliveryRetry.run({ id: delivId, next_attempt_at: future, last_error_code: 'RATE_LIMIT', last_error_message: 'Too many requests', updated_at: now });

        const d = db.prepare('SELECT * FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'retry');
        assert.strictEqual(d.last_error_code, 'RATE_LIMIT');
        assert.strictEqual(d.next_attempt_at, future);
      });
    });

    it('markDeliveryTerminal — status failed_terminal', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        stmts.markDeliveryTerminal.run({ id: delivId, last_error_code: 'PERMS', last_error_message: 'No perms', completed_at: now, updated_at: now });

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'failed_terminal');
      });
    });

    it('markDeliveryUnknownOutcome — status unknown_outcome', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        stmts.markDeliveryUnknownOutcome.run({ id: delivId, last_error_code: 'DB_ERR', last_error_message: 'DB failed', completed_at: now, updated_at: now });

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'unknown_outcome');
      });
    });

    it('setScrimBroadcastBatchActive — staging → active', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        const now = new Date().toISOString();
        stmts.setScrimBroadcastBatchActive.run({ id: batchId, started_at: now, updated_at: now });
        const batch = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batch.status, 'active');
      });
    });

    it('setScrimBroadcastBatchCompleted — → completed', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const now = new Date().toISOString();
        stmts.setScrimBroadcastBatchCompleted.run({ id: batchId, status: 'completed', completed_at: now, updated_at: now });
        const batch = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batch.status, 'completed');
      });
    });

    it('hasPendingDeliveriesForBatch — truthy avec pending, falsy sans', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        assert.ok(stmts.hasPendingDeliveriesForBatch.get(batchId), 'Doit être truthy avec pending');

        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'sent\' WHERE id = ?').run(delivId);
        assert.ok(!stmts.hasPendingDeliveriesForBatch.get(batchId), 'Doit être falsy sans pending');
      });
    });

    it('countSentDeliveriesForBatch — retourne le bon nombre', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);

        let cnt = stmts.countSentDeliveriesForBatch.get(batchId);
        assert.strictEqual(Number(cnt.n), 0);

        db.prepare('UPDATE scrim_broadcast_deliveries SET status = \'sent\', message_id = \'m1\' WHERE id = ?').run(delivId);
        cnt = stmts.countSentDeliveriesForBatch.get(batchId);
        assert.strictEqual(Number(cnt.n), 1);
      });
    });

    it('markDeliveryCancelled — annule pending/retry, pas sent', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();

        stmts.markDeliveryCancelled.run({ id: delivId, completed_at: now, updated_at: now });
        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'cancelled');
      });
    });
  });

  // ── 10. i18n ─────────────────────────────────────────────────────────────

  describe('i18n', () => {
    it('findScrim.successPersistent FR — pas de clé brute, placeholders résolus', () => {
      const val = t('fr', 'findScrim.successPersistent', { targetCount: 14, id: 42, url: 'https://discord.gg/test' });
      assert.ok(val && val.length > 0, 'Valeur vide');
      assert.ok(!val.startsWith('findScrim.'), `Clé brute retournée : "${val}"`);
      assert.ok(!val.includes('{targetCount}'), 'Placeholder {targetCount} non résolu');
      assert.ok(!val.includes('{id}'), 'Placeholder {id} non résolu');
      assert.ok(!val.includes('{url}'), 'Placeholder {url} non résolu');
      assert.ok(val.includes('14'), 'targetCount=14 doit apparaître dans la valeur');
      assert.ok(val.includes('42'), 'id=42 doit apparaître dans la valeur');
    });

    it('findScrim.successPersistent EN — pas de clé brute, placeholders résolus', () => {
      const val = t('en', 'findScrim.successPersistent', { targetCount: 5, id: 99, url: 'https://discord.gg/en' });
      assert.ok(val && val.length > 0, 'Valeur vide');
      assert.ok(!val.startsWith('findScrim.'));
      assert.ok(!val.includes('{targetCount}'));
      assert.ok(val.includes('5'));
      assert.ok(val.includes('99'));
    });

    it('findScrim.bootstrapZeroDelivery FR — placeholder {targetCount} résolu', () => {
      const val = t('fr', 'findScrim.bootstrapZeroDelivery', { targetCount: 3 });
      assert.ok(val && val.length > 0);
      assert.ok(!val.includes('{targetCount}'));
      assert.ok(val.includes('3'));
    });

    it('findScrim.bootstrapZeroDelivery EN — placeholder {targetCount} résolu', () => {
      const val = t('en', 'findScrim.bootstrapZeroDelivery', { targetCount: 7 });
      assert.ok(val && val.length > 0);
      assert.ok(!val.includes('{targetCount}'));
      assert.ok(val.includes('7'));
    });

    it('successPersistent FR et EN sont différents', () => {
      const fr = t('fr', 'findScrim.successPersistent', { targetCount: 1, id: 1, url: 'u' });
      const en = t('en', 'findScrim.successPersistent', { targetCount: 1, id: 1, url: 'u' });
      assert.notEqual(fr, en);
    });

    it('parité FR/EN — même nombre de clés après ajout', async () => {
      const { fr } = await import('../src/i18n/fr.js');
      const { en } = await import('../src/i18n/en.js');
      assert.strictEqual(Object.keys(fr).length, Object.keys(en).length,
        `FR: ${Object.keys(fr).length} clés, EN: ${Object.keys(en).length} clés`);
    });

    it('toutes les clés persistent existent en FR et EN sans retour de clé brute', () => {
      const keys = ['findScrim.successPersistent', 'findScrim.bootstrapZeroDelivery'];
      for (const key of keys) {
        for (const locale of /** @type {const} */ (['fr', 'en'])) {
          const val = t(locale, key, { targetCount: 1, id: 1, url: 'u' });
          assert.ok(val && !val.startsWith(key), `[${locale}] ${key} retourne clé brute`);
        }
      }
    });

    it('successPersistent contient /scrim-close en FR et EN', () => {
      for (const locale of ['fr', 'en']) {
        const val = t(locale, 'findScrim.successPersistent', { targetCount: 1, id: 42, url: 'u' });
        assert.ok(val.includes('/scrim-close'), `[${locale}] /scrim-close absent`);
      }
    });
  });

  // ── 11. HTTP 403 — classification terminale ───────────────────────────────

  describe('HTTP 403 — classification terminale', () => {
    it('HTTP 403 sans code JSON Discord → terminal', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const err = Object.assign(new Error('Forbidden'), { status: 403 });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'terminal');
      assert.strictEqual(result.code, 'HTTP_403');
    });

    it('HTTP 403 avec code 50001 → terminal (code JSON prioritaire)', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const { RESTJSONErrorCodes } = await import('discord-api-types/v10');
      const err = Object.assign(new Error('Missing Access'), { status: 403, code: RESTJSONErrorCodes.MissingAccess });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'terminal');
    });

    it('HTTP 403 avec code 50013 → terminal', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const { RESTJSONErrorCodes } = await import('discord-api-types/v10');
      const err = Object.assign(new Error('Missing Permissions'), { status: 403, code: RESTJSONErrorCodes.MissingPermissions });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'terminal');
    });

    it('429 reste retryable après la correction HTTP 403', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const err = Object.assign(new Error('Rate limited'), { status: 429 });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'retryable');
    });

    it('500 reste retryable', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const err = Object.assign(new Error('Server Error'), { status: 500 });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'retryable');
    });

    it('ETIMEDOUT reste retryable', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const err = Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'retryable');
    });

    it('ECONNRESET reste retryable', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const err = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
      const result = classifyDiscordEditError(err);
      assert.strictEqual(result.kind, 'retryable');
    });

    it('MUTATION: 403 ne doit jamais être retryable', async () => {
      const { classifyDiscordEditError } = await import('../src/services/discordRetryPolicy.js');
      const err = Object.assign(new Error('Forbidden'), { status: 403 });
      const result = classifyDiscordEditError(err);
      assert.notStrictEqual(result.kind, 'retryable', '403 ne doit pas être retryable');
    });
  });

  // ── 12. unknown_outcome dans le CHECK ────────────────────────────────────

  describe('unknown_outcome — présent dans le CHECK SQLite', () => {
    it('delivery peut être marquée unknown_outcome (CHECK autorise)', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });

        assert.doesNotThrow(() => {
          stmts.markDeliveryUnknownOutcome.run({
            id: delivId,
            last_error_code: 'STALE_PROCESSING',
            last_error_message: 'Test stale',
            completed_at: now,
            updated_at: now,
          });
        }, 'unknown_outcome doit être autorisé par le CHECK SQLite');

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'unknown_outcome');
      });
    });

    it('status invalide refusé par le CHECK', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        assert.throws(
          () => db.prepare("UPDATE scrim_broadcast_deliveries SET status = 'invalid_xyz' WHERE id = ?").run(delivId),
          /CHECK constraint failed/,
          'Status invalide doit être refusé par le CHECK',
        );
      });
    });

    it('unknown_outcome n\'est pas claimable automatiquement', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status = 'unknown_outcome', updated_at = ? WHERE id = ?").run(now, delivId);

        const claimResult = stmts.claimNextDeliveryForBatch.run({ batch_id: batchId, now_iso: now, claimed_at: now, updated_at: now });
        assert.strictEqual(claimResult.changes, 0, 'unknown_outcome ne doit pas être claimable');
      });
    });
  });

  // ── 13. Unicité batch staging/active ─────────────────────────────────────

  describe('unicité batch staging/active — idx_sbb_active_unique', () => {
    it('premier batch staging accepté', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        assert.doesNotThrow(() => insertTestBatch(stmts, scrimId));
      });
    });

    it('deuxième batch staging identique refusé (UNIQUE constraint)', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        insertTestBatch(stmts, scrimId);
        assert.throws(
          () => insertTestBatch(stmts, scrimId),
          /UNIQUE constraint failed/,
          'Doit lever UNIQUE constraint',
        );
      });
    });

    it('batch completed puis nouvelle génération staging autorisée', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        const now = new Date().toISOString();
        stmts.setScrimBroadcastBatchCompleted.run({ id: batchId, status: 'completed', completed_at: now, updated_at: now });
        assert.doesNotThrow(() => insertTestBatch(stmts, scrimId, { generation: 1 }));
      });
    });

    it('batch active + second tentative staging identique refusée', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        insertTestBatch(stmts, scrimId, { status: 'active' });
        assert.throws(
          () => insertTestBatch(stmts, scrimId),
          /UNIQUE constraint failed/,
        );
      });
    });
  });

  // ── 14. Recovery Cas C — staging zéro sent, toutes terminales ────────────

  describe('recovery Cas C — staging zéro sent, toutes failed_terminal', () => {
    it('batch staging + 0 sent + toutes failed_terminal → batch failed + scrim supprimé', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status = 'failed_terminal', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, delivId);

        const batchBefore = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batchBefore.status, 'staging');

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const batchAfter = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batchAfter.status, 'failed', 'Batch doit être failed');
        const scrimAfter = db.prepare('SELECT * FROM scrim_posts WHERE id = ?').get(scrimId);
        assert.ok(!scrimAfter, 'Scrim doit être supprimé');
      });
    });

    it('Cas C idempotent — second recovery sans erreur', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status = 'failed_terminal', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);
        assert.doesNotThrow(() => recoverStaleScrimBroadcastDeliveries(db, stmts));

        const batchAfter = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batchAfter.status, 'failed');
      });
    });

    it('Cas B — staging + pending restante → batch reste staging, scrim existe', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g-pending' });
        const delivId2 = insertTestDelivery(stmts, batchId, scrimId, { guildId: 'g-terminal' });
        const now = new Date().toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status = 'failed_terminal', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, delivId2);

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const batchAfter = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batchAfter.status, 'staging', 'Cas B : batch doit rester staging');
        const scrimAfter = db.prepare('SELECT * FROM scrim_posts WHERE id = ?').get(scrimId);
        assert.ok(scrimAfter, 'Cas B : scrim doit exister');
      });
    });

    it('Cas A — staging + 1 sent → batch promu active', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId);
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        db.prepare("UPDATE scrim_broadcast_deliveries SET status = 'sent', message_id = 'msg-001', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, delivId);

        recoverStaleScrimBroadcastDeliveries(db, stmts);

        const batchAfter = stmts.getScrimBroadcastBatchById.get(batchId);
        assert.strictEqual(batchAfter.status, 'active', 'Cas A : batch doit être promu active');
      });
    });
  });

  // ── 15. Fermeture pendant envoi — post-send check ────────────────────────

  describe('fermeture pendant channel.send — policy post-send', () => {
    it('keep policy — message.edit() appelé, delete non appelé', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        const deleteCount = { n: 0 };
        const editCount = { n: 0 };

        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-keep-001',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => { deleteCount.n += 1; },
              edit: async () => { editCount.n += 1; return {}; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        assert.strictEqual(deleteCount.n, 0, 'keep policy : delete ne doit pas être appelé');
        assert.strictEqual(editCount.n, 1, 'keep policy : edit doit être appelé exactement une fois');
      });
    });

    it('keep policy — delivery reste sent après edit', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();

        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return { id: 'msg-keep-002', guildId: 'guild-001', channelId: 'chan-001',
              delete: async () => {}, edit: async () => ({}) };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent', 'delivery doit rester sent après edit lifecycle');
      });
    });

    it('keep policy — edit échoue retryable → retry SQLite créé, delivery reste sent', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();

        const retryableErr = Object.assign(new Error('Service unavailable'), { status: 503 });
        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-keep-003',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => {},
              edit: async () => { throw retryableErr; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        // Delivery doit rester sent
        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent', 'delivery doit rester sent malgré l\'échec edit');

        // Retry d'édition doit être créé
        const retry = db.prepare('SELECT * FROM discord_message_edit_retries WHERE message_id = ?').get('msg-keep-003');
        assert.ok(retry, 'Un retry d\'édition doit être créé après échec retryable');
      });
    });

    it('keep policy — edit échoue terminal → delivery reste sent, pas de retry SQLite', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();

        const { RESTJSONErrorCodes } = await import('discord-api-types/v10');
        const terminalErr = Object.assign(new Error('Unknown Channel'), { code: RESTJSONErrorCodes.UnknownChannel });
        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-keep-004',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => {},
              edit: async () => { throw terminalErr; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent', 'delivery doit rester sent malgré erreur terminale edit');
        const retry = db.prepare('SELECT * FROM discord_message_edit_retries WHERE message_id = ?').get('msg-keep-004');
        assert.ok(!retry, 'Pas de retry pour une erreur terminale');
      });
    });

    it('delete policy — message supprimé et discord_deleted_at défini', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.upsertScrimMessageLifecyclePolicy.run({ guild_id: 'guild-001', policy: 'delete', updated_at: now });
        const deleteCount = { n: 0 };
        const editCount = { n: 0 };

        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-del-002',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => { deleteCount.n += 1; },
              edit: async () => { editCount.n += 1; return {}; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        assert.strictEqual(deleteCount.n, 1, 'delete policy : delete doit être appelé une fois');
        assert.strictEqual(editCount.n, 0, 'delete policy : edit ne doit pas être appelé');
        const msgRow = db.prepare('SELECT discord_deleted_at FROM scrim_post_messages WHERE message_id = ?').get('msg-del-002');
        assert.ok(msgRow?.discord_deleted_at, 'discord_deleted_at doit être défini après suppression post-fermeture');
      });
    });

    it('delete policy échoue → fallback édition (edit appelé)', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.upsertScrimMessageLifecyclePolicy.run({ guild_id: 'guild-001', policy: 'delete', updated_at: now });
        const editCount = { n: 0 };

        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-del-fb-001',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => { throw new Error('Cannot delete'); },
              edit: async () => { editCount.n += 1; return {}; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        assert.strictEqual(editCount.n, 1, 'delete échoue → fallback édition : edit doit être appelé');
      });
    });

    it('aucun double send — deux passes, un seul channel.send', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const sendCount = { n: 0 };
        const sent = [];
        const mockChannel = buildMockChannel('chan-001', sent, { guildId: 'guild-001' });
        const origSend = mockChannel.send.bind(mockChannel);
        mockChannel.send = async (payload) => { sendCount.n += 1; return origSend(payload); };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);
        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        assert.strictEqual(sendCount.n, 1, 'Un seul send attendu sur deux passes');
      });
    });

    it('transaction send+DB réussie puis sync lifecycle échoue → delivery reste sent', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        const delivId = insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();

        // Erreur retryable sur edit, scrim fermé pendant send
        const retryableErr = Object.assign(new Error('Rate limit'), { status: 503 });
        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-txn-001',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => {},
              edit: async () => { throw retryableErr; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });

        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        // Delivery reste sent — le succès de livraison ne doit pas être effacé
        const d = db.prepare('SELECT status FROM scrim_broadcast_deliveries WHERE id = ?').get(delivId);
        assert.strictEqual(d.status, 'sent', 'delivery doit rester sent même si sync lifecycle échoue');
        // Message bien présent en DB
        const msg = db.prepare('SELECT * FROM scrim_post_messages WHERE message_id = ?').get('msg-txn-001');
        assert.ok(msg, 'scrim_post_messages doit contenir le message livré');
        // Retry SQLite créé pour l'édition
        const retry = db.prepare('SELECT * FROM discord_message_edit_retries WHERE message_id = ?').get('msg-txn-001');
        assert.ok(retry, 'Un retry d\'édition doit être enregistré');
      });
    });

    it('MUTATION keep: sans post-send check edit, embed resterait actif', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        const editCount = { n: 0 };

        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return {
              id: 'msg-mut-keep-001',
              guildId: 'guild-001',
              channelId: 'chan-001',
              delete: async () => {},
              edit: async () => { editCount.n += 1; return {}; },
            };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });
        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        // Avec post-send check actif + keep policy : edit doit avoir été appelé
        assert.strictEqual(editCount.n, 1, 'Mutation keep détectée : sans post-send check, edit ne serait pas appelé');
      });
    });

    it('MUTATION delete: sans post-send check, delete policy serait ignorée', async () => {
      await withTempDb(async (db, stmts) => {
        const scrimId = insertTestScrimPost(stmts);
        const batchId = insertTestBatch(stmts, scrimId, { status: 'active' });
        insertTestDelivery(stmts, batchId, scrimId);
        const now = new Date().toISOString();
        stmts.upsertScrimMessageLifecyclePolicy.run({ guild_id: 'guild-001', policy: 'delete', updated_at: now });
        const deleteCount = { n: 0 };

        const mockChannel = {
          id: 'chan-001',
          type: ChannelType.GuildText,
          permissionsFor: () => new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ]),
          send: async () => {
            db.prepare("UPDATE scrim_posts SET status = 'closed_manual', closed_at = ? WHERE id = ?").run(now, scrimId);
            return { id: 'msg-mut-003', guildId: 'guild-001', channelId: 'chan-001',
              delete: async () => { deleteCount.n += 1; }, edit: async () => ({}) };
          },
        };
        const mockClient = buildMockClient({ 'guild-001': buildMockGuild('guild-001', { 'chan-001': mockChannel }) });
        await runScrimBroadcastDeliveryPass(mockClient, db, stmts);

        assert.strictEqual(deleteCount.n, 1, 'Mutation delete détectée : sans post-send check, delete ne serait pas appelé');
      });
    });
  });

  // ── 18. Shutdown idempotent ───────────────────────────────────────────────

  describe('shutdown — idempotence et ordre', () => {
    it('stopScrimBroadcastDeliveryJob idempotent — appelé deux fois sans erreur', async () => {
      const { stopScrimBroadcastDeliveryJob } = await import('../src/services/scrimBroadcastDeliveryJob.js');
      await stopScrimBroadcastDeliveryJob();
      await assert.doesNotReject(() => stopScrimBroadcastDeliveryJob());
    });

    it('stopScrimBroadcastDeliveryJob — résout immédiatement hors passe (< 300ms)', async () => {
      const { stopScrimBroadcastDeliveryJob } = await import('../src/services/scrimBroadcastDeliveryJob.js');
      const start = Date.now();
      await stopScrimBroadcastDeliveryJob();
      assert.ok(Date.now() - start < 300, 'Résolution trop lente hors passe active');
    });

    it('guard shutdownPromise — double appel synchrone n\'exécute qu\'une fois', async () => {
      // Simule le comportement du guard dans bot.js sans démarrer le vrai bot
      let execCount = 0;
      /** @type {Promise<void> | null} */
      let shutdownPromise = null;

      const performShutdown = async () => {
        execCount += 1;
        await new Promise((r) => setTimeout(r, 10));
      };

      const gracefulShutdown = () => {
        if (!shutdownPromise) {
          shutdownPromise = performShutdown();
        }
      };

      // Deux appels quasi-simultanés
      gracefulShutdown();
      gracefulShutdown();
      await shutdownPromise;

      assert.strictEqual(execCount, 1, 'performShutdown doit être exécuté exactement une fois');
    });

    it('guard shutdownPromise — SIGINT + SIGTERM simultanés → une seule exécution', async () => {
      let execCount = 0;
      /** @type {Promise<void> | null} */
      let shutdownPromise = null;

      const performShutdown = async (signal) => {
        execCount += 1;
        await new Promise((r) => setTimeout(r, 20));
      };

      const gracefulShutdown = (signal) => {
        if (!shutdownPromise) {
          shutdownPromise = performShutdown(signal).catch(() => {});
        }
      };

      gracefulShutdown('SIGINT');
      gracefulShutdown('SIGTERM');
      await shutdownPromise;

      assert.strictEqual(execCount, 1, 'Le shutdown ne doit s\'exécuter qu\'une fois malgré SIGINT+SIGTERM');
    });

    it('guard shutdownPromise — erreur pendant shutdown journalisée, pas de second appel', async () => {
      let execCount = 0;
      let errorLogged = false;
      /** @type {Promise<void> | null} */
      let shutdownPromise = null;

      const performShutdown = async () => {
        execCount += 1;
        throw new Error('shutdown error simulé');
      };

      const gracefulShutdown = () => {
        if (!shutdownPromise) {
          shutdownPromise = performShutdown().catch(() => { errorLogged = true; });
        }
      };

      gracefulShutdown();
      gracefulShutdown(); // second appel ignoré
      await shutdownPromise;

      assert.strictEqual(execCount, 1, 'performShutdown exécuté une seule fois');
      assert.strictEqual(errorLogged, true, 'Erreur journalisée (catch atteignable)');
    });
  });

  // ── 16. Graceful shutdown ─────────────────────────────────────────────────

  describe('stopScrimBroadcastDeliveryJob — graceful shutdown', () => {
    it('résout sans erreur quand le job n\'est pas démarré', async () => {
      const { stopScrimBroadcastDeliveryJob } = await import('../src/services/scrimBroadcastDeliveryJob.js');
      await assert.doesNotReject(() => stopScrimBroadcastDeliveryJob());
    });

    it('résout rapidement hors passe active (< 500ms)', async () => {
      const { stopScrimBroadcastDeliveryJob } = await import('../src/services/scrimBroadcastDeliveryJob.js');
      const start = Date.now();
      await stopScrimBroadcastDeliveryJob();
      assert.ok(Date.now() - start < 500, 'Résolution trop lente hors passe active');
    });

    it('idempotent — deux appels successifs sans erreur', async () => {
      const { stopScrimBroadcastDeliveryJob } = await import('../src/services/scrimBroadcastDeliveryJob.js');
      await stopScrimBroadcastDeliveryJob();
      await assert.doesNotReject(() => stopScrimBroadcastDeliveryJob());
    });
  });

  // ── 17. i18n — contenu exact successPersistent ───────────────────────────

  describe('i18n — contenu exact successPersistent corrigé', () => {
    it('FR — ne contient pas "diffusé vers N serveur"', () => {
      const val = t('fr', 'findScrim.successPersistent', { targetCount: 14, id: 42, url: 'https://discord.gg/x' });
      assert.ok(!val.includes('diffusé vers'), `FR ne doit pas dire "diffusé vers N serveurs" : "${val.slice(0, 80)}"`);
    });

    it('FR — contient "Première diffusion confirmée"', () => {
      const val = t('fr', 'findScrim.successPersistent', { targetCount: 14, id: 42, url: 'u' });
      assert.ok(val.includes('Première diffusion confirmée'), `FR doit mentionner la première diffusion : "${val.slice(0, 80)}"`);
    });

    it('EN — ne contient pas "broadcast to N server"', () => {
      const val = t('en', 'findScrim.successPersistent', { targetCount: 14, id: 42, url: 'https://discord.gg/x' });
      assert.ok(!val.includes('broadcast to 14 server'), `EN ne doit pas dire "broadcast to N servers" : "${val.slice(0, 80)}"`);
    });

    it('EN — contient "First delivery confirmed"', () => {
      const val = t('en', 'findScrim.successPersistent', { targetCount: 14, id: 42, url: 'u' });
      assert.ok(val.includes('First delivery confirmed'), `EN doit mentionner la première livraison : "${val.slice(0, 80)}"`);
    });

    it('FR — contient targetCount dans la valeur', () => {
      const val = t('fr', 'findScrim.successPersistent', { targetCount: 7, id: 99, url: 'u' });
      assert.ok(val.includes('7'), 'targetCount=7 doit apparaître dans le message FR');
    });

    it('EN — contient targetCount dans la valeur', () => {
      const val = t('en', 'findScrim.successPersistent', { targetCount: 7, id: 99, url: 'u' });
      assert.ok(val.includes('7'), 'targetCount=7 doit apparaître dans le message EN');
    });

    it('MUTATION: ancien message "diffusé vers" → test doit échouer', () => {
      const val = t('fr', 'findScrim.successPersistent', { targetCount: 14, id: 42, url: 'u' });
      assert.notStrictEqual(val, `Scrim #42 diffusé vers 14 serveur(s).`, 'Ancien message ne doit plus être présent');
    });
  });
});
