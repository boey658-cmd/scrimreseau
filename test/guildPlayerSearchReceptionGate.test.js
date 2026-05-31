import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import {
  buildPlayerSearchReceptionConfigRefusalContent,
  mayConfigurePlayerSearchReceptionChannel,
} from '../src/utils/guildPlayerSearchReceptionGate.js';

const ENV_PLAYER_TICKET = 'PLAYER_SEARCH_RECEPTION_TICKET_URL';
const ENV_SCRIM_TICKET = 'SCRIM_RECEPTION_TICKET_URL';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('guildPlayerSearchReceptionGate', () => {
  afterEach(() => {
    delete process.env[ENV_PLAYER_TICKET];
    delete process.env[ENV_SCRIM_TICKET];
  });

  it('sans bypass → refus configuration réception joueur', () => {
    assert.strictEqual(mayConfigurePlayerSearchReceptionChannel(undefined), false);
    assert.strictEqual(
      mayConfigurePlayerSearchReceptionChannel({ bypass_member_minimum: 0 }),
      false,
    );
  });

  it('bypass actif → autorisé (table commune scrim)', () => {
    assert.strictEqual(
      mayConfigurePlayerSearchReceptionChannel({ bypass_member_minimum: 1 }),
      true,
    );
  });

  it('message de refus — recherches joueur et ticket', () => {
    const content = buildPlayerSearchReceptionConfigRefusalContent();
    assert.match(content, /recherches joueur ScrimRéseau/);
    assert.match(content, /salon prévu pour les recherches joueur/);
    assert.match(content, /https:\/\/discord\.gg\/dcjhQq5Ur9/);
  });

  it('PLAYER_SEARCH_RECEPTION_TICKET_URL prioritaire', () => {
    process.env[ENV_PLAYER_TICKET] = 'https://discord.gg/player-ticket';
    const content = buildPlayerSearchReceptionConfigRefusalContent();
    assert.match(content, /https:\/\/discord\.gg\/player-ticket/);
  });

  it('repli SCRIM_RECEPTION_TICKET_URL si joueur absent', () => {
    process.env[ENV_SCRIM_TICKET] = 'https://discord.gg/scrim-ticket';
    const content = buildPlayerSearchReceptionConfigRefusalContent();
    assert.match(content, /https:\/\/discord\.gg\/scrim-ticket/);
  });
});

describe('setupJoueurChannel — gate réception', () => {
  it('vérifie bypass avant upsert salon', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'commands', 'setupJoueurChannel.js'),
      'utf8',
    );
    assert.match(source, /getGuildScrimReceptionBypass/);
    assert.match(source, /mayConfigurePlayerSearchReceptionChannel/);
    assert.match(source, /buildPlayerSearchReceptionConfigRefusalContent/);
    assert.ok(
      source.indexOf('getGuildScrimReceptionBypass') <
        source.indexOf('upsertGuildPlayerSearchChannel'),
    );
  });
});

describe('recherche-joueur — pas de gate réception', () => {
  it('setupJoueurChannel gate uniquement, pas rechercheJoueur', () => {
    const recherchePath = path.join(
      __dirname,
      '..',
      'src',
      'commands',
      'rechercheJoueur.js',
    );
    const source = fs.readFileSync(recherchePath, 'utf8');
    assert.doesNotMatch(source, /mayConfigurePlayerSearchReceptionChannel/);
    assert.doesNotMatch(source, /getGuildScrimReceptionBypass/);
  });
});
