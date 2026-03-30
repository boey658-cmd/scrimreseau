import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
  buildScrimReceptionConfigRefusalContent,
  getScrimReceptionMinMembers,
  isGuildReceptionBypassActive,
  mayConfigureScrimReceptionChannel,
} from '../src/utils/guildScrimReceptionGate.js';

const ENV_KEY = 'SCRIM_RECEPTION_MIN_MEMBERS';

describe('guildScrimReceptionGate', () => {
  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('seuil : env absent → 150 ; autorisé à partir du seuil sans bypass', () => {
    assert.strictEqual(getScrimReceptionMinMembers(), 150);
    assert.strictEqual(mayConfigureScrimReceptionChannel(150, undefined), true);
    assert.strictEqual(mayConfigureScrimReceptionChannel(1000, undefined), true);
  });

  it('sous le seuil sans bypass → refus', () => {
    assert.strictEqual(mayConfigureScrimReceptionChannel(149, undefined), false);
    assert.strictEqual(mayConfigureScrimReceptionChannel(0, undefined), false);
  });

  it('env entier > 0 → seuil personnalisé', () => {
    process.env[ENV_KEY] = '200';
    assert.strictEqual(getScrimReceptionMinMembers(), 200);
    assert.strictEqual(mayConfigureScrimReceptionChannel(199, undefined), false);
    assert.strictEqual(mayConfigureScrimReceptionChannel(200, undefined), true);
  });

  it('env invalide → fallback 150', () => {
    for (const v of ['0', '-1', '1.5', 'abc', '']) {
      process.env[ENV_KEY] = v;
      assert.strictEqual(
        getScrimReceptionMinMembers(),
        150,
        `attendu fallback pour ${JSON.stringify(v)}`,
      );
    }
    delete process.env[ENV_KEY];
    assert.strictEqual(getScrimReceptionMinMembers(), 150);
  });

  it('message de refus contient le seuil effectif', () => {
    process.env[ENV_KEY] = '42';
    assert.match(
      buildScrimReceptionConfigRefusalContent(),
      /Un minimum de 42 membres est requis/,
    );
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

  it('memberCount non fini → refus sans bypass', () => {
    assert.strictEqual(mayConfigureScrimReceptionChannel(NaN, undefined), false);
  });
});
