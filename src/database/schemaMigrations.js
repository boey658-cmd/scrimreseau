/**
 * Migrations versionnées (Phase 0).
 *
 * - Table `schema_migrations` (id PRIMARY KEY, applied_at)
 * - Chaque migration s'exécute au plus une fois, dans une transaction
 * - Échec = throw (démarrage fail-safe)
 *
 * Les anciennes migrate* de db.js restent pour bootstrap historique ;
 * les nouvelles migrations structurelles passent ici.
 */

import { logger } from '../utils/logger.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} col
 */
function tableHasColumn(db, table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(/** @param {{ name?: string }} c */ (c) => c.name === col);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function ensureSchemaMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Rebuild guild_game_channels : PK (guild_id, channel_id) + enabled + sort_order.
 * Conserve toutes les rows ; enabled=1, sort_order=0.
 *
 * @param {import('better-sqlite3').Database} db
 */
function migrateGuildGameChannelsMultiSalon(db) {
  if (tableHasColumn(db, 'guild_game_channels', 'enabled')) {
    return;
  }

  db.exec(`
    CREATE TABLE guild_game_channels_new (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      game_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_guild_game_channels_game
      ON guild_game_channels_new (game_key);

    CREATE INDEX IF NOT EXISTS idx_ggc_guild_game_enabled_order
      ON guild_game_channels_new (guild_id, game_key, enabled, sort_order, created_at);
  `);

  // Copie : collision (guild_id, channel_id) → garde la plus ancienne.
  // created_at NULL → COALESCE 0 (déterministe, trie avant timestamps réels, NOT NULL safe).
  const rows = db
    .prepare(
      `SELECT guild_id, channel_id, game_key,
              COALESCE(created_at, 0) AS created_at
       FROM guild_game_channels
       ORDER BY COALESCE(created_at, 0) ASC, game_key ASC`,
    )
    .all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO guild_game_channels_new
      (guild_id, channel_id, game_key, enabled, sort_order, created_at, updated_at)
    VALUES (@guild_id, @channel_id, @game_key, 1, 0, @created_at, @created_at)
  `);

  const sourceRows = rows.length;
  let copied = 0;
  for (const row of rows) {
    const info = insert.run({
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      game_key: row.game_key,
      created_at: row.created_at,
    });
    if (info.changes > 0) copied += 1;
  }
  const skippedRows = sourceRows - copied;

  db.exec(`
    DROP TABLE guild_game_channels;
    ALTER TABLE guild_game_channels_new RENAME TO guild_game_channels;
  `);

  // Index ordre (aussi pour installs fraîches via ensure ci-dessous)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ggc_guild_game_enabled_order
      ON guild_game_channels (guild_id, game_key, enabled, sort_order, created_at);
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'guild_game_channels_multi_salon',
    source_rows: sourceRows,
    copied,
    skipped_rows: skippedRows,
  });
}

/**
 * Installs fraîches : table déjà avec enabled (INIT_SQL) — assure l'index ordre.
 * @param {import('better-sqlite3').Database} db
 */
function ensureGuildGameChannelsOrderIndex(db) {
  if (!tableHasColumn(db, 'guild_game_channels', 'enabled')) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ggc_guild_game_enabled_order
      ON guild_game_channels (guild_id, game_key, enabled, sort_order, created_at);
  `);
}

/**
 * Phase 1 — table entitlement_grants (sources paid/gift/manual, append-friendly).
 * @param {import('better-sqlite3').Database} db
 */
function migrateEntitlementGrants(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entitlement_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      plan_key TEXT NOT NULL CHECK (plan_key IN ('P1', 'P2', 'P3')),
      source TEXT NOT NULL CHECK (source IN ('paid', 'gift', 'manual')),
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'canceled', 'revoked', 'expired')),
      starts_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      grace_ends_at INTEGER,
      granted_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      external_ref TEXT,
      idempotency_key TEXT,
      provider TEXT,
      revoked_at INTEGER,
      revoked_by TEXT,
      revoke_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (ends_at > starts_at)
    );

    CREATE INDEX IF NOT EXISTS idx_entitlement_grants_guild
      ON entitlement_grants (guild_id);

    CREATE INDEX IF NOT EXISTS idx_entitlement_grants_guild_status_ends
      ON entitlement_grants (guild_id, status, ends_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_grants_idempotency
      ON entitlement_grants (idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'entitlement_grants',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 3 — filtres Elo par salon de réception.
 * @param {import('better-sqlite3').Database} db
 */
function migrateReceptionChannelEloFilters(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_reception_channel_filters (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      game_key TEXT NOT NULL,
      elo_rank_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_grcf_guild_game
      ON guild_reception_channel_filters (guild_id, game_key);

    CREATE INDEX IF NOT EXISTS idx_grcf_game
      ON guild_reception_channel_filters (game_key);
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'guild_reception_channel_filters',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 5 — profils structure Premium (annuaire enrichi).
 * @param {import('better-sqlite3').Database} db
 */
function migrateStructureProfiles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS structure_profiles (
      guild_id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT,
      description TEXT,
      logo_url TEXT,
      website_url TEXT,
      country_code TEXT,
      languages_json TEXT,
      socials_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_structure_profiles_updated
      ON structure_profiles (updated_at);
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'structure_profiles',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 6 — personnalisation locale embeds + presets.
 * @param {import('better-sqlite3').Database} db
 */
function migrateGuildEmbedCustomization(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_embed_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color_hex TEXT,
      emoji TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_guild_embed_presets_guild
      ON guild_embed_presets (guild_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_embed_presets_guild_name
      ON guild_embed_presets (guild_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS guild_embed_customization (
      guild_id TEXT PRIMARY KEY NOT NULL,
      color_hex TEXT,
      emoji TEXT,
      active_preset_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'guild_embed_customization',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 6b — emojis par ligne (emoji_date/format/rank/contact/structure).
 * Backward-compatible : ADD COLUMN si absent. Ne touche pas `emoji` legacy.
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} column
 */
function addColumnIfMissing(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => String(c.name) === column);
  if (exists) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function migrateGuildEmbedLineEmojis(db) {
  // Ensure base tables exist (idempotent).
  migrateGuildEmbedCustomization(db);

  const lineCols = [
    'emoji_date',
    'emoji_format',
    'emoji_rank',
    'emoji_contact',
    'emoji_structure',
  ];
  let added = 0;
  for (const col of lineCols) {
    if (addColumnIfMissing(db, 'guild_embed_customization', col)) added += 1;
    if (addColumnIfMissing(db, 'guild_embed_presets', col)) added += 1;
  }

  logger.info('Migration SQLite schema_migrations', {
    change: 'guild_embed_line_emojis',
    action: 'ADD_COLUMN_IF_MISSING',
    columns_added: added,
  });
}

/**
 * @typedef {{ id: string, up: (db: import('better-sqlite3').Database) => void }} SchemaMigration
 */

/** @type {readonly SchemaMigration[]} */
export const SCHEMA_MIGRATIONS = Object.freeze([
  {
    id: '20260923_01_guild_game_channels_multi_salon',
    up: (db) => {
      migrateGuildGameChannelsMultiSalon(db);
      ensureGuildGameChannelsOrderIndex(db);
    },
  },
  {
    id: '20260923_02_entitlement_grants',
    up: (db) => {
      migrateEntitlementGrants(db);
    },
  },
  {
    id: '20260923_03_reception_channel_elo_filters',
    up: (db) => {
      migrateReceptionChannelEloFilters(db);
    },
  },
  {
    id: '20260923_04_structure_profiles',
    up: (db) => {
      migrateStructureProfiles(db);
    },
  },
  {
    id: '20260923_05_guild_embed_customization',
    up: (db) => {
      migrateGuildEmbedCustomization(db);
    },
  },
  {
    id: '20260923_06_billing_core',
    up: (db) => {
      migrateBillingCore(db);
    },
  },
  {
    id: '20260924_01_billing_paddle_sandbox',
    up: (db) => {
      migrateBillingPaddleSandbox(db);
    },
  },
  {
    id: '20260926_01_guild_embed_line_emojis',
    up: (db) => {
      migrateGuildEmbedLineEmojis(db);
    },
  },
]);

/**
 * Phase 7B — checkout intents + tracking adjustments (Paddle sandbox).
 * @param {import('better-sqlite3').Database} db
 */
function migrateBillingPaddleSandbox(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_checkout_intents (
      id TEXT PRIMARY KEY NOT NULL,
      guild_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      internal_product_key TEXT NOT NULL,
      expected_price_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'consumed', 'expired', 'canceled')),
      binding_hash TEXT NOT NULL,
      paddle_transaction_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_billing_checkout_intents_guild_status
      ON billing_checkout_intents (guild_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS billing_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_adjustment_id TEXT NOT NULL,
      guild_id TEXT,
      provider_subscription_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      effect_applied INTEGER NOT NULL DEFAULT 0 CHECK (effect_applied IN (0, 1)),
      last_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider, provider_adjustment_id)
    );
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'billing_paddle_sandbox',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 7A — Billing Core (provider-agnostic).
 * Aucune donnée carte / PCI. Provider n'écrit jamais entitlement_grants.
 * @param {import('better-sqlite3').Database} db
 */
function migrateBillingCore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_customer_id TEXT NOT NULL,
      contact_user_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider, provider_customer_id)
    );

    CREATE INDEX IF NOT EXISTS idx_billing_customers_guild
      ON billing_customers (guild_id);

    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      customer_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_subscription_id TEXT NOT NULL,
      plan_key TEXT NOT NULL CHECK (plan_key IN ('P1', 'P2', 'P3')),
      interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
      product_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'grace', 'canceled', 'expired')),
      current_period_start INTEGER NOT NULL,
      current_period_end INTEGER NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
      canceled_at INTEGER,
      grace_ends_at INTEGER,
      pending_plan_key TEXT CHECK (pending_plan_key IS NULL OR pending_plan_key IN ('P1', 'P2', 'P3')),
      pending_plan_effective_at INTEGER,
      last_provider_event_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (provider, provider_subscription_id),
      CHECK (current_period_end > current_period_start),
      FOREIGN KEY (customer_id) REFERENCES billing_customers(id)
    );

    CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_guild
      ON billing_subscriptions (guild_id);

    CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_guild_status
      ON billing_subscriptions (guild_id, status);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_subscriptions_guild_live
      ON billing_subscriptions (guild_id)
      WHERE status IN ('pending', 'active', 'past_due', 'grace');

    CREATE TABLE IF NOT EXISTS billing_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      provider_event_at INTEGER,
      guild_id TEXT,
      provider_subscription_id TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      processing_status TEXT NOT NULL CHECK (
        processing_status IN ('received', 'processing', 'processed', 'ignored_stale', 'failed')
      ),
      payload_hash TEXT NOT NULL,
      error_code TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (provider, provider_event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_billing_events_status
      ON billing_events (processing_status, received_at);

    CREATE INDEX IF NOT EXISTS idx_billing_events_guild
      ON billing_events (guild_id);

    CREATE TABLE IF NOT EXISTS billing_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      subscription_id INTEGER,
      event_id INTEGER,
      action TEXT NOT NULL,
      from_plan_key TEXT,
      to_plan_key TEXT,
      from_status TEXT,
      to_status TEXT,
      detail_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_billing_audit_guild
      ON billing_audit (guild_id, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_grants_paid_external_ref
      ON entitlement_grants (external_ref)
      WHERE source = 'paid' AND external_ref IS NOT NULL;
  `);

  logger.info('Migration SQLite schema_migrations', {
    change: 'billing_core',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Applique les migrations non encore enregistrées.
 * @param {import('better-sqlite3').Database} db
 */
export function runSchemaMigrations(db) {
  ensureSchemaMigrationsTable(db);

  const isApplied = db.prepare(
    `SELECT 1 AS ok FROM schema_migrations WHERE id = ? LIMIT 1`,
  );
  const markApplied = db.prepare(
    `INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
  );

  for (const migration of SCHEMA_MIGRATIONS) {
    if (isApplied.get(migration.id)) {
      continue;
    }

    const apply = db.transaction(() => {
      migration.up(db);
      markApplied.run(migration.id, new Date().toISOString());
    });

    try {
      apply();
      logger.info('schema_migrations: applied', { id: migration.id });
    } catch (err) {
      logger.error('schema_migrations: FAILED — démarrage aborté', {
        id: migration.id,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      throw err;
    }
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]}
 */
export function listAppliedSchemaMigrations(db) {
  ensureSchemaMigrationsTable(db);
  return db
    .prepare(`SELECT id FROM schema_migrations ORDER BY applied_at ASC, id ASC`)
    .all()
    .map(/** @param {{ id: string }} r */ (r) => r.id);
}
