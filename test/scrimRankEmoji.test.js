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

  test('OP.GG déplacé en bouton — absent de la description', () => {
    const desc = buildScrimEmbed(
      makePayload('Gold', { multiOpggUrl: 'https://op.gg/multisearch/euw?summoners=x' }),
    ).data.description ?? '';
    assert.ok(
      !desc.includes('OP.GG'),
      `OP.GG ne doit plus être dans la description (il est en bouton). Description reçue:\n${desc}`,
    );
  });

  test('sans OP.GG → ligne OP.GG absente', () => {
    const desc = buildScrimEmbed(makePayload('Gold')).data.description ?? '';
    assert.ok(!desc.includes('OP.GG'), `Ligne OP.GG ne devrait pas apparaître. Description:\n${desc}`);
  });
});

// ---------------------------------------------------------------------------
// Tests du layout 4 lignes
// ---------------------------------------------------------------------------

describe('buildScrimEmbed — layout 4 lignes', () => {
  test('ligne 1 : date + heure inline sans emoji heure séparé', () => {
    const desc = buildScrimEmbed(makePayload('Gold')).data.description ?? '';
    const line1 = desc.split('\n')[0];
    assert.ok(line1.includes('01/07/2026'), `Ligne 1 doit contenir la date. Got: ${line1}`);
    assert.ok(line1.includes('22h00'), `Ligne 1 doit contenir l\'heure. Got: ${line1}`);
    assert.ok(!line1.includes('<:heur:'), `Ligne 1 ne doit plus contenir l\'emoji heure. Got: ${line1}`);
  });

  test('ligne 2 Fearless Oui — texte sans emoji fearless', () => {
    const desc = buildScrimEmbed(makePayload('Gold', { fearless: 'oui' })).data.description ?? '';
    const line2 = desc.split('\n')[1];
    assert.ok(line2.includes('Fearless : Oui'), `Ligne 2 doit contenir Fearless : Oui. Got: ${line2}`);
    assert.ok(!line2.includes('<:fearless:'), `Ligne 2 ne doit pas contenir l\'emoji fearless. Got: ${line2}`);
  });

  test('ligne 2 Fearless Non — texte sans emoji fearless', () => {
    const desc = buildScrimEmbed(makePayload('Gold', { fearless: 'non' })).data.description ?? '';
    const line2 = desc.split('\n')[1];
    assert.ok(line2.includes('Fearless : Non'), `Ligne 2 doit contenir Fearless : Non. Got: ${line2}`);
  });

  test('ligne 2 sans Fearless — format seul', () => {
    const desc = buildScrimEmbed(makePayload('Gold', { fearless: null })).data.description ?? '';
    const line2 = desc.split('\n')[1];
    assert.ok(!line2.includes('Fearless'), `Ligne 2 sans fearless ne doit pas contenir Fearless. Got: ${line2}`);
  });

  test('ligne 3 : rang seul — Grandmaster / Challenger avec emoji challenger', () => {
    const desc = buildScrimEmbed(makePayload('Grandmaster / Challenger')).data.description ?? '';
    const line3 = desc.split('\n')[2];
    assert.ok(
      line3.includes('<:challenger:1521794520860069988> Grandmaster / Challenger'),
      `Ligne 3 doit être le rang avec emoji. Got: ${line3}`,
    );
  });

  test('ligne 3 : Émeraude / Diamant → emoji diamond', () => {
    const desc = buildScrimEmbed(makePayload('Émeraude / Diamant')).data.description ?? '';
    const line3 = desc.split('\n')[2];
    assert.ok(
      line3.includes('<:diamond:1521794418787749938> Émeraude / Diamant'),
      `Ligne 3 doit contenir l\'emoji diamond. Got: ${line3}`,
    );
  });

  test('embed actif — bloc aide présent', () => {
    const desc = buildScrimEmbed(makePayload('Gold')).data.description ?? '';
    assert.ok(desc.includes('cliquable'), 'Embed actif doit avoir le bloc aide');
  });
});
