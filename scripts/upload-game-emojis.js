/**
 * Upload des emojis « jeu » vers une guilde Discord dédiée (assets).
 *
 * Si une emote avec le même nom existe déjà sur la guilde : on la RÉUTILISE
 * (on n’efface pas / ne remplace pas) — évite suppressions accidentelles et
 * limite les besoins de permissions Discord dangereuses.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { GAMES } from '../src/config/games.js';
import { getDiscordEmojiNameForGame } from '../src/config/gameEmojiNames.js';
import { logger } from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const ASSETS_DIR = path.join(PROJECT_ROOT, 'assets', 'emojis');
const OUTPUT_JSON = path.join(PROJECT_ROOT, 'src', 'config', 'gameEmojis.generated.json');

/** Taille max fichier image pour emoji statique (Discord). */
const MAX_EMOJI_FILE_BYTES = 256 * 1024;

const UPLOAD_DELAY_MS = 600;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} filePath
 * @returns {{ ok: true, dataUri: string } | { ok: false, error: string }}
 */
function readValidatedPngAsDataUri(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return { ok: false, error: 'fichier illisible' };
  }
  if (!st.isFile()) {
    return { ok: false, error: 'chemin n’est pas un fichier' };
  }
  if (st.size > MAX_EMOJI_FILE_BYTES) {
    return {
      ok: false,
      error: `fichier trop volumineux (max ${MAX_EMOJI_FILE_BYTES} octets)`,
    };
  }
  if (st.size < 32) {
    return { ok: false, error: 'fichier trop petit pour une image valide' };
  }

  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return { ok: false, error: 'lecture fichier impossible' };
  }

  if (
    buf.length < 8
    || buf[0] !== 0x89
    || buf[1] !== 0x50
    || buf[2] !== 0x4e
    || buf[3] !== 0x47
  ) {
    return { ok: false, error: 'en-tête PNG invalide (fichier non PNG ?)' };
  }

  const b64 = buf.toString('base64');
  return { ok: true, dataUri: `data:image/png;base64,${b64}` };
}

/**
 * @param {unknown} emoji
 * @returns {{ name: string, id: string, animated: boolean } | null}
 */
function normalizeExistingEmoji(emoji) {
  if (!emoji || typeof emoji !== 'object') return null;
  const rec = /** @type {Record<string, unknown>} */ (emoji);
  const id = rec.id;
  const name = rec.name;
  const animated = Boolean(rec.animated);
  if (typeof id === 'string' && typeof name === 'string') {
    return { id, name, animated };
  }
  return null;
}

function makeEmojiTag(name, id, animated) {
  return animated ? `<a:${name}:${id}>` : `<:${name}:${id}>`;
}

async function main() {
  const token = process.env.DISCORD_TOKEN?.trim();
  const guildId = process.env.ASSET_GUILD_ID?.trim();

  if (!token) {
    logger.error('DISCORD_TOKEN manquant — impossible d’uploader les emojis.');
    process.exit(1);
  }
  if (!guildId) {
    logger.error(
      'ASSET_GUILD_ID manquant — renseignez l’ID de la guilde « assets » dans .env',
    );
    process.exit(1);
  }

  const gameKeys = Object.keys(GAMES);
  logger.info('Début upload des emojis jeu', {
    assetGuildId: guildId,
    gameCount: gameKeys.length,
    assetsDir: ASSETS_DIR,
  });

  const rest = new REST({ version: '10' }).setToken(token);

  /** @type {import('discord.js').APIEmoji[]} */
  let existingList = [];
  try {
    const res = /** @type {unknown} */ (await rest.get(Routes.guildEmojis(guildId)));
    existingList = Array.isArray(res) ? res : [];
  } catch (err) {
    logger.error('Impossible de lister les emojis de la guilde (permissions / ID ?)', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  }

  const existingByName = new Map();
  for (const raw of existingList) {
    const e = normalizeExistingEmoji(raw);
    if (e) existingByName.set(e.name, e);
  }

  /** @type {Record<string, { emojiName: string, emojiId: string, emojiTag: string }>} */
  const output = {};

  let uploadOk = 0;
  let uploadFail = 0;
  let missingFile = 0;
  let reused = 0;

  for (let i = 0; i < gameKeys.length; i += 1) {
    const gameKey = gameKeys[i];
    const emojiName = getDiscordEmojiNameForGame(gameKey);

    if (!emojiName) {
      logger.warn('Nom équivalent Discord introuvable pour la clé — ignoré', {
        gameKey,
      });
      uploadFail += 1;
      continue;
    }

    const imagePath = path.join(ASSETS_DIR, `${gameKey}.png`);

    /** Réutilisation sans fichier local — pratique pour regénérer le JSON seulement. */
    const existing = existingByName.get(emojiName);
    if (existing) {
      const tag = makeEmojiTag(existing.name, existing.id, existing.animated);
      output[gameKey] = {
        emojiName: existing.name,
        emojiId: existing.id,
        emojiTag: tag,
      };
      logger.info('Emote existante réutilisée (même nom sur la guilde)', {
        gameKey,
        emojiName,
        emojiId: existing.id,
      });
      reused += 1;
      continue;
    }

    if (!fs.existsSync(imagePath)) {
      logger.warn('Aucun fichier PNG pour ce jeu', { gameKey, expectedPath: imagePath });
      missingFile += 1;
      continue;
    }

    const prepared = readValidatedPngAsDataUri(imagePath);
    if (!prepared.ok) {
      logger.warn('Fichier image invalide pour ce jeu', {
        gameKey,
        path: imagePath,
        reason: prepared.error,
      });
      uploadFail += 1;
      continue;
    }

    try {
      const created = /** @type {Record<string, unknown>} */ (
        await rest.post(Routes.guildEmojis(guildId), {
          body: {
            name: emojiName,
            image: prepared.dataUri,
          },
        })
      );

      const id = created?.id;
      const nameOut = created?.name;
      const animated = Boolean(created?.animated);

      if (typeof id !== 'string' || typeof nameOut !== 'string') {
        logger.error('Réponse API emoji inattendue', { gameKey, created });
        uploadFail += 1;
        continue;
      }

      const tag = makeEmojiTag(nameOut, id, animated);
      output[gameKey] = {
        emojiName: nameOut,
        emojiId: id,
        emojiTag: tag,
      };
      existingByName.set(nameOut, { id, name: nameOut, animated });

      logger.info('Upload emoji réussi', { gameKey, emojiName: nameOut, emojiId: id });
      uploadOk += 1;
    } catch (err) {
      logger.error('Échec upload emoji pour ce jeu', {
        gameKey,
        emojiName,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      uploadFail += 1;
    }

    if (i < gameKeys.length - 1) await sleep(UPLOAD_DELAY_MS);
  }

  try {
    fs.writeFileSync(
      OUTPUT_JSON,
      `${JSON.stringify(output, null, 2)}\n`,
      'utf8',
    );
    logger.info('Mapping écrit sur disque', { path: OUTPUT_JSON });
  } catch (err) {
    logger.error('Impossible d’écrire le fichier JSON généré', {
      path: OUTPUT_JSON,
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  logger.info('Résumé upload emojis', {
    jeux_traités: gameKeys.length,
    uploads_reussis: uploadOk,
    reutilisations: reused,
    echecs: uploadFail,
    fichiers_absents: missingFile,
    entrees_mapping: Object.keys(output).length,
    fichier_sortie: OUTPUT_JSON,
  });
}

main().catch((err) => {
  logger.error('Erreur fatale upload-game-emojis', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
