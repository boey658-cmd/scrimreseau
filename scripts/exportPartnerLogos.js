/**
 * Export local des logos Discord des serveurs partenaires Scrim Réseau.
 *
 * Usage : npm run export-partner-logos
 *
 * Lit uniquement guild_game_channels + API Discord (icônes CDN).
 * Aucune écriture SQLite, aucun message Discord, aucun job métier.
 */
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { fetchBuffer } from '../src/utils/fetchBuffer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const EXPORT_DIR = path.join(PROJECT_ROOT, 'exported-partner-logos');
const MANIFEST_NAME = 'partners-export.json';
const ICON_SIZE = 256;
const ICON_FETCH_TIMEOUT_MS = 10_000;

/**
 * Transforme un nom de guilde en slug de fichier sûr.
 * @param {string} name
 * @returns {string}
 */
function slugifyGuildName(name) {
  const base = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'guild';
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @returns {Promise<import('discord.js').Guild | null>}
 */
async function resolveGuild(client, guildId) {
  const cached = client.guilds.cache.get(guildId);
  if (cached) return cached;
  try {
    return await client.guilds.fetch(guildId);
  } catch {
    return null;
  }
}

/**
 * Attribue un nom de fichier unique et déterministe (ordre des guild_id).
 * @param {{ guildId: string, name: string }[]} entries
 * @returns {Map<string, string>} guildId → filename
 */
function assignFilenames(entries) {
  /** @type {Map<string, string>} */
  const byGuildId = new Map();
  /** @type {Set<string>} */
  const used = new Set();

  for (const { guildId, name } of entries) {
    const slug = slugifyGuildName(name);
    let filename = `${slug}.png`;
    if (used.has(filename)) {
      filename = `${slug}-${guildId}.png`;
    }
    // Dernier recours si collision extrême (même slug + même id impossible, mais garde-fou)
    if (used.has(filename)) {
      filename = `${guildId}.png`;
    }
    used.add(filename);
    byGuildId.set(guildId, filename);
  }
  return byGuildId;
}

async function main() {
  console.log('Scrim Réseau — Export des logos partenaires\n');

  const token = process.env.DISCORD_TOKEN;
  if (!token?.trim()) {
    console.error('Erreur : DISCORD_TOKEN manquant ou vide.');
    process.exitCode = 1;
    return;
  }

  let db;
  let stmts;
  try {
    db = getDb();
    stmts = prepareStatements(db);
  } catch (err) {
    console.error(
      'Erreur : impossible d’ouvrir la base SQLite.',
      err instanceof Error ? err.message : String(err),
    );
    process.exitCode = 1;
    return;
  }

  /** @type {{ guild_id: string }[]} */
  let partnerRows;
  try {
    partnerRows = stmts.listDistinctPartnerGuildIds.all();
  } catch (err) {
    console.error(
      'Erreur : lecture des partenaires impossible.',
      err instanceof Error ? err.message : String(err),
    );
    closeDb();
    process.exitCode = 1;
    return;
  }

  const partnerIds = partnerRows.map((r) => String(r.guild_id));
  console.log(`${partnerIds.length} serveur${partnerIds.length === 1 ? '' : 's'} partenaire${partnerIds.length === 1 ? '' : 's'} trouvé${partnerIds.length === 1 ? '' : 's'}.\n`);

  if (partnerIds.length === 0) {
    await mkdir(EXPORT_DIR, { recursive: true });
    await writeFile(
      path.join(EXPORT_DIR, MANIFEST_NAME),
      `${JSON.stringify([], null, 2)}\n`,
      'utf8',
    );
    console.log('Aucun partenaire à exporter.');
    console.log(`\nDossier :\n${EXPORT_DIR}`);
    closeDb();
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  try {
    await new Promise((resolve, reject) => {
      client.once(Events.ClientReady, () => resolve(undefined));
      client.once(Events.Error, reject);
      client.login(token).catch(reject);
    });
  } catch (err) {
    console.error(
      'Erreur : connexion Discord impossible.',
      err instanceof Error ? err.message : String(err),
    );
    try {
      client.destroy();
    } catch {
      /* ignore */
    }
    closeDb();
    process.exitCode = 1;
    return;
  }

  /** @type {{ guildId: string, name: string, file: string }[]} */
  const manifest = [];
  let exported = 0;
  let noIcon = 0;
  let inaccessible = 0;
  let errors = 0;

  /** Première passe : résoudre les guildes accessibles (pour noms / collisions). */
  /** @type {{ guildId: string, name: string, guild: import('discord.js').Guild }[]} */
  const resolved = [];

  for (const guildId of partnerIds) {
    const guild = await resolveGuild(client, guildId);
    if (!guild) {
      console.log(`⚠ ${guildId} — guilde inaccessible`);
      inaccessible += 1;
      continue;
    }
    resolved.push({ guildId, name: guild.name, guild });
  }

  const filenames = assignFilenames(
    resolved.map(({ guildId, name }) => ({ guildId, name })),
  );

  await mkdir(EXPORT_DIR, { recursive: true });

  for (const { guildId, name, guild } of resolved) {
    const url = guild.iconURL({ extension: 'png', size: ICON_SIZE });
    if (!url) {
      console.log(`⚠ ${name} — aucune icône Discord`);
      noIcon += 1;
      continue;
    }

    const filename = filenames.get(guildId);
    if (!filename) {
      console.log(`⚠ ${name} — nom de fichier invalide`);
      errors += 1;
      continue;
    }

    try {
      const buf = await fetchBuffer(url, ICON_FETCH_TIMEOUT_MS);
      if (!buf) {
        console.log(`⚠ ${name} — échec téléchargement icône`);
        errors += 1;
        continue;
      }
      const outPath = path.join(EXPORT_DIR, filename);
      await writeFile(outPath, buf);
      console.log(`✓ ${name} → ${filename}`);
      manifest.push({ guildId, name, file: filename });
      exported += 1;
    } catch (err) {
      console.log(
        `⚠ ${name} — erreur d’écriture (${err instanceof Error ? err.message : String(err)})`,
      );
      errors += 1;
    }
  }

  try {
    await writeFile(
      path.join(EXPORT_DIR, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    console.error(
      'Erreur : impossible d’écrire partners-export.json.',
      err instanceof Error ? err.message : String(err),
    );
    errors += 1;
    process.exitCode = 1;
  }

  console.log('\nExport terminé.\n');
  console.log(`${exported} logo${exported === 1 ? '' : 's'} exporté${exported === 1 ? '' : 's'}`);
  console.log(`${noIcon} serveur${noIcon === 1 ? '' : 's'} sans logo`);
  console.log(`${inaccessible} serveur${inaccessible === 1 ? '' : 's'} inaccessible${inaccessible === 1 ? '' : 's'}`);
  if (errors > 0) {
    console.log(`${errors} erreur${errors === 1 ? '' : 's'}`);
  }
  console.log(`\nDossier :\n${EXPORT_DIR}`);

  try {
    client.destroy();
  } catch {
    /* ignore */
  }
  closeDb();
}

main().catch((err) => {
  console.error(
    'Erreur fatale :',
    err instanceof Error ? err.message : String(err),
  );
  try {
    closeDb();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
