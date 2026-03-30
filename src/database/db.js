import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScheduledAtIso } from '../utils/scrimScheduledAt.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPath = path.join(__dirname, '..', '..', 'data', 'scrim.db');

const dbPath = process.env.SQLITE_PATH || defaultPath;

let dbInstance = null;

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

export function getDb() {
  if (dbInstance) return dbInstance;
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
  const closedPath = dbPath;
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
    listChannelsByGame: db.prepare(`
      SELECT guild_id, channel_id FROM guild_game_channels
      WHERE game_key = ?
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
        game_key
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
        game_key, rank_key, format_key, contact_user_id,
        scheduled_date, scheduled_time, scheduled_at, scheduled_at_end, tags, multi_opgg_url,
        created_at, status, closed_at, closed_reason
      ) VALUES (
        @scrim_public_id, @author_user_id, @origin_guild_id, @source_guild_id,
        @game_key, @rank_key, @format_key, @contact_user_id,
        @scheduled_date, @scheduled_time, @scheduled_at, @scheduled_at_end, @tags, @multi_opgg_url,
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
      LIMIT 1
    `),
    deleteScrimPostMessagesForPost: db.prepare(`
      DELETE FROM scrim_post_messages WHERE scrim_post_db_id = ?
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
        payload_json, created_at, updated_at
      ) VALUES (
        @scrim_post_db_id, @guild_id, @channel_id, @message_id, @target_status,
        @attempt_count, @next_attempt_at, @last_error_code, @last_error_message,
        @payload_json, @created_at, @updated_at
      )
    `),
    updateDiscordEditRetryPendingRefresh: db.prepare(`
      UPDATE discord_message_edit_retries
      SET payload_json = @payload_json,
          attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          last_error_code = @last_error_code,
          last_error_message = @last_error_message,
          updated_at = @updated_at
      WHERE id = @id
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
      SELECT * FROM discord_message_edit_retries
      WHERE resolved_at IS NULL AND abandoned_at IS NULL
        AND next_attempt_at <= @now_iso
      ORDER BY next_attempt_at ASC
      LIMIT 25
    `),
    countPendingDiscordEditRetries: db.prepare(`
      SELECT COUNT(*) AS n
      FROM discord_message_edit_retries
      WHERE resolved_at IS NULL AND abandoned_at IS NULL
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
  };
}
