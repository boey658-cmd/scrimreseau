import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commandListWithoutDev, scrimDev } from '../src/commands/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

test('help scrim — renommé help-scrim, contenu inchangé', () => {
  const source = readSrc('src/commands/help.js');
  assert.match(source, /\.setName\('help-scrim'\)/);
  assert.doesNotMatch(source, /\.setName\('help'\)/);
  assert.match(source, /\/recherche-scrim/);
  assert.match(source, /\/mes-demandes-scrim/);
  assert.match(source, /\/scrim-trouve/);
  assert.doesNotMatch(source, /recherche-joueur/);
});

test('helpadmin scrim — renommé helpadmin-scrim', () => {
  const source = readSrc('src/commands/helpAdmin.js');
  assert.match(source, /\.setName\('helpadmin-scrim'\)/);
  assert.doesNotMatch(source, /\.setName\('helpadmin'\)/);
  assert.match(source, /\/scrim-config/);
  assert.doesNotMatch(source, /joueur-config/);
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

test('index — commandes joueur dans commandListWithoutDev', () => {
  const source = readSrc('src/commands/index.js');
  assert.doesNotMatch(source, /playerSearchDevCommandList/);
  const publicBlock = source.slice(
    source.indexOf('commandListWithoutDev'),
    source.indexOf('export { scrimDev }'),
  );
  for (const name of [
    'joueurConfig',
    'rechercheJoueur',
    'joueurTrouve',
    'mesDemandesJoueur',
    'helpJoueur',
    'helpAdminJoueur',
  ]) {
    assert.match(publicBlock, new RegExp(name));
  }
});

test('commandListWithoutDev — noms uniques incluant joueur', () => {
  const names = commandListWithoutDev.map((c) => c.data.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('recherche-joueur'));
  assert.ok(names.includes('help-joueur'));
  assert.ok(names.includes('helpadmin-joueur'));
  assert.ok(names.includes('joueur-config'));
  assert.ok(names.includes('mes-demandes-joueur'));
  assert.ok(names.includes('joueur-trouve'));
  assert.equal(names.length, 15);
});

test('scrimDev — seule commande hors liste publique', () => {
  assert.equal(scrimDev.data.name, 'scrim-dev');
});

test('deploy-commands — joueur public, devOnlyBody = scrim-dev seul', () => {
  const source = readSrc('scripts/deploy-commands.js');
  assert.match(source, /commandListWithoutDev/);
  assert.doesNotMatch(source, /playerSearchDevCommandList/);
  assert.doesNotMatch(source, /playerSearchDevBody/);
  const devOnlyLine = source.slice(
    source.indexOf('const devOnlyBody'),
    source.indexOf('const devGuildId'),
  );
  assert.match(devOnlyLine, /scrimDev\.data\.toJSON/);
  assert.doesNotMatch(devOnlyLine, /joueur/);
});
