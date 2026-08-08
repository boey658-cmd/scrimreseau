import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commandList, commandListWithoutDev, scrimDev } from '../src/commands/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('help scrim — renommé help-scrim, contenu inchangé', () => {
  const source = readSrc('src/commands/help.js');
  assert.match(source, /\.setName\('help-scrim'\)/);
  assert.doesNotMatch(source, /\.setName\('help'\)/);
  // Vérifie que les clés i18n correctes sont utilisées (les textes sont dans fr.js)
  assert.match(source, /help\.findValue/);
  assert.match(source, /help\.manageValue/);
  assert.doesNotMatch(source, /recherche-joueur/);
  // Vérifie que les nouveaux noms sont dans les traductions fr.js
  const frSource = readSrc('src/i18n/fr.js');
  assert.match(frSource, /\/find-scrim/);
  assert.match(frSource, /\/my-scrims/);
  assert.match(frSource, /\/scrim-close/);
});

test('helpadmin scrim — renommé helpadmin-scrim, référence scrim-config', () => {
  const source = readSrc('src/commands/helpAdmin.js');
  assert.match(source, /\.setName\('helpadmin-scrim'\)/);
  assert.doesNotMatch(source, /\.setName\('helpadmin'\)/);
  // La nouvelle aide utilise des clés i18n
  assert.match(source, /helpAdmin\.scrimConfigValue/);
  assert.doesNotMatch(source, /channel → set/);
  assert.doesNotMatch(source, /command-channel/);
  assert.doesNotMatch(source, /joueur-config/);
  // Vérifie que la clé i18n référence /scrim-config
  const frSource = readSrc('src/i18n/fr.js');
  assert.match(frSource, /\/scrim-config/);
  assert.doesNotMatch(frSource, /\/scrim-configurer/);
});

test('help-joueur — contenu attendu, sans tag DEV', () => {
  const source = readSrc('src/commands/helpJoueur.js');
  assert.match(source, /\.setName\('help-joueur'\)/);
  assert.match(source, /Trouver un ou plusieurs joueurs ponctuellement/);
  assert.match(source, /\/recherche-joueur/);
  assert.match(source, /\/joueur-trouve/);
  assert.match(source, /\/mes-demandes-joueur/);
  assert.match(source, /3 h après/);
  assert.match(source, /date.*obligatoire/i);
  assert.doesNotMatch(source, /\[DEV\]/);
});

test('helpadmin-joueur — admin, sans tag DEV', () => {
  const source = readSrc('src/commands/helpAdminJoueur.js');
  assert.match(source, /\.setName\('helpadmin-joueur'\)/);
  assert.match(source, /\/joueur-config/);
  assert.match(source, /channel → set/);
  assert.match(source, /channel → remove/);
  assert.match(source, /guild_game_channels/);
  assert.match(source, /Aucun repost/);
  assert.match(source, /3 h après/);
  assert.doesNotMatch(source, /\[DEV\]/);
});

test('index — commandes joueur désactivées (absentes de commandListWithoutDev)', () => {
  const source = readSrc('src/commands/index.js');
  assert.doesNotMatch(source, /playerSearchDevCommandList/);
  // Les imports joueur sont commentés : les noms ne doivent pas apparaître
  // hors commentaire dans la zone commandListWithoutDev
  const publicBlock = source.slice(
    source.indexOf('export const commandListWithoutDev'),
    source.indexOf('export { dashboardAdmin'),
  );
  for (const name of [
    'joueurConfig',
    'rechercheJoueur',
    'joueurTrouve',
    'mesDemandesJoueur',
    'helpJoueur',
    'helpAdminJoueur',
  ]) {
    assert.doesNotMatch(publicBlock, new RegExp(`^\\s*${name},`, 'm'));
  }
});

test('commandListWithoutDev — noms uniques, sans commandes joueur désactivées', () => {
  const names = commandListWithoutDev.map((c) => c.data.name);
  assert.equal(new Set(names).size, names.length);
  // Commandes joueur ne doivent plus être déployées
  assert.ok(!names.includes('recherche-joueur'));
  assert.ok(!names.includes('help-joueur'));
  assert.ok(!names.includes('helpadmin-joueur'));
  assert.ok(!names.includes('joueur-config'));
  assert.ok(!names.includes('mes-demandes-joueur'));
  assert.ok(!names.includes('joueur-trouve'));
  // Anciens noms absents
  assert.ok(!names.includes('scrim-configurer'), `scrim-configurer ne doit plus être dans commandListWithoutDev`);
  assert.ok(!names.includes('recherche-scrim'), `recherche-scrim ne doit plus être dans commandListWithoutDev`);
  assert.ok(!names.includes('scrim-trouve'), `scrim-trouve ne doit plus être dans commandListWithoutDev`);
  assert.ok(!names.includes('structure-lien'), `structure-lien ne doit plus être dans commandListWithoutDev`);
  assert.ok(!names.includes('spammer'), `spammer ne doit plus être dans commandListWithoutDev`);
  assert.ok(!names.includes('liste-scrims'), `liste-scrims ne doit plus être dans commandListWithoutDev`);
  assert.ok(!names.includes('mes-demandes-scrim'), `mes-demandes-scrim ne doit plus être dans commandListWithoutDev`);
  // Nouveaux noms présents
  assert.ok(names.includes('scrim-config'), `scrim-config doit être dans commandListWithoutDev`);
  assert.ok(names.includes('find-scrim'), `find-scrim doit être dans commandListWithoutDev`);
  assert.ok(names.includes('scrim-close'), `scrim-close doit être dans commandListWithoutDev`);
  assert.ok(names.includes('structure-link'), `structure-link doit être dans commandListWithoutDev`);
  assert.ok(names.includes('report-spam'), `report-spam doit être dans commandListWithoutDev`);
  assert.ok(names.includes('list-scrims'), `list-scrims doit être dans commandListWithoutDev`);
  assert.ok(names.includes('my-scrims'), `my-scrims doit être dans commandListWithoutDev`);
  assert.ok(names.includes('language'), `language doit être dans commandListWithoutDev`);
  // 11 commandes publiques attendues
  assert.equal(names.length, 11);
});

test('scrimDev — seule commande hors liste publique', () => {
  assert.equal(scrimDev.data.name, 'scrim-dev');
});

test('deploy-commands — joueur public, devOnlyBody contient les commandes dev', () => {
  const source = readSrc('scripts/deploy-commands.js');
  assert.match(source, /commandListWithoutDev/);
  assert.doesNotMatch(source, /playerSearchDevCommandList/);
  assert.doesNotMatch(source, /playerSearchDevBody/);
  const devOnlyLine = source.slice(
    source.indexOf('const devOnlyBody'),
    source.indexOf('const devGuildId'),
  );
  assert.match(devOnlyLine, /scrimDev\.data\.toJSON/);
  assert.match(devOnlyLine, /scrimChannel\.data\.toJSON/);
  assert.doesNotMatch(devOnlyLine, /joueur/);
});

test(`slash commands — aucune option obligatoire placée après une option facultative`, () => {
  /** @type {string[]} */
  const violations = [];

  for (const cmd of commandList) {
    const data = cmd.data?.toJSON ? cmd.data.toJSON() : null;
    if (!data) continue;
    const opts = data.options ?? [];
    let seenOptional = false;
    for (const opt of opts) {
      // Sous-commandes (type 1) et groupes (type 2) : ordre géré par Discord lui-même
      if (opt.type === 1 || opt.type === 2) continue;
      if (!opt.required) seenOptional = true;
      if (seenOptional && opt.required) {
        violations.push(
          `/${data.name}: option obligatoire «${opt.name}» placée après une option facultative`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Options mal ordonnées détectées :\n${violations.join('\n')}`,
  );
});
