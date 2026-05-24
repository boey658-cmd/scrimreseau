import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
  buildScrimReceptionConfigRefusalContent,
  getScrimReceptionMinMembers,
  isGuildReceptionBypassActive,
  mayConfigureScrimReceptionChannel,
} from '../src/utils/guildScrimReceptionGate.js';

const ENV_MIN_KEY = 'SCRIM_RECEPTION_MIN_MEMBERS';
const ENV_TICKET_KEY = 'SCRIM_RECEPTION_TICKET_URL';

describe('guildScrimReceptionGate', () => {
  afterEach(() => {
    delete process.env[ENV_MIN_KEY];
    delete process.env[ENV_TICKET_KEY];
  });

  it('sans bypass → refus quel que soit memberCount', () => {
    assert.strictEqual(mayConfigureScrimReceptionChannel(150, undefined), false);
    assert.strictEqual(mayConfigureScrimReceptionChannel(1000, undefined), false);
    assert.strictEqual(mayConfigureScrimReceptionChannel(0, undefined), false);
    assert.strictEqual(mayConfigureScrimReceptionChannel(NaN, undefined), false);
  });

  it('bypass actif (1) → autorisé même avec peu de membres', () => {
    assert.strictEqual(
      mayConfigureScrimReceptionChannel(5, { bypass_member_minimum: 1 }),
      true,
    );
  });

  it('ligne bypass absente ou inactive → pas de bypass', () => {
    assert.strictEqual(isGuildReceptionBypassActive(undefined), false);
    assert.strictEqual(isGuildReceptionBypassActive({ bypass_member_minimum: 0 }), false);
  });

  it('getScrimReceptionMinMembers reste disponible (compat) sans lier l’autorisation', () => {
    assert.strictEqual(getScrimReceptionMinMembers(), 150);
    process.env[ENV_MIN_KEY] = '200';
    assert.strictEqual(getScrimReceptionMinMembers(), 200);
    assert.strictEqual(mayConfigureScrimReceptionChannel(200, undefined), false);
    assert.strictEqual(mayConfigureScrimReceptionChannel(199, undefined), false);
  });

  it('getScrimReceptionMinMembers : env invalide → fallback 150', () => {
    for (const v of ['0', '-1', '1.5', 'abc', '']) {
      process.env[ENV_MIN_KEY] = v;
      assert.strictEqual(
        getScrimReceptionMinMembers(),
        150,
        `attendu fallback pour ${JSON.stringify(v)}`,
      );
    }
  });

  it('message de refus : validation manuelle, sans seuil membres', () => {
    const content = buildScrimReceptionConfigRefusalContent();
    assert.match(content, /validée manuellement/);
    assert.match(content, /lien de votre serveur/);
    assert.doesNotMatch(content, /minimum de \d+ membres/i);
    assert.doesNotMatch(content, /membres est requis/i);
  });

  it('message de refus : SCRIM_RECEPTION_TICKET_URL si défini', () => {
    process.env[ENV_TICKET_KEY] = 'https://discord.gg/scrim-ticket';
    const content = buildScrimReceptionConfigRefusalContent();
    assert.match(content, /https:\/\/discord\.gg\/scrim-ticket/);
  });

  it('message de refus : placeholder si URL ticket absente', () => {
    const content = buildScrimReceptionConfigRefusalContent();
    assert.match(content, /\[ton lien\]/);
  });
});
