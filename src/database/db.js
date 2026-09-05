import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScheduledAtIso } from '../utils/scrimScheduledAt.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.join(__dirname, '..', '..', 'data', 'scrim.db');

let dbInstance = null;

/** Chemin effectif du fichier SQLite (relu à chaque ouverture pour tests / override env). */
function resolveDbPath() {
  return process.env.SQLITE_PATH || defaultPath;
}

function ensureDirSync(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS guild_game_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, game_key)
);

CREATE TABLE IF NOT EXISTS guild_blocked_users (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS scrim_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_user_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  game_key TEXT NOT NULL,
  rank_key TEXT NOT NULL,
  format_key TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  contact_display_name TEXT,
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  tags TEXT NOT NULL,
  multi_opgg_url TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guild_game_channels_game
  ON guild_game_channels (game_key);

CREATE INDEX IF NOT EXISTS idx_guild_blocked_users_lookup
  ON guild_blocked_users (guild_id, user_id);

CREATE TABLE IF NOT EXISTS guild_scrim_permissions (
  guild_id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('everyone','roles'))
);

CREATE TABLE IF NOT EXISTS guild_scrim_allowed_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS guild_scrim_usage_channel (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guild_scrim_allowed_roles_guild
  ON guild_scrim_allowed_roles (guild_id);

CREATE TABLE IF NOT EXISTS scrim_post_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_post_db_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  UNIQUE (guild_id, channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_spm_post
  ON scrim_post_messages (scrim_post_db_id);

CREATE TABLE IF NOT EXISTS scrim_spam_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spam_reports_pair_time
  ON scrim_spam_reports (reporter_user_id, target_user_id, created_at);

CREATE TABLE IF NOT EXISTS global_blacklisted_users (
  user_id TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scrim_posts_author_created
  ON scrim_posts (author_user_id, created_at);

CREATE TABLE IF NOT EXISTS discord_message_edit_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_post_db_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  abandoned_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_edit_retry_active_unique
  ON discord_message_edit_retries (guild_id, channel_id, message_id, target_status)
  WHERE resolved_at IS NULL AND abandoned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dm_edit_retry_due
  ON discord_message_edit_retries (next_attempt_at)
  WHERE resolved_at IS NULL AND abandoned_at IS NULL;

CREATE TABLE IF NOT EXISTS guild_scrim_reception_bypass (
  guild_id TEXT PRIMARY KEY NOT NULL,
  bypass_member_minimum INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS guild_scrim_message_lifecycle_policy (
  guild_id TEXT PRIMARY KEY NOT NULL,
  policy TEXT NOT NULL DEFAULT 'keep'
    CHECK(policy IN ('keep', 'delete')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS network_dashboard_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS scrim_broadcast_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scrim_post_db_id INTEGER NOT NULL,
  operation_type TEXT NOT NULL DEFAULT 'initial',
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'staging'
    CHECK(status IN ('staging','active','completed','failed','cancelled')),
  target_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  last_dispatched_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sbb_active_unique
  ON scrim_broadcast_batches (scrim_post_db_id, operation_type, generation)
  WHERE status IN ('staging','active');

CREATE TABLE IF NOT EXISTS scrim_broadcast_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  scrim_post_db_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game_key TEXT NOT NULL,
  operation_type TEXT NOT NULL DEFAULT 'initial',
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','retry','sent','failed_terminal','cancelled','unknown_outcome')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  claimed_at TEXT,
  message_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(scrim_post_db_id, guild_id, channel_id, operation_type, generation)
);

CREATE INDEX IF NOT EXISTS idx_sbd_batch_status
  ON scrim_broadcast_deliveries (batch_id, status);

CREATE INDEX IF NOT EXISTS idx_sbd_status_next_attempt
  ON scrim_broadcast_deliveries (status, next_attempt_at)
  WHERE status IN ('pending','retry');

CREATE INDEX IF NOT EXISTS idx_sbd_scrim
  ON scrim_broadcast_deliveries (scrim_post_db_id);

CREATE INDEX IF NOT EXISTS idx_sbd_claimed_processing
  ON scrim_broadcast_deliveries (claimed_at)
  WHERE status = 'processing';
`;

const MULTI_OPGG_COLUMN = 'multi_opgg_url';

/**
 * Bases créées avant l’ajout du champ : ALTER ADD COLUMN une seule fois.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsMultiOpggUrl(db) {
  const cols = db.prepare(`PRAGMA table_info(scrim_posts)`).all();
  const hasColumn = cols.some(
    /** @param {{ name?: string }} c */ (c) => c.name === MULTI_OPGG_COLUMN,
  );
  if (hasColumn) return;

  db.exec(
    `ALTER TABLE scrim_posts ADD COLUMN ${MULTI_OPGG_COLUMN} TEXT`,
  );
  logger.info('Migration SQLite', {
    change: 'scrim_posts.multi_opgg_url',
    action: 'ADD_COLUMN',
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} col
 */
function tableHasColumn(db, table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(
    /** @param {{ name?: string }} c */ (c) => c.name === col,
  );
}

/**
 * Supprime l’ancienne table de cooldown utilisateurs (héritage).
 * @param {import('better-sqlite3').Database} db
 */
function migrateDropLegacyUserCooldowns(db) {
  try {
    db.exec(`DROP TABLE IF EXISTS user_cooldowns`);
    logger.info('Migration SQLite', {
      change: 'user_cooldowns',
      action: 'DROP_TABLE_IF_EXISTS',
    });
  } catch (err) {
    logger.error('Migration user_cooldowns', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Cycle de vie scrim : colonnes scrim_posts, index expiration, backfill legacy.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsLifecycle(db) {
  const addCol = (name, ddlFragment) => {
    if (!tableHasColumn(db, 'scrim_posts', name)) {
      db.exec(`ALTER TABLE scrim_posts ADD COLUMN ${ddlFragment}`);
      logger.info('Migration SQLite', {
        change: `scrim_posts.${name}`,
        action: 'ADD_COLUMN',
      });
    }
  };

  addCol('scrim_public_id', 'scrim_public_id INTEGER');
  addCol('origin_guild_id', 'origin_guild_id TEXT');
  addCol('status', "status TEXT NOT NULL DEFAULT 'closed_manual'");
  addCol('closed_at', 'closed_at TEXT');
  addCol('closed_reason', 'closed_reason TEXT');
  addCol('scheduled_at', 'scheduled_at TEXT');

  db.prepare(`
    UPDATE scrim_posts
    SET origin_guild_id = source_guild_id
    WHERE origin_guild_id IS NULL OR origin_guild_id = ''
  `).run();

  const missingPublicRows = db
    .prepare(`SELECT id FROM scrim_posts WHERE scrim_public_id IS NULL`)
    .all();
  const updPublic = db.prepare(
    `UPDATE scrim_posts SET scrim_public_id = ? WHERE id = ?`,
  );
  for (const r of missingPublicRows) {
    const v = ((Number(r.id) * 7919) % 999) + 1;
    updPublic.run(v, r.id);
  }

  const missingSchedule = db
    .prepare(`
      SELECT id, scheduled_date, scheduled_time, created_at
      FROM scrim_posts
      WHERE scheduled_at IS NULL OR scheduled_at = ''
    `)
    .all();
  const updSched = db.prepare(
    `UPDATE scrim_posts SET scheduled_at = ? WHERE id = ?`,
  );
  for (const r of missingSchedule) {
    try {
      const iso = computeScheduledAtIso(
        r.scheduled_date,
        r.scheduled_time,
        r.created_at,
      );
      updSched.run(iso, r.id);
    } catch {
      updSched.run(new Date(r.created_at).toISOString(), r.id);
    }
  }

  const needClosedMeta = db
    .prepare(`
      SELECT id, created_at FROM scrim_posts
      WHERE status != 'active' AND (closed_at IS NULL OR closed_at = '')
    `)
    .all();
  const updClosed = db.prepare(`
    UPDATE scrim_posts
    SET closed_at = ?,
        closed_reason = COALESCE(closed_reason, 'legacy')
    WHERE id = ?
  `);
  for (const r of needClosedMeta) {
    updClosed.run(new Date(r.created_at).toISOString(), r.id);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scrim_posts_expire
      ON scrim_posts (status, scheduled_at);
  `);
}

/**
 * Réassigne des scrim_public_id pour les lignes actives en doublon (avant index unique partiel).
 * @param {import('better-sqlite3').Database} db
 */
function migrateFixDuplicateActivePublicIds(db) {
  const dupGroups = db
    .prepare(`
      SELECT scrim_public_id FROM scrim_posts
      WHERE status = 'active' AND scrim_public_id IS NOT NULL
      GROUP BY scrim_public_id
      HAVING COUNT(*) > 1
    `)
    .all();

  if (dupGroups.length === 0) return;

  logger.warn('Migration SQLite — correction doublons scrim_public_id (scrims actifs)', {
    duplicate_group_count: dupGroups.length,
  });

  const trx = db.transaction(() => {
    const activeRows = db
      .prepare(`
        SELECT id, scrim_public_id FROM scrim_posts
        WHERE status = 'active' AND scrim_public_id IS NOT NULL
      `)
      .all();
    /** @type {Set<number>} */
    const used = new Set(activeRows.map((r) => Number(r.scrim_public_id)));

    const takeFree = () => {
      for (let i = 1; i <= 999; i += 1) {
        if (!used.has(i)) {
          used.add(i);
          return i;
        }
      }
      return null;
    };

    const updatePublic = db.prepare(
      `UPDATE scrim_posts SET scrim_public_id = ? WHERE id = ?`,
    );
    const rowsForPublic = db.prepare(`
      SELECT id FROM scrim_posts
      WHERE status = 'active' AND scrim_public_id = ?
      ORDER BY id ASC
    `);

    for (const { scrim_public_id } of dupGroups) {
      const pid = Number(scrim_public_id);
      const rows = rowsForPublic.all(pid);
      for (let i = 1; i < rows.length; i += 1) {
        const free = takeFree();
        if (free == null) {
          throw new Error(
            'Migration: pool scrim_public_id (1–999) épuisé — impossible de résoudre les doublons actifs. Libère des recherches actives puis redémarre.',
          );
        }
        updatePublic.run(free, rows[i].id);
        logger.info('Migration SQLite — scrim_public_id réassigné', {
          scrim_post_id: rows[i].id,
          previous_public_id: pid,
          new_public_id: free,
        });
      }
    }
  });

  trx();
}

/**
 * Unicité forte : une seule ligne `active` par scrim_public_id.
 * @param {import('better-sqlite3').Database} db
 */
function migrateUniqueActiveScrimPublicIdIndex(db) {
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scrim_posts_public_id_active_unique
      ON scrim_posts (scrim_public_id)
      WHERE status = 'active' AND scrim_public_id IS NOT NULL;
    `);
    logger.info('Migration SQLite', {
      change: 'idx_scrim_posts_public_id_active_unique',
      action: 'CREATE_UNIQUE_INDEX_PARTIAL',
    });
  } catch (err) {
    logger.error('Migration idx_scrim_posts_public_id_active_unique', {
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Fin de créneau optionnelle (ISO UTC) pour horaire flexible — nullable, idempotent.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsScheduledAtEnd(db) {
  if (tableHasColumn(db, 'scrim_posts', 'scheduled_at_end')) return;
  db.exec(`ALTER TABLE scrim_posts ADD COLUMN scheduled_at_end TEXT`);
  logger.info('Migration SQLite', {
    change: 'scrim_posts.scheduled_at_end',
    action: 'ADD_COLUMN',
  });
}

/**
 * Marquage Discord-supprimé sur scrim_post_messages.
 * Permet aux workflows suivants de savoir qu'un message a déjà été supprimé
 * par la policy de suppression automatique, et d'éviter les 10008 inutiles.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostMessagesDiscordDeleted(db) {
  if (!tableHasColumn(db, 'scrim_post_messages', 'discord_deleted_at')) {
    db.exec(`ALTER TABLE scrim_post_messages ADD COLUMN discord_deleted_at TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_post_messages.discord_deleted_at',
      action: 'ADD_COLUMN',
    });
  }
}

/**
 * Structure partenaire : guild_id + snapshot du nom + snapshot du lien d'invitation.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsStructure(db) {
  if (!tableHasColumn(db, 'scrim_posts', 'structure_guild_id')) {
    db.exec(`ALTER TABLE scrim_posts ADD COLUMN structure_guild_id TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_posts.structure_guild_id',
      action: 'ADD_COLUMN',
    });
  }
  if (!tableHasColumn(db, 'scrim_posts', 'structure_name_snapshot')) {
    db.exec(`ALTER TABLE scrim_posts ADD COLUMN structure_name_snapshot TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_posts.structure_name_snapshot',
      action: 'ADD_COLUMN',
    });
  }
  if (!tableHasColumn(db, 'scrim_posts', 'structure_invite_url_snapshot')) {
    db.exec(`ALTER TABLE scrim_posts ADD COLUMN structure_invite_url_snapshot TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_posts.structure_invite_url_snapshot',
      action: 'ADD_COLUMN',
    });
  }
}

/**
 * Précision d'élo (Low / High / tranches LP) — nullable, idempotent.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsEloPrecision(db) {
  if (tableHasColumn(db, 'scrim_posts', 'elo_precision')) return;
  db.exec(`ALTER TABLE scrim_posts ADD COLUMN elo_precision TEXT`);
  logger.info('Migration SQLite', {
    change: 'scrim_posts.elo_precision',
    action: 'ADD_COLUMN',
  });
}

/**
 * Liens d'invitation Discord configurés par les structures partenaires (idempotent).
 * @param {import('better-sqlite3').Database} db
 */
function migrateStructureDiscordLinks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS structure_discord_links (
      guild_id    TEXT PRIMARY KEY NOT NULL,
      discord_invite_url TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      updated_by  TEXT NOT NULL
    )
  `);
  logger.info('Migration SQLite', {
    change: 'structure_discord_links',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Snapshot du nom d'affichage Discord du contact (stable, indépendant du serveur destinataire).
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsContactDisplayName(db) {
  if (!tableHasColumn(db, 'scrim_posts', 'contact_display_name')) {
    db.exec('ALTER TABLE scrim_posts ADD COLUMN contact_display_name TEXT');
    logger.info('Migration SQLite', {
      change: 'scrim_posts.contact_display_name',
      action: 'ADD_COLUMN',
    });
  }
}

/**
 * Repost automatique : ancre temporelle + compteur (idempotent).
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimPostsRepost(db) {
  if (!tableHasColumn(db, 'scrim_posts', 'last_repost_at')) {
    db.exec(`ALTER TABLE scrim_posts ADD COLUMN last_repost_at TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_posts.last_repost_at',
      action: 'ADD_COLUMN',
    });
  }
  if (!tableHasColumn(db, 'scrim_posts', 'repost_count')) {
    db.exec(
      `ALTER TABLE scrim_posts ADD COLUMN repost_count INTEGER NOT NULL DEFAULT 0`,
    );
    logger.info('Migration SQLite', {
      change: 'scrim_posts.repost_count',
      action: 'ADD_COLUMN',
    });
  }
}

const PLAYER_SEARCH_INIT_SQL = `
CREATE TABLE IF NOT EXISTS player_search_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_search_public_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  origin_guild_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  ranks_json TEXT NOT NULL,
  player_count INTEGER NOT NULL CHECK(player_count >= 1 AND player_count <= 5),
  session_type TEXT NOT NULL,
  ambiance TEXT NOT NULL,
  description TEXT,
  contact_user_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  scheduled_time TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  scheduled_at_end TEXT,
  tags_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'closed_manual', 'closed_expired')),
  closed_at TEXT,
  closed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_player_search_posts_author_created
  ON player_search_posts (author_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_player_search_posts_expire
  ON player_search_posts (status, scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_search_public_id_active_unique
  ON player_search_posts (player_search_public_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS player_search_post_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_search_post_db_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  UNIQUE (guild_id, channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_pspm_post
  ON player_search_post_messages (player_search_post_db_id);

CREATE TABLE IF NOT EXISTS guild_player_search_channels (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_player_search_usage_channel (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_player_search_permissions (
  guild_id TEXT PRIMARY KEY NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('everyone', 'roles'))
);

CREATE TABLE IF NOT EXISTS guild_player_search_allowed_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_player_search_allowed_roles_guild
  ON guild_player_search_allowed_roles (guild_id);

CREATE TABLE IF NOT EXISTS player_search_message_edit_retries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_search_post_db_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_status TEXT NOT NULL
    CHECK(target_status IN ('closed_manual', 'closed_expired')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  abandoned_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_edit_retry_active_unique
  ON player_search_message_edit_retries (guild_id, channel_id, message_id, target_status)
  WHERE resolved_at IS NULL AND abandoned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ps_edit_retry_due
  ON player_search_message_edit_retries (next_attempt_at)
  WHERE resolved_at IS NULL AND abandoned_at IS NULL;
`;

/**
 * Schéma Recherche Joueur — tables dédiées, additive uniquement.
 * @param {import('better-sqlite3').Database} db
 */
function migratePlayerSearchInit(db) {
  db.exec(PLAYER_SEARCH_INIT_SQL);
  logger.info('Migration SQLite', {
    change: 'player_search_*',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Langue configurée par guilde — additive et idempotente.
 * Aucune ligne créée automatiquement pour les guildes existantes (fallback = français).
 * @param {import('better-sqlite3').Database} db
 */
const GUILD_LANGUAGES_CHECK_7 =
  "language IN ('fr','en','es','de','it','pl','pt')";

function migrateGuildLanguages(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_languages (
      guild_id TEXT PRIMARY KEY NOT NULL,
      language TEXT NOT NULL CHECK(language IN ('fr','en','es','de','it','pl','pt'))
    )
  `);
  logger.info('Migration SQLite', {
    change: 'guild_languages',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Élargit le CHECK guild_languages fr/en → 7 locales (SQLite : rebuild table).
 * Idempotent : no-op si le schéma contient déjà le CHECK 7 locales.
 * Préserve toutes les rows existantes. Aucun await réseau.
 * @param {import('better-sqlite3').Database} db
 */
function migrateGuildLanguagesExpandLocales(db) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guild_languages'`)
    .get();
  const sql = typeof row?.sql === 'string' ? row.sql : '';
  if (!sql) {
    migrateGuildLanguages(db);
    return;
  }
  if (sql.includes("'es'") && sql.includes("'pt'") && sql.includes("'de'")) {
    return;
  }

  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE guild_languages_new (
        guild_id TEXT PRIMARY KEY NOT NULL,
        language TEXT NOT NULL CHECK(${GUILD_LANGUAGES_CHECK_7})
      );
      INSERT INTO guild_languages_new (guild_id, language)
        SELECT guild_id, language FROM guild_languages;
      DROP TABLE guild_languages;
      ALTER TABLE guild_languages_new RENAME TO guild_languages;
    `);
  });
  run();
  logger.info('Migration SQLite', {
    change: 'guild_languages',
    action: 'EXPAND_CHECK_7_LOCALES',
  });
}

/**
 * Phase 3A — shadow persistence des opérations lifecycle scrim (additive, idempotente).
 * Aucun worker / replay au startup en 3A.
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimLifecycleOperations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrim_lifecycle_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scrim_post_db_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      operation_type TEXT NOT NULL
        CHECK(operation_type IN ('lifecycle_edit', 'lifecycle_delete')),
      target_status TEXT,
      priority TEXT NOT NULL DEFAULT 'low'
        CHECK(priority IN ('high', 'low')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'completed', 'failed_terminal', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_slo_status
      ON scrim_lifecycle_operations (status);

    CREATE INDEX IF NOT EXISTS idx_slo_scrim_post
      ON scrim_lifecycle_operations (scrim_post_db_id);

    CREATE INDEX IF NOT EXISTS idx_slo_message
      ON scrim_lifecycle_operations (guild_id, channel_id, message_id);

    CREATE INDEX IF NOT EXISTS idx_slo_created_at
      ON scrim_lifecycle_operations (created_at);
  `);
  logger.info('Migration SQLite', {
    change: 'scrim_lifecycle_operations',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 3B : lien durable retry legacy ↔ shadow lifecycle op (nullable, rétrocompatible).
 * @param {import('better-sqlite3').Database} db
 */
function migrateDiscordEditRetryLifecycleOperationId(db) {
  if (!tableHasColumn(db, 'discord_message_edit_retries', 'lifecycle_operation_id')) {
    db.exec(
      `ALTER TABLE discord_message_edit_retries ADD COLUMN lifecycle_operation_id INTEGER`,
    );
    logger.info('Migration SQLite', {
      change: 'discord_message_edit_retries.lifecycle_operation_id',
      action: 'ADD_COLUMN',
    });
  }
}

/**
 * Phase 3C — champs retry delete sur scrim_lifecycle_operations (additive, idempotente).
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimLifecycleOperationsPhase3c(db) {
  if (!tableHasColumn(db, 'scrim_lifecycle_operations', 'next_attempt_at')) {
    db.exec(`ALTER TABLE scrim_lifecycle_operations ADD COLUMN next_attempt_at TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_lifecycle_operations.next_attempt_at',
      action: 'ADD_COLUMN',
    });
  }
  if (!tableHasColumn(db, 'scrim_lifecycle_operations', 'cancellation_reason')) {
    db.exec(`ALTER TABLE scrim_lifecycle_operations ADD COLUMN cancellation_reason TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_lifecycle_operations.cancellation_reason',
      action: 'ADD_COLUMN',
    });
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slo_delete_due
      ON scrim_lifecycle_operations (operation_type, status, next_attempt_at)
      WHERE operation_type = 'lifecycle_delete'
        AND status IN ('pending', 'processing');
  `);
}

/**
 * Phase 3D — clé idempotente d’orchestration lifecycle (event_key).
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimLifecycleOperationsPhase3d(db) {
  if (!tableHasColumn(db, 'scrim_lifecycle_operations', 'event_key')) {
    db.exec(`ALTER TABLE scrim_lifecycle_operations ADD COLUMN event_key TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_lifecycle_operations.event_key',
      action: 'ADD_COLUMN',
    });
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slo_event_key_unique
      ON scrim_lifecycle_operations (event_key)
      WHERE event_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_slo_recovery_due
      ON scrim_lifecycle_operations (status, created_at)
      WHERE event_key IS NOT NULL
        AND status = 'pending'
        AND next_attempt_at IS NULL;
  `);
}

/**
 * Phase 3E — cycles repost durables (additive, idempotente).
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimRepostCycles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrim_repost_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scrim_post_db_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved'
        CHECK(status IN ('reserved', 'broadcasting', 'broadcast_done', 'finalized', 'cancelled', 'failed')),
      old_messages_json TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(scrim_post_db_id, generation),
      UNIQUE(event_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_src_active_scrim
      ON scrim_repost_cycles (scrim_post_db_id)
      WHERE status IN ('reserved', 'broadcasting', 'broadcast_done');

    CREATE INDEX IF NOT EXISTS idx_src_recovery
      ON scrim_repost_cycles (status, updated_at)
      WHERE status IN ('reserved', 'broadcasting', 'broadcast_done');
  `);
  logger.info('Migration SQLite', {
    change: 'scrim_repost_cycles',
    action: 'CREATE_TABLE_IF_NOT_EXISTS',
  });
}

/**
 * Phase 3F — fairness dispatcher lifecycle (additive, idempotente).
 * @param {import('better-sqlite3').Database} db
 */
function migrateScrimLifecycleOperationsPhase3f(db) {
  if (!tableHasColumn(db, 'scrim_lifecycle_operations', 'last_dispatched_at')) {
    db.exec(`ALTER TABLE scrim_lifecycle_operations ADD COLUMN last_dispatched_at TEXT`);
    logger.info('Migration SQLite', {
      change: 'scrim_lifecycle_operations.last_dispatched_at',
      action: 'ADD_COLUMN',
    });
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_slo_dispatcher_due
      ON scrim_lifecycle_operations (status, last_dispatched_at, created_at)
      WHERE status = 'pending';
  `);
}

/**
 * Curseur round-robin des logos partenaires du dashboard réseau (singleton).
 * Idempotent : CREATE IF NOT EXISTS + INSERT OR IGNORE de la ligne id=1.
 * @param {import('better-sqlite3').Database} db
 */
function migrateNetworkDashboardRotation(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_dashboard_rotation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      partner_rotation_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO network_dashboard_rotation (id, partner_rotation_offset, updated_at)
    VALUES (1, 0, ?)
  `).run(new Date().toISOString());
}

/**
 * Guilds partenaires masquées de la page publique /network uniquement.
 * N’affecte ni guild_game_channels ni le dashboard Discord.
 * Idempotent : CREATE TABLE IF NOT EXISTS.
 * @param {import('better-sqlite3').Database} db
 */
function migrateNetworkPublicExclusions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS network_public_exclusions (
      guild_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      reason TEXT
    );
  `);
}

export function getDb() {
  if (dbInstance) return dbInstance;
  const dbPath = resolveDbPath();
  ensureDirSync(dbPath);
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  // Attente max (ms) si la base est brièvement verrouillée (ex. backup). Réduit les SQLITE_BUSY immédiats.
  dbInstance.pragma('busy_timeout = 5000');
  dbInstance.pragma('foreign_keys = ON');
  // Une seule instance du bot doit écrire dans ce fichier SQLite (pas de multi-instance partagée sans autre couche).
  dbInstance.exec(INIT_SQL);
  migrateDropLegacyUserCooldowns(dbInstance);
  migrateScrimPostsMultiOpggUrl(dbInstance);
  migrateScrimPostsLifecycle(dbInstance);
  migrateFixDuplicateActivePublicIds(dbInstance);
  migrateUniqueActiveScrimPublicIdIndex(dbInstance);
  migrateScrimPostsScheduledAtEnd(dbInstance);
  migrateScrimPostsContactDisplayName(dbInstance);
  migrateScrimPostsRepost(dbInstance);
  migrateScrimPostMessagesDiscordDeleted(dbInstance);
  migrateScrimPostsStructure(dbInstance);
  migrateScrimPostsEloPrecision(dbInstance);
  migrateStructureDiscordLinks(dbInstance);
  migratePlayerSearchInit(dbInstance);
  migrateGuildLanguages(dbInstance);
  migrateGuildLanguagesExpandLocales(dbInstance);
  migrateScrimLifecycleOperations(dbInstance);
  migrateDiscordEditRetryLifecycleOperationId(dbInstance);
  migrateScrimLifecycleOperationsPhase3c(dbInstance);
  migrateScrimLifecycleOperationsPhase3d(dbInstance);
  migrateScrimRepostCycles(dbInstance);
  migrateScrimLifecycleOperationsPhase3f(dbInstance);
  migrateNetworkDashboardRotation(dbInstance);
  migrateNetworkPublicExclusions(dbInstance);
  logger.info(
    'SQLite initialisée : mode WAL, busy_timeout=5000 ms. Une seule instance writer attendue sur ce fichier.',
    { path: dbPath, busy_timeout_ms: 5000, journal_mode: 'WAL' },
  );
  return dbInstance;
}

/**
 * Ferme la connexion SQLite si elle est ouverte (idempotent côté appel : sans instance, no-op).
 * Ne lève pas : les erreurs sont journalisées.
 */
export function closeDb() {
  if (!dbInstance) return;
  const closedPath = resolveDbPath();
  try {
    dbInstance.close();
    try {
      logger.info('Connexion SQLite fermée', { path: closedPath });
    } catch {
      /* ignore */
    }
  } catch (err) {
    try {
      logger.error('Erreur lors de la fermeture SQLite', {
        path: closedPath,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } catch {
      /* ignore */
    }
  } finally {
    dbInstance = null;
  }
}

/** @param {import('better-sqlite3').Database} db */
export function prepareStatements(db) {
  return {
    upsertGuildChannel: db.prepare(`
      INSERT INTO guild_game_channels (guild_id, channel_id, game_key, created_at)
      VALUES (@guild_id, @channel_id, @game_key, @created_at)
      ON CONFLICT(guild_id, game_key) DO UPDATE SET
        channel_id = excluded.channel_id,
        created_at = excluded.created_at
    `),
    deleteGuildChannel: db.prepare(`
      DELETE FROM guild_game_channels
      WHERE guild_id = ? AND game_key = ?
    `),
    /** Retire une destination par guild_id + channel_id (salon supprimé / nettoyage admin). */
    deleteGuildChannelByChannelId: db.prepare(`
      DELETE FROM guild_game_channels
      WHERE guild_id = ? AND channel_id = ?
    `),
    getGuildGameChannelByChannelId: db.prepare(`
      SELECT guild_id, channel_id, game_key, created_at
      FROM guild_game_channels
      WHERE guild_id = ? AND channel_id = ?
      LIMIT 1
    `),
    listChannelsByGame: db.prepare(`
      SELECT guild_id, channel_id FROM guild_game_channels
      WHERE game_key = ?
    `),
    countGuildGameChannels: db.prepare(`
      SELECT COUNT(*) AS n FROM guild_game_channels
    `),
    listGuildGameChannelsRecent: db.prepare(`
      SELECT guild_id, channel_id, game_key, created_at
      FROM guild_game_channels
      ORDER BY created_at DESC
      LIMIT ?
    `),
    /** Dernière création (ligne la plus récente par `created_at`), tous statuts — base du cooldown court entre créations. */
    getLatestScrimCreationByAuthor: db.prepare(`
      SELECT created_at
      FROM scrim_posts
      WHERE author_user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `),
    /** Créations dont `created_at` tombe dans la fenêtre glissante (tous statuts) — limite « N créations sur M minutes ». */
    countScrimCreationsInWindowByAuthor: db.prepare(`
      SELECT COUNT(*) AS n
      FROM scrim_posts
      WHERE author_user_id = ? AND created_at >= ?
    `),
    listRecentScrimPostsByAuthorForModeration: db.prepare(`
      SELECT game_key, created_at, scheduled_at, scheduled_date, scheduled_time
      FROM scrim_posts
      WHERE author_user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `),
    listActiveScrimPostsByAuthor: db.prepare(`
      SELECT scrim_public_id,
        scheduled_date,
        scheduled_time,
        scheduled_at,
        scheduled_at_end,
        rank_key,
        format_key,
        created_at,
        game_key,
        elo_precision
      FROM scrim_posts
      WHERE author_user_id = ? AND status = 'active'
      ORDER BY created_at DESC
    `),
    countActiveScrimPostsByAuthor: db.prepare(`
      SELECT COUNT(*) AS n
      FROM scrim_posts
      WHERE author_user_id = ? AND status = 'active'
    `),
    checkRecentSpamReport: db.prepare(`
      SELECT id
      FROM scrim_spam_reports
      WHERE reporter_user_id = ? AND target_user_id = ? AND created_at >= ?
      LIMIT 1
    `),
    insertSpamReport: db.prepare(`
      INSERT INTO scrim_spam_reports (
        guild_id, reporter_user_id, target_user_id, created_at
      ) VALUES (?, ?, ?, ?)
    `),
    getGlobalBlacklistEntry: db.prepare(`
      SELECT user_id, expires_at, reason, created_at, created_by
      FROM global_blacklisted_users
      WHERE user_id = ?
    `),
    upsertGlobalBlacklist: db.prepare(`
      INSERT INTO global_blacklisted_users (
        user_id, expires_at, reason, created_at, created_by
      ) VALUES (
        @user_id, @expires_at, @reason, @created_at, @created_by
      )
      ON CONFLICT(user_id) DO UPDATE SET
        expires_at = excluded.expires_at,
        reason = excluded.reason,
        created_at = excluded.created_at,
        created_by = excluded.created_by
    `),
    deleteGlobalBlacklistUser: db.prepare(`
      DELETE FROM global_blacklisted_users WHERE user_id = ?
    `),
    isUserBlocked: db.prepare(`
      SELECT 1 AS ok FROM guild_blocked_users
      WHERE guild_id = ? AND user_id = ?
      LIMIT 1
    `),
    blockUser: db.prepare(`
      INSERT INTO guild_blocked_users (guild_id, user_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO NOTHING
    `),
    unblockUser: db.prepare(`
      DELETE FROM guild_blocked_users
      WHERE guild_id = ? AND user_id = ?
    `),
    insertScrimPostRow: db.prepare(`
      INSERT INTO scrim_posts (
        scrim_public_id, author_user_id, origin_guild_id, source_guild_id,
        game_key, rank_key, format_key, contact_user_id, contact_display_name,
        scheduled_date, scheduled_time, scheduled_at, scheduled_at_end, tags, multi_opgg_url,
        elo_precision,
        structure_guild_id, structure_name_snapshot, structure_invite_url_snapshot,
        created_at, status, closed_at, closed_reason
      ) VALUES (
        @scrim_public_id, @author_user_id, @origin_guild_id, @source_guild_id,
        @game_key, @rank_key, @format_key, @contact_user_id, @contact_display_name,
        @scheduled_date, @scheduled_time, @scheduled_at, @scheduled_at_end, @tags, @multi_opgg_url,
        @elo_precision,
        @structure_guild_id, @structure_name_snapshot, @structure_invite_url_snapshot,
        @created_at, @status, NULL, NULL
      )
    `),
    listActiveScrimPublicIds: db.prepare(`
      SELECT scrim_public_id FROM scrim_posts WHERE status = 'active'
    `),
    /** Lecture seule — nombre de lignes scrim actives (tous auteurs). */
    countActiveScrimPosts: db.prepare(`
      SELECT COUNT(*) AS n
      FROM scrim_posts
      WHERE status = 'active'
    `),
    getScrimPostById: db.prepare(`
      SELECT * FROM scrim_posts WHERE id = ?
    `),
    getScrimPostActiveByPublicId: db.prepare(`
      SELECT * FROM scrim_posts
      WHERE scrim_public_id = ? AND status = 'active'
    `),
    getScrimPostByPublicIdAny: db.prepare(`
      SELECT * FROM scrim_posts WHERE scrim_public_id = ? LIMIT 1
    `),
    closeScrimPostIfActive: db.prepare(`
      UPDATE scrim_posts
      SET status = @status,
          closed_at = @closed_at,
          closed_reason = @closed_reason
      WHERE id = @id AND status = 'active'
    `),
    findExpiredActiveScrimPosts: db.prepare(`
      SELECT id,
        CASE
          WHEN scheduled_at IS NULL OR scheduled_at = '' THEN 1
          ELSE 0
        END AS missing_schedule
      FROM scrim_posts
      WHERE status = 'active'
        AND (
          scheduled_at IS NULL
          OR scheduled_at = ''
          OR COALESCE(NULLIF(trim(scheduled_at_end), ''), scheduled_at) < @now_iso
        )
    `),
    /**
     * Scrims actifs éligibles au repost : ancre = last_repost_at ou création (ISO depuis created_at ms).
     * Comparaison lexicographique ISO UTC (alignée sur toISOString()).
     */
    findActiveScrimPostsDueForRepost: db.prepare(`
      SELECT id, scrim_public_id, created_at, last_repost_at, repost_count
      FROM scrim_posts
      WHERE status = 'active'
        AND (
          CASE
            WHEN last_repost_at IS NOT NULL AND trim(last_repost_at) != ''
              THEN last_repost_at
            ELSE strftime('%Y-%m-%dT%H:%M:%S.000Z', created_at / 1000, 'unixepoch')
          END
        ) <= @cutoff_iso
      ORDER BY (
        CASE
          WHEN last_repost_at IS NOT NULL AND trim(last_repost_at) != ''
            THEN last_repost_at
          ELSE strftime('%Y-%m-%dT%H:%M:%S.000Z', created_at / 1000, 'unixepoch')
        END
      ) ASC
      LIMIT @max_per_pass
    `),
    recordScrimPostRepostSuccess: db.prepare(`
      UPDATE scrim_posts
      SET last_repost_at = @last_repost_at,
          repost_count = COALESCE(repost_count, 0) + 1
      WHERE id = @id AND status = 'active'
    `),
    recordScrimPostRepostSuccessForGeneration: db.prepare(`
      UPDATE scrim_posts
      SET last_repost_at = @last_repost_at,
          repost_count = COALESCE(repost_count, 0) + 1
      WHERE id = @id
        AND status = 'active'
        AND COALESCE(repost_count, 0) + 1 = @expected_generation
    `),

    insertScrimRepostCycle: db.prepare(`
      INSERT INTO scrim_repost_cycles (
        scrim_post_db_id, generation, event_key, status,
        old_messages_json, success_count, started_at, updated_at
      ) VALUES (
        @scrim_post_db_id, @generation, @event_key, @status,
        @old_messages_json, @success_count, @started_at, @updated_at
      )
    `),
    getScrimRepostCycleById: db.prepare(`
      SELECT * FROM scrim_repost_cycles WHERE id = ?
    `),
    getActiveRepostCycleForScrim: db.prepare(`
      SELECT * FROM scrim_repost_cycles
      WHERE scrim_post_db_id = ?
        AND status IN ('reserved', 'broadcasting', 'broadcast_done')
      LIMIT 1
    `),
    updateScrimRepostCycleStatus: db.prepare(`
      UPDATE scrim_repost_cycles
      SET status = @status,
          success_count = @success_count,
          updated_at = @updated_at,
          completed_at = COALESCE(@completed_at, completed_at)
      WHERE id = @id
    `),
    listIncompleteScrimRepostCycles: db.prepare(`
      SELECT * FROM scrim_repost_cycles
      WHERE status IN ('reserved', 'broadcasting', 'broadcast_done')
      ORDER BY updated_at ASC
      LIMIT 10
    `),
    cancelSupersedeLifecycleOpsForGeneration: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'cancelled',
          completed_at = @completed_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE scrim_post_db_id = @scrim_post_db_id
        AND event_key LIKE @event_key_like
        AND status IN ('pending', 'processing')
    `),
    insertScrimPostMessage: db.prepare(`
      INSERT INTO scrim_post_messages (
        scrim_post_db_id, guild_id, channel_id, message_id
      ) VALUES (
        @scrim_post_db_id, @guild_id, @channel_id, @message_id
      )
    `),
    listScrimPostMessagesByPostId: db.prepare(`
      SELECT guild_id, channel_id, message_id
      FROM scrim_post_messages
      WHERE scrim_post_db_id = ?
    `),
    /** Message scrim posté sur une guilde (lien « Voir le message »). */
    getScrimPostMessageForGuild: db.prepare(`
      SELECT channel_id, message_id
      FROM scrim_post_messages
      WHERE scrim_post_db_id = ? AND guild_id = ?
      ORDER BY id DESC
      LIMIT 1
    `),
    deleteScrimPostMessagesForPost: db.prepare(`
      DELETE FROM scrim_post_messages WHERE scrim_post_db_id = ?
    `),
    /**
     * Marque un message scrim comme supprimé côté Discord.
     * Utilisé par la policy de suppression pour éviter les 10008 en cascade.
     */
    markScrimPostMessageDiscordDeleted: db.prepare(`
      UPDATE scrim_post_messages
      SET discord_deleted_at = @discord_deleted_at
      WHERE guild_id = @guild_id AND channel_id = @channel_id AND message_id = @message_id
        AND discord_deleted_at IS NULL
    `),
    /**
     * Vérifie si un message scrim est déjà marqué supprimé côté Discord.
     * Retourne une ligne (truthy) ou undefined.
     */
    isScrimPostMessageDiscordDeleted: db.prepare(`
      SELECT 1 FROM scrim_post_messages
      WHERE guild_id = ? AND channel_id = ? AND message_id = ?
        AND discord_deleted_at IS NOT NULL
      LIMIT 1
    `),
    deleteScrimPostById: db.prepare(`
      DELETE FROM scrim_posts WHERE id = ?
    `),

    getScrimUsageChannel: db.prepare(`
      SELECT channel_id FROM guild_scrim_usage_channel WHERE guild_id = ?
    `),
    upsertScrimUsageChannel: db.prepare(`
      INSERT INTO guild_scrim_usage_channel (guild_id, channel_id)
      VALUES (@guild_id, @channel_id)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id
    `),
    deleteScrimUsageChannel: db.prepare(`
      DELETE FROM guild_scrim_usage_channel WHERE guild_id = ?
    `),
    getScrimPermissionMode: db.prepare(`
      SELECT mode FROM guild_scrim_permissions WHERE guild_id = ?
    `),
    upsertScrimPermissionMode: db.prepare(`
      INSERT INTO guild_scrim_permissions (guild_id, mode)
      VALUES (@guild_id, @mode)
      ON CONFLICT(guild_id) DO UPDATE SET mode = excluded.mode
    `),
    deleteScrimAllowedRoles: db.prepare(`
      DELETE FROM guild_scrim_allowed_roles WHERE guild_id = ?
    `),
    insertScrimAllowedRole: db.prepare(`
      INSERT INTO guild_scrim_allowed_roles (guild_id, role_id)
      VALUES (?, ?)
      ON CONFLICT(guild_id, role_id) DO NOTHING
    `),
    listScrimAllowedRoles: db.prepare(`
      SELECT role_id FROM guild_scrim_allowed_roles WHERE guild_id = ?
    `),
    deleteScrimAllowedRole: db.prepare(`
      DELETE FROM guild_scrim_allowed_roles
      WHERE guild_id = ? AND role_id = ?
    `),

    getPendingDiscordEditRetry: db.prepare(`
      SELECT * FROM discord_message_edit_retries
      WHERE guild_id = ? AND channel_id = ? AND message_id = ? AND target_status = ?
        AND resolved_at IS NULL AND abandoned_at IS NULL
      LIMIT 1
    `),
    insertDiscordEditRetry: db.prepare(`
      INSERT INTO discord_message_edit_retries (
        scrim_post_db_id, guild_id, channel_id, message_id, target_status,
        attempt_count, next_attempt_at, last_error_code, last_error_message,
        payload_json, lifecycle_operation_id, created_at, updated_at
      ) VALUES (
        @scrim_post_db_id, @guild_id, @channel_id, @message_id, @target_status,
        @attempt_count, @next_attempt_at, @last_error_code, @last_error_message,
        @payload_json, @lifecycle_operation_id, @created_at, @updated_at
      )
    `),
    updateDiscordEditRetryPendingRefresh: db.prepare(`
      UPDATE discord_message_edit_retries
      SET payload_json = @payload_json,
          attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          lifecycle_operation_id = @lifecycle_operation_id,
          updated_at = @updated_at
      WHERE id = @id
    `),
    listActiveDiscordEditRetriesForScrimPost: db.prepare(`
      SELECT * FROM discord_message_edit_retries
      WHERE scrim_post_db_id = ?
        AND resolved_at IS NULL AND abandoned_at IS NULL
    `),
    listActiveDiscordEditRetriesForMessage: db.prepare(`
      SELECT * FROM discord_message_edit_retries
      WHERE guild_id = ? AND channel_id = ? AND message_id = ?
        AND resolved_at IS NULL AND abandoned_at IS NULL
    `),
    updateDiscordEditRetryAfterFailure: db.prepare(`
      UPDATE discord_message_edit_retries
      SET attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id
    `),
    markDiscordEditRetryResolved: db.prepare(`
      UPDATE discord_message_edit_retries
      SET resolved_at = @resolved_at,
          updated_at = @updated_at
      WHERE id = @id
    `),
    markDiscordEditRetryAbandoned: db.prepare(`
      UPDATE discord_message_edit_retries
      SET abandoned_at = @abandoned_at,
          updated_at = @updated_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message
      WHERE id = @id
    `),
    listDueDiscordEditRetries: db.prepare(`
      SELECT r.* FROM discord_message_edit_retries r
      WHERE r.resolved_at IS NULL AND r.abandoned_at IS NULL
        AND r.next_attempt_at <= @now_iso
        AND (
          r.lifecycle_operation_id IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM scrim_lifecycle_operations slo
            WHERE slo.id = r.lifecycle_operation_id
              AND slo.event_key IS NOT NULL
          )
        )
      ORDER BY r.next_attempt_at ASC
      LIMIT 25
    `),
    countPendingDiscordEditRetries: db.prepare(`
      SELECT COUNT(*) AS n
      FROM discord_message_edit_retries
      WHERE resolved_at IS NULL AND abandoned_at IS NULL
    `),

    createScrimLifecycleOperation: db.prepare(`
      INSERT INTO scrim_lifecycle_operations (
        scrim_post_db_id, guild_id, channel_id, message_id,
        operation_type, target_status, priority, status,
        attempt_count, payload_json, created_at, updated_at
      ) VALUES (
        @scrim_post_db_id, @guild_id, @channel_id, @message_id,
        @operation_type, @target_status, @priority, 'pending',
        0, @payload_json, @created_at, @updated_at
      )
    `),
    insertOrchestratedScrimLifecycleOperation: db.prepare(`
      INSERT OR IGNORE INTO scrim_lifecycle_operations (
        scrim_post_db_id, guild_id, channel_id, message_id,
        operation_type, target_status, priority, status,
        attempt_count, payload_json, event_key, created_at, updated_at
      ) VALUES (
        @scrim_post_db_id, @guild_id, @channel_id, @message_id,
        @operation_type, @target_status, @priority, 'pending',
        0, @payload_json, @event_key, @created_at, @updated_at
      )
    `),
    getScrimLifecycleOperationByEventKey: db.prepare(`
      SELECT * FROM scrim_lifecycle_operations WHERE event_key = ? LIMIT 1
    `),
    listOrchestratedScrimLifecycleOperationsForRecovery: db.prepare(`
      SELECT slo.* FROM scrim_lifecycle_operations slo
      WHERE slo.status = 'pending'
        AND slo.event_key IS NOT NULL
        AND slo.next_attempt_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM discord_message_edit_retries r
          WHERE r.lifecycle_operation_id = slo.id
            AND r.resolved_at IS NULL
            AND r.abandoned_at IS NULL
        )
      ORDER BY slo.created_at ASC
      LIMIT 25
    `),
    recoverOrchestratedScrimLifecycleProcessing: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'pending',
          updated_at = @updated_at
      WHERE event_key IS NOT NULL
        AND status = 'processing'
        AND next_attempt_at IS NULL
    `),
    markScrimLifecycleOperationProcessing: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'processing',
          started_at = COALESCE(started_at, @started_at),
          updated_at = @updated_at
      WHERE id = @id AND status IN ('pending', 'processing')
    `),
    markScrimLifecycleOperationCompleted: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'completed',
          completed_at = @completed_at,
          updated_at = @updated_at
      WHERE id = @id AND status IN ('pending', 'processing')
    `),
    markScrimLifecycleOperationFailedTerminal: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'failed_terminal',
          completed_at = @completed_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id AND status NOT IN ('completed', 'cancelled')
    `),
    markScrimLifecycleOperationCancelled: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'cancelled',
          completed_at = @completed_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id AND status IN ('pending', 'processing')
    `),
    resetScrimLifecycleOperationPending: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'pending',
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id AND status IN ('pending', 'processing')
    `),
    getScrimLifecycleOperationById: db.prepare(`
      SELECT * FROM scrim_lifecycle_operations WHERE id = ?
    `),

    listDueScrimLifecycleDeleteOperations: db.prepare(`
      SELECT * FROM scrim_lifecycle_operations
      WHERE operation_type = 'lifecycle_delete'
        AND status = 'pending'
        AND next_attempt_at IS NOT NULL
        AND next_attempt_at <= @now_iso
      ORDER BY next_attempt_at ASC
      LIMIT 25
    `),
    scheduleScrimLifecycleDeleteRetry: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'pending',
          attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id
        AND operation_type = 'lifecycle_delete'
        AND status IN ('pending', 'processing')
    `),
    recoverScrimLifecycleDeleteProcessing: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'pending',
          next_attempt_at = @next_attempt_at,
          updated_at = @updated_at
      WHERE operation_type = 'lifecycle_delete'
        AND status = 'processing'
    `),
    countPendingScrimLifecycleDeleteOperations: db.prepare(`
      SELECT COUNT(*) AS n
      FROM scrim_lifecycle_operations
      WHERE operation_type = 'lifecycle_delete'
        AND status = 'pending'
        AND next_attempt_at IS NOT NULL
    `),

    listExhaustedPendingScrimLifecycleOperations: db.prepare(`
      SELECT * FROM scrim_lifecycle_operations
      WHERE status IN ('pending', 'processing')
        AND event_key IS NOT NULL
        AND attempt_count >= @max_attempts
    `),
    selectNextScrimLifecycleOperationForDispatcher: db.prepare(`
      SELECT slo.* FROM scrim_lifecycle_operations slo
      WHERE slo.status = 'pending'
        AND slo.event_key IS NOT NULL
        AND slo.attempt_count < @max_attempts
        AND (slo.next_attempt_at IS NULL OR slo.next_attempt_at <= @now_iso)
        AND NOT EXISTS (
          SELECT 1 FROM discord_message_edit_retries r
          WHERE r.lifecycle_operation_id = slo.id
            AND r.resolved_at IS NULL
            AND r.abandoned_at IS NULL
        )
      ORDER BY
        CASE
          WHEN slo.target_status IN ('closed_manual', 'closed_expired') THEN 0
          WHEN slo.operation_type = 'lifecycle_delete' THEN 0
          WHEN (
            slo.target_status = 'superseded_repost' OR slo.priority = 'low'
          )
          AND CAST(
            (julianday(@now_iso) - julianday(COALESCE(slo.created_at, '1970-01-01T00:00:00.000Z')))
            * 86400000 AS INTEGER
          ) >= @starvation_threshold_ms THEN 1
          WHEN slo.target_status = 'superseded_repost' THEN 2
          ELSE 3
        END ASC,
        CASE WHEN slo.priority = 'high' THEN 0 ELSE 1 END ASC,
        COALESCE(slo.last_dispatched_at, slo.created_at) ASC,
        slo.created_at ASC
      LIMIT 1
    `),
    countStarvedPendingScrimLifecycleOperations: db.prepare(`
      SELECT COUNT(*) AS n
      FROM scrim_lifecycle_operations slo
      WHERE slo.status = 'pending'
        AND slo.event_key IS NOT NULL
        AND slo.attempt_count < @max_attempts
        AND (slo.next_attempt_at IS NULL OR slo.next_attempt_at <= @now_iso)
        AND NOT EXISTS (
          SELECT 1 FROM discord_message_edit_retries r
          WHERE r.lifecycle_operation_id = slo.id
            AND r.resolved_at IS NULL
            AND r.abandoned_at IS NULL
        )
        AND slo.target_status NOT IN ('closed_manual', 'closed_expired')
        AND slo.operation_type != 'lifecycle_delete'
        AND (
          slo.target_status = 'superseded_repost' OR slo.priority = 'low'
        )
        AND CAST(
          (julianday(@now_iso) - julianday(COALESCE(slo.created_at, '1970-01-01T00:00:00.000Z')))
          * 86400000 AS INTEGER
        ) >= @starvation_threshold_ms
    `),
    selectNextStarvedScrimLifecycleOperationForDispatcher: db.prepare(`
      SELECT slo.* FROM scrim_lifecycle_operations slo
      WHERE slo.status = 'pending'
        AND slo.event_key IS NOT NULL
        AND slo.attempt_count < @max_attempts
        AND (slo.next_attempt_at IS NULL OR slo.next_attempt_at <= @now_iso)
        AND NOT EXISTS (
          SELECT 1 FROM discord_message_edit_retries r
          WHERE r.lifecycle_operation_id = slo.id
            AND r.resolved_at IS NULL
            AND r.abandoned_at IS NULL
        )
        AND slo.target_status NOT IN ('closed_manual', 'closed_expired')
        AND slo.operation_type != 'lifecycle_delete'
        AND (
          slo.target_status = 'superseded_repost' OR slo.priority = 'low'
        )
        AND CAST(
          (julianday(@now_iso) - julianday(COALESCE(slo.created_at, '1970-01-01T00:00:00.000Z')))
          * 86400000 AS INTEGER
        ) >= @starvation_threshold_ms
      ORDER BY COALESCE(slo.last_dispatched_at, slo.created_at) ASC, slo.created_at ASC
      LIMIT 1
    `),
    claimScrimLifecycleOperationForDispatcher: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, @started_at),
          last_dispatched_at = @last_dispatched_at,
          updated_at = @updated_at
      WHERE id = @id AND status = 'pending'
    `),
    scheduleScrimLifecycleEditRetry: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'pending',
          attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id
        AND operation_type = 'lifecycle_edit'
        AND status IN ('pending', 'processing')
    `),
    recoverScrimLifecycleDispatcherProcessing: db.prepare(`
      UPDATE scrim_lifecycle_operations
      SET status = 'pending',
          updated_at = @updated_at,
          next_attempt_at = COALESCE(next_attempt_at, @now_iso)
      WHERE status = 'processing'
        AND event_key IS NOT NULL
    `),
    countScrimLifecycleOperationsProcessing: db.prepare(`
      SELECT COUNT(*) AS n FROM scrim_lifecycle_operations WHERE status = 'processing'
    `),
    countScrimLifecycleOperationsPendingDue: db.prepare(`
      SELECT COUNT(*) AS n FROM scrim_lifecycle_operations
      WHERE status = 'pending'
        AND event_key IS NOT NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= @now_iso)
    `),

    getGuildScrimReceptionBypass: db.prepare(`
      SELECT guild_id, bypass_member_minimum, updated_by, updated_at, note
      FROM guild_scrim_reception_bypass
      WHERE guild_id = ?
      LIMIT 1
    `),
    upsertGuildScrimReceptionBypass: db.prepare(`
      INSERT INTO guild_scrim_reception_bypass (
        guild_id, bypass_member_minimum, updated_by, updated_at, note
      ) VALUES (
        @guild_id, @bypass_member_minimum, @updated_by, @updated_at, @note
      )
      ON CONFLICT(guild_id) DO UPDATE SET
        bypass_member_minimum = excluded.bypass_member_minimum,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        note = excluded.note
    `),
    deleteGuildScrimReceptionBypass: db.prepare(`
      DELETE FROM guild_scrim_reception_bypass WHERE guild_id = ?
    `),
    listGuildScrimReceptionBypassesRecent: db.prepare(`
      SELECT guild_id, bypass_member_minimum, updated_by, updated_at, note
      FROM guild_scrim_reception_bypass
      ORDER BY updated_at DESC
      LIMIT 50
    `),

    getScrimMessageLifecyclePolicy: db.prepare(`
      SELECT policy FROM guild_scrim_message_lifecycle_policy WHERE guild_id = ?
    `),
    upsertScrimMessageLifecyclePolicy: db.prepare(`
      INSERT INTO guild_scrim_message_lifecycle_policy (guild_id, policy, updated_at)
      VALUES (@guild_id, @policy, @updated_at)
      ON CONFLICT(guild_id) DO UPDATE SET
        policy = excluded.policy,
        updated_at = excluded.updated_at
    `),
    deleteScrimMessageLifecyclePolicy: db.prepare(`
      DELETE FROM guild_scrim_message_lifecycle_policy WHERE guild_id = ?
    `),
    /** Salon de réception scrim pour une guilde + jeu précis (lecture pour vérif permissions). */
    getGuildGameChannel: db.prepare(`
      SELECT channel_id FROM guild_game_channels WHERE guild_id = ? AND game_key = ?
    `),

    /** Dashboard réseau : nombre de guildes distinctes avec au moins un salon scrim. */
    countDistinctPartnerGuilds: db.prepare(`
      SELECT COUNT(DISTINCT guild_id) AS n FROM guild_game_channels
    `),
    /** Dashboard réseau : liste de tous les guild_id distincts ayant un salon scrim. */
    listDistinctPartnerGuildIds: db.prepare(`
      SELECT DISTINCT guild_id FROM guild_game_channels ORDER BY guild_id
    `),
    /** Structure partenaire : vérifie qu'un guild_id a bien un salon scrim configuré. */
    getPartnerGuildByGuildId: db.prepare(`
      SELECT guild_id FROM guild_game_channels WHERE guild_id = ? LIMIT 1
    `),
    /** Lien d'invitation Discord configuré pour une structure partenaire. */
    getStructureDiscordLink: db.prepare(`
      SELECT discord_invite_url FROM structure_discord_links WHERE guild_id = ?
    `),
    /** Enregistre ou met à jour le lien d'invitation Discord d'une structure partenaire. */
    upsertStructureDiscordLink: db.prepare(`
      INSERT INTO structure_discord_links (guild_id, discord_invite_url, updated_at, updated_by)
      VALUES (@guild_id, @discord_invite_url, @updated_at, @updated_by)
      ON CONFLICT(guild_id) DO UPDATE SET
        discord_invite_url = excluded.discord_invite_url,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `),
    /** Supprime le lien d'invitation Discord d'une structure partenaire. */
    deleteStructureDiscordLink: db.prepare(`
      DELETE FROM structure_discord_links WHERE guild_id = ?
    `),

    /** Dashboard réseau : tous les dashboards configurés. */
    getAllNetworkDashboards: db.prepare(`
      SELECT id, guild_id, channel_id, message_id, created_by, updated_at
      FROM network_dashboard_config
      ORDER BY updated_at DESC
    `),
    /** Dashboard réseau : upsert d'un dashboard (guild_id + channel_id unique). */
    upsertNetworkDashboard: db.prepare(`
      INSERT INTO network_dashboard_config (guild_id, channel_id, message_id, created_by, updated_at)
      VALUES (@guild_id, @channel_id, @message_id, @created_by, @updated_at)
      ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `),
    /** Dashboard réseau : mise à jour du message_id et updated_at après (re)création. */
    updateNetworkDashboardMessageId: db.prepare(`
      UPDATE network_dashboard_config
      SET message_id = @message_id, updated_at = @updated_at
      WHERE guild_id = @guild_id AND channel_id = @channel_id
    `),
    /** Dashboard réseau : suppression d'un dashboard configuré. */
    deleteNetworkDashboard: db.prepare(`
      DELETE FROM network_dashboard_config WHERE guild_id = ? AND channel_id = ?
    `),

    /** Dashboard réseau : curseur round-robin des logos partenaires (singleton id=1). */
    getNetworkDashboardPartnerOffset: db.prepare(`
      SELECT partner_rotation_offset FROM network_dashboard_rotation WHERE id = 1
    `),
    /** Dashboard réseau : persiste le curseur après un cycle de refresh réussi. */
    setNetworkDashboardPartnerOffset: db.prepare(`
      INSERT INTO network_dashboard_rotation (id, partner_rotation_offset, updated_at)
      VALUES (1, @partner_rotation_offset, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        partner_rotation_offset = excluded.partner_rotation_offset,
        updated_at = excluded.updated_at
    `),

    /** Page publique /network : liste des guild_id exclus du site. */
    listNetworkPublicExclusions: db.prepare(`
      SELECT guild_id, created_at, reason FROM network_public_exclusions ORDER BY guild_id
    `),
    /** Page publique /network : teste si une guild est exclue du site. */
    getNetworkPublicExclusion: db.prepare(`
      SELECT guild_id FROM network_public_exclusions WHERE guild_id = ? LIMIT 1
    `),
    /** Page publique /network : ajoute une exclusion (tests / ops). */
    upsertNetworkPublicExclusion: db.prepare(`
      INSERT INTO network_public_exclusions (guild_id, created_at, reason)
      VALUES (@guild_id, @created_at, @reason)
      ON CONFLICT(guild_id) DO UPDATE SET
        reason = excluded.reason
    `),
    /** Page publique /network : retire une exclusion. */
    deleteNetworkPublicExclusion: db.prepare(`
      DELETE FROM network_public_exclusions WHERE guild_id = ?
    `),

    /** Langue configurée pour une guilde (null/undefined si absente → fallback 'fr'). */
    getGuildLanguage: db.prepare(`
      SELECT language FROM guild_languages WHERE guild_id = ? LIMIT 1
    `),
    /** Enregistre ou met à jour la langue d'une guilde. */
    upsertGuildLanguage: db.prepare(`
      INSERT INTO guild_languages (guild_id, language)
      VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET language = excluded.language
    `),

    // === Diffusion persistante (scrim_broadcast_batches + scrim_broadcast_deliveries) ===
    insertScrimBroadcastBatch: db.prepare(`
      INSERT INTO scrim_broadcast_batches
        (scrim_post_db_id, operation_type, generation, status, target_count, created_at, updated_at)
      VALUES
        (@scrim_post_db_id, @operation_type, @generation, 'staging', @target_count, @created_at, @updated_at)
    `),
    updateScrimBroadcastBatchStatus: db.prepare(`
      UPDATE scrim_broadcast_batches
      SET status = @status, updated_at = @updated_at
      WHERE id = @id
    `),
    setScrimBroadcastBatchActive: db.prepare(`
      UPDATE scrim_broadcast_batches
      SET status = 'active', started_at = @started_at, updated_at = @updated_at
      WHERE id = @id AND status = 'staging'
    `),
    setScrimBroadcastBatchCompleted: db.prepare(`
      UPDATE scrim_broadcast_batches
      SET status = @status, completed_at = @completed_at, updated_at = @updated_at
      WHERE id = @id
    `),
    updateScrimBroadcastBatchLastDispatched: db.prepare(`
      UPDATE scrim_broadcast_batches
      SET last_dispatched_at = @last_dispatched_at, updated_at = @updated_at
      WHERE id = @id
    `),
    getScrimBroadcastBatchById: db.prepare(`
      SELECT * FROM scrim_broadcast_batches WHERE id = ?
    `),
    getActiveStagingBatchForScrim: db.prepare(`
      SELECT * FROM scrim_broadcast_batches
      WHERE scrim_post_db_id = ?
        AND operation_type = 'initial'
        AND generation = 0
        AND status IN ('staging','active')
      LIMIT 1
    `),
    listActiveBatchesDueForDispatch: db.prepare(`
      SELECT * FROM scrim_broadcast_batches
      WHERE status = 'active'
      ORDER BY COALESCE(last_dispatched_at, '1970-01-01') ASC, id ASC
    `),
    /**
     * Prochain batch ACTIVE ayant réellement une delivery due (fairness).
     * last_dispatched_at NULL d’abord, puis le plus ancien, tie-break id.
     */
    getNextActiveBatchDueForDispatch: db.prepare(`
      SELECT b.* FROM scrim_broadcast_batches b
      WHERE b.status = 'active'
        AND EXISTS (
          SELECT 1 FROM scrim_broadcast_deliveries d
          WHERE d.batch_id = b.id
            AND d.status IN ('pending','retry')
            AND d.next_attempt_at <= @now_iso
        )
      ORDER BY COALESCE(b.last_dispatched_at, '1970-01-01') ASC, b.id ASC
      LIMIT 1
    `),
    /**
     * Repost : true si un broadcast persistant initial est encore ouvert
     * (batch staging/active ou deliveries exécutables).
     */
    hasOpenPersistentBroadcastForScrim: db.prepare(`
      SELECT 1 AS ok WHERE EXISTS (
        SELECT 1 FROM scrim_broadcast_batches
        WHERE scrim_post_db_id = ?
          AND status IN ('staging','active')
      ) OR EXISTS (
        SELECT 1 FROM scrim_broadcast_deliveries
        WHERE scrim_post_db_id = ?
          AND status IN ('pending','retry','processing')
      )
    `),
    listStagingBatchesForRecovery: db.prepare(`
      SELECT * FROM scrim_broadcast_batches WHERE status = 'staging'
      ORDER BY created_at ASC
    `),
    insertScrimBroadcastDelivery: db.prepare(`
      INSERT INTO scrim_broadcast_deliveries
        (batch_id, scrim_post_db_id, guild_id, channel_id, game_key,
         operation_type, generation, status, priority, attempt_count,
         next_attempt_at, created_at, updated_at)
      VALUES
        (@batch_id, @scrim_post_db_id, @guild_id, @channel_id, @game_key,
         @operation_type, @generation, 'pending', @priority, 0,
         @next_attempt_at, @created_at, @updated_at)
    `),
    /**
     * Claim atomique : utiliser `.get(params)` (pas `.run`).
     * Retourne la ligne exacte claimée, ou `undefined` si aucune due.
     * Ne claim que pending|retry — jamais sent / terminal / cancelled / unknown_outcome.
     */
    claimNextDeliveryForBatch: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'processing', claimed_at = @claimed_at, updated_at = @updated_at
      WHERE id = (
        SELECT id FROM scrim_broadcast_deliveries
        WHERE batch_id = @batch_id
          AND status IN ('pending','retry')
          AND next_attempt_at <= @now_iso
        ORDER BY priority DESC, id ASC
        LIMIT 1
      ) AND status IN ('pending','retry')
      RETURNING *
    `),
    /**
     * Lecture diagnostic uniquement — NE PAS utiliser après un claim pour identifier
     * « la » delivery du worker (ambigu si plusieurs processing). Préférer RETURNING du claim.
     */
    getProcessingDeliveryForBatch: db.prepare(`
      SELECT * FROM scrim_broadcast_deliveries
      WHERE batch_id = ? AND status = 'processing'
      ORDER BY claimed_at DESC
      LIMIT 1
    `),
    getScrimBroadcastDeliveryById: db.prepare(`
      SELECT * FROM scrim_broadcast_deliveries WHERE id = ?
    `),
    getNextDueDeliveryForBatch: db.prepare(`
      SELECT * FROM scrim_broadcast_deliveries
      WHERE batch_id = @batch_id
        AND status IN ('pending','retry')
        AND next_attempt_at <= @now_iso
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `),
    /** Transition processing → sent uniquement. */
    markDeliverySent: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'sent', message_id = @message_id, attempt_count = attempt_count + 1,
          last_error_code = NULL, last_error_message = NULL,
          completed_at = @completed_at, updated_at = @updated_at
      WHERE id = @id AND status = 'processing'
    `),
    /** Transition processing → retry uniquement. */
    markDeliveryRetry: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'retry', attempt_count = attempt_count + 1,
          next_attempt_at = @next_attempt_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          claimed_at = NULL, updated_at = @updated_at
      WHERE id = @id AND status = 'processing'
    `),
    /** Transition processing → failed_terminal uniquement. */
    markDeliveryTerminal: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'failed_terminal', attempt_count = attempt_count + 1,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          completed_at = @completed_at, claimed_at = NULL, updated_at = @updated_at
      WHERE id = @id AND status = 'processing'
    `),
    markDeliveryCancelled: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'cancelled', completed_at = @completed_at, updated_at = @updated_at
      WHERE id = @id AND status IN ('pending','retry','processing')
    `),
    /**
     * Transition processing → unknown_outcome uniquement (terminal soft, pas de resend auto).
     * Ne touche jamais unknown_outcome / sent / etc.
     */
    markDeliveryUnknownOutcome: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'unknown_outcome', attempt_count = attempt_count + 1,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          completed_at = @completed_at, claimed_at = NULL, updated_at = @updated_at
      WHERE id = @id AND status = 'processing'
    `),
    /** Startup only : toutes les processing de l’ancien process. */
    listAllProcessingDeliveries: db.prepare(`
      SELECT * FROM scrim_broadcast_deliveries
      WHERE status = 'processing'
    `),
    cancelPendingDeliveriesForScrim: db.prepare(`
      UPDATE scrim_broadcast_deliveries
      SET status = 'cancelled', completed_at = @completed_at, updated_at = @updated_at
      WHERE scrim_post_db_id = @scrim_post_db_id
        AND status IN ('pending','retry')
    `),
    listDeliveriesForBatch: db.prepare(`
      SELECT * FROM scrim_broadcast_deliveries WHERE batch_id = ? ORDER BY priority DESC, id ASC
    `),
    countDeliveriesByStatusForBatch: db.prepare(`
      SELECT status, COUNT(*) as n FROM scrim_broadcast_deliveries
      WHERE batch_id = ? GROUP BY status
    `),
    hasPendingDeliveriesForBatch: db.prepare(`
      SELECT 1 FROM scrim_broadcast_deliveries
      WHERE batch_id = ? AND status IN ('pending','processing','retry')
      LIMIT 1
    `),
    listStaleProcessingDeliveries: db.prepare(`
      SELECT * FROM scrim_broadcast_deliveries
      WHERE status = 'processing'
        AND claimed_at < @stale_threshold_iso
    `),
    countSentDeliveriesForBatch: db.prepare(`
      SELECT COUNT(*) as n FROM scrim_broadcast_deliveries
      WHERE batch_id = ? AND status = 'sent'
    `),
    countBroadcastBatchesByStatus: db.prepare(`
      SELECT status, COUNT(*) as n FROM scrim_broadcast_batches GROUP BY status
    `),
    countBroadcastDeliveriesByStatus: db.prepare(`
      SELECT status, COUNT(*) as n FROM scrim_broadcast_deliveries GROUP BY status
    `),
    oldestPendingDelivery: db.prepare(`
      SELECT created_at FROM scrim_broadcast_deliveries
      WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
    `),
    oldestRetryDelivery: db.prepare(`
      SELECT next_attempt_at FROM scrim_broadcast_deliveries
      WHERE status = 'retry' ORDER BY next_attempt_at ASC LIMIT 1
    `),
  };
}

/** @param {import('better-sqlite3').Database} db */
export function preparePlayerSearchStatements(db) {
  return {
    insertPlayerSearchPostRow: db.prepare(`
      INSERT INTO player_search_posts (
        player_search_public_id, author_user_id, origin_guild_id, source_guild_id,
        roles_json, ranks_json, player_count, session_type, ambiance, description,
        contact_user_id, scheduled_date, scheduled_time, scheduled_at, scheduled_at_end,
        tags_json, created_at, status, closed_at, closed_reason
      ) VALUES (
        @player_search_public_id, @author_user_id, @origin_guild_id, @source_guild_id,
        @roles_json, @ranks_json, @player_count, @session_type, @ambiance, @description,
        @contact_user_id, @scheduled_date, @scheduled_time, @scheduled_at, @scheduled_at_end,
        @tags_json, @created_at, @status, NULL, NULL
      )
    `),
    listActivePlayerSearchPublicIds: db.prepare(`
      SELECT player_search_public_id FROM player_search_posts WHERE status = 'active'
    `),
    getPlayerSearchPostById: db.prepare(`
      SELECT * FROM player_search_posts WHERE id = ?
    `),
    getPlayerSearchPostActiveByPublicId: db.prepare(`
      SELECT * FROM player_search_posts
      WHERE player_search_public_id = ? AND status = 'active'
    `),
    getPlayerSearchPostByPublicIdAny: db.prepare(`
      SELECT * FROM player_search_posts WHERE player_search_public_id = ? LIMIT 1
    `),
    closePlayerSearchPostIfActive: db.prepare(`
      UPDATE player_search_posts
      SET status = @status,
          closed_at = @closed_at,
          closed_reason = @closed_reason
      WHERE id = @id AND status = 'active'
    `),
    findExpiredActivePlayerSearchPosts: db.prepare(`
      SELECT id,
        player_search_public_id,
        scheduled_at,
        scheduled_at_end,
        CASE
          WHEN scheduled_at IS NULL OR scheduled_at = '' THEN 1
          ELSE 0
        END AS missing_schedule
      FROM player_search_posts
      WHERE status = 'active'
    `),
    deletePlayerSearchPostById: db.prepare(`
      DELETE FROM player_search_posts WHERE id = ?
    `),
    listActivePlayerSearchPostsByAuthor: db.prepare(`
      SELECT player_search_public_id,
        roles_json,
        ranks_json,
        player_count,
        session_type,
        ambiance,
        scheduled_date,
        scheduled_time,
        scheduled_at,
        scheduled_at_end,
        created_at
      FROM player_search_posts
      WHERE author_user_id = ? AND status = 'active'
      ORDER BY created_at DESC
    `),
    insertPlayerSearchPostMessage: db.prepare(`
      INSERT INTO player_search_post_messages (
        player_search_post_db_id, guild_id, channel_id, message_id
      ) VALUES (
        @player_search_post_db_id, @guild_id, @channel_id, @message_id
      )
    `),
    listPlayerSearchPostMessagesByPostId: db.prepare(`
      SELECT guild_id, channel_id, message_id
      FROM player_search_post_messages
      WHERE player_search_post_db_id = ?
    `),
    deletePlayerSearchPostMessagesForPost: db.prepare(`
      DELETE FROM player_search_post_messages WHERE player_search_post_db_id = ?
    `),
    upsertGuildPlayerSearchChannel: db.prepare(`
      INSERT INTO guild_player_search_channels (guild_id, channel_id, created_at)
      VALUES (@guild_id, @channel_id, @created_at)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        created_at = excluded.created_at
    `),
    deleteGuildPlayerSearchChannel: db.prepare(`
      DELETE FROM guild_player_search_channels WHERE guild_id = ?
    `),
    listPlayerSearchChannels: db.prepare(`
      SELECT guild_id, channel_id FROM guild_player_search_channels
    `),
    countGuildPlayerSearchChannels: db.prepare(`
      SELECT COUNT(*) AS n FROM guild_player_search_channels
    `),
    getGuildPlayerSearchChannel: db.prepare(`
      SELECT channel_id FROM guild_player_search_channels WHERE guild_id = ?
    `),
  };
}
