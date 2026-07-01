import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScrimEmbed, getRankEmoji } from '../src/services/scrimEmbedBuilder.js';

// Emojis attendus (doivent correspondre à CUSTOM_EMOJIS dans scrimEmbedBuilder.js)
const E = {
  iron:        '<:iron:1521794187006316615>',
  bronze:      '<:bronze:1521794229951660053>',
  silver:      '<:silver:1521794275702997032>',
  gold:        '<:gold:1521794312642232400>',
  platinum:    '<:platinum:1521794349539655770>',
  emerald:     '<:emerald:1521794386642337822>',
  diamond:     '<:diamond:1521794418787749938>',
  master:      '<:master:1521794452111364228>',
  grandmaster: '<:grandmaster:1521794486102134824>',
  challenger:  '<:challenger:1521794520860069988>',
};

describe('getRankEmoji — rangs simples', () => {
  test('Fer → iron', () => assert.equal(getRankEmoji('Fer'), E.iron));
  test('Bronze → bronze', () => assert.equal(getRankEmoji('Bronze'), E.bronze));
  test('Argent → silver', () => assert.equal(getRankEmoji('Argent'), E.silver));
  test('Or → gold', () => assert.equal(getRankEmoji('Or'), E.gold));
  test('Platine → platinum', () => assert.equal(getRankEmoji('Platine'), E.platinum));
  test('Émeraude → emerald', () => assert.equal(getRankEmoji('Émeraude'), E.emerald));
  test('Diamant → diamond', () => assert.equal(getRankEmoji('Diamant'), E.diamond));
  test('Master → master', () => assert.equal(getRankEmoji('Master'), E.master));
  test('Grandmaster → grandmaster', () => assert.equal(getRankEmoji('Grandmaster'), E.grandmaster));
  test('Challenger → challenger', () => assert.equal(getRankEmoji('Challenger'), E.challenger));
});

describe('getRankEmoji — noms anglais', () => {
  test('Iron → iron', () => assert.equal(getRankEmoji('Iron'), E.iron));
  test('Silver → silver', () => assert.equal(getRankEmoji('Silver'), E.silver));
  test('Gold → gold', () => assert.equal(getRankEmoji('Gold'), E.gold));
  test('Platinum → platinum', () => assert.equal(getRankEmoji('Platinum'), E.platinum));
  test('Emerald → emerald', () => assert.equal(getRankEmoji('Emerald'), E.emerald));
  test('Diamond → diamond', () => assert.equal(getRankEmoji('Diamond'), E.diamond));
});

describe('getRankEmoji — rangs combinés (émooji = le plus élevé)', () => {
  test('Fer / Bronze → bronze', () =>
    assert.equal(getRankEmoji('Fer / Bronze'), E.bronze));
  test('Bronze / Argent → silver', () =>
    assert.equal(getRankEmoji('Bronze / Argent'), E.silver));
  test('Argent / Or → gold', () =>
    assert.equal(getRankEmoji('Argent / Or'), E.gold));
  test('Or / Platine → platinum', () =>
    assert.equal(getRankEmoji('Or / Platine'), E.platinum));
  test('Platine / Émeraude → emerald', () =>
    assert.equal(getRankEmoji('Platine / Émeraude'), E.emerald));
  test('Émeraude / Diamant → diamond', () =>
    assert.equal(getRankEmoji('Émeraude / Diamant'), E.diamond));
  test('Diamant / Master → master', () =>
    assert.equal(getRankEmoji('Diamant / Master'), E.master));
  test('Master / Grandmaster → grandmaster', () =>
    assert.equal(getRankEmoji('Master / Grandmaster'), E.grandmaster));
  test('Grandmaster / Challenger → challenger', () =>
    assert.equal(getRankEmoji('Grandmaster / Challenger'), E.challenger));
});

describe('getRankEmoji — cas limites', () => {
  test('null → 🏆 fallback', () => assert.equal(getRankEmoji(null), '🏆'));
  test('undefined → 🏆 fallback', () => assert.equal(getRankEmoji(undefined), '🏆'));
  test('chaîne vide → 🏆 fallback', () => assert.equal(getRankEmoji(''), '🏆'));
  test('Mix niveau → 🏆 fallback', () => assert.equal(getRankEmoji('Mix niveau'), '🏆'));
  test('rang inconnu → 🏆 fallback', () => assert.equal(getRankEmoji('Inconnu'), '🏆'));

  test('insensible à la casse — or', () => assert.equal(getRankEmoji('or'), E.gold));
  test('insensible à la casse — CHALLENGER', () =>
    assert.equal(getRankEmoji('CHALLENGER'), E.challenger));

  test('grandmaster ne match pas "master" seul (comparaison exacte)', () =>
    assert.equal(getRankEmoji('Grandmaster'), E.grandmaster));
});

// ---------------------------------------------------------------------------
// Tests d'intégration — description complète de l'embed (anti-régression emoji)
// Vérifie que la balise custom complète (avec ID) apparaît bien dans le rendu final
// ---------------------------------------------------------------------------

/** Payload minimal valide pour buildScrimEmbed */
function makePayload(rank, extra = {}) {
  return {
    gameKey: 'league_of_legends',
    rank,
    dateStr: '01/07/2026',
    timeStr: '22h00',
    format: 'BO3',
    contactUserId: '111111111111111111',
    contactDisplayName: 'testuser',
    fearless: null,
    ...extra,
  };
}

describe('buildScrimEmbed — emoji rang complet dans la description', () => {
  test('Grandmaster / Challenger → balise complète <:challenger:1521794520860069988>', () => {
    const desc = buildScrimEmbed(makePayload('Grandmaster / Challenger')).data.description ?? '';
    assert.ok(
      desc.includes('<:challenger:1521794520860069988> Grandmaster / Challenger'),
      `Attendu l'emoji complet. Description reçue:\n${desc}`,
    );
  });

  test('Master / Grandmaster → balise complète <:grandmaster:1521794486102134824>', () => {
    const desc = buildScrimEmbed(makePayload('Master / Grandmaster')).data.description ?? '';
    assert.ok(
      desc.includes('<:grandmaster:1521794486102134824> Master / Grandmaster'),
      `Attendu l'emoji complet. Description reçue:\n${desc}`,
    );
  });

  test('Platine / Émeraude → balise complète <:emerald:1521794386642337822>', () => {
    const desc = buildScrimEmbed(makePayload('Platine / Émeraude')).data.description ?? '';
    assert.ok(
      desc.includes('<:emerald:1521794386642337822> Platine / Émeraude'),
      `Attendu l'emoji complet. Description reçue:\n${desc}`,
    );
  });

  test('rang inconnu → fallback 🏆 dans la description', () => {
    const desc = buildScrimEmbed(makePayload('Inconnu')).data.description ?? '';
    assert.ok(
      desc.includes('🏆 Inconnu'),
      `Attendu le fallback 🏆. Description reçue:\n${desc}`,
    );
  });

  test('OP.GG → balise complète <:opgg:1521794035990138921>', () => {
    const desc = buildScrimEmbed(
      makePayload('Gold', { multiOpggUrl: 'https://op.gg/multisearch/euw?summoners=x' }),
    ).data.description ?? '';
    assert.ok(
      desc.includes('<:opgg:1521794035990138921> Multi OP.GG'),
      `Attendu l'emoji opgg complet. Description reçue:\n${desc}`,
    );
  });

  test('pas d\'OP.GG → ligne OP.GG absente', () => {
    const desc = buildScrimEmbed(makePayload('Gold')).data.description ?? '';
    assert.ok(!desc.includes('OP.GG'), `Ligne OP.GG ne devrait pas apparaître. Description:\n${desc}`);
  });
});
