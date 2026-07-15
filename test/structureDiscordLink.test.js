import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscordInviteUrl } from '../src/utils/validation.js';
import { buildScrimEmbed } from '../src/services/scrimEmbedBuilder.js';

// ---------------------------------------------------------------------------
// validateDiscordInviteUrl
// ---------------------------------------------------------------------------

/** Payload minimal pour buildScrimEmbed (structure optionnelle) */
function makePayload(extra = {}) {
  return {
    gameKey: 'league_of_legends',
    rank: 'Gold',
    dateStr: '01/07/2026',
    timeStr: '21h00',
    format: 'BO3',
    contactUserId: '111111111111111111',
    contactDisplayName: 'testuser',
    fearless: null,
    ...extra,
  };
}

describe('validateDiscordInviteUrl — liens acceptés', () => {
  test('https://discord.gg/code → OK, normalisé', () => {
    const r = validateDiscordInviteUrl('https://discord.gg/abc123');
    assert.ok(r.ok);
    assert.equal(r.value, 'https://discord.gg/abc123');
  });

  test('https://discord.com/invite/code → OK, normalisé vers discord.gg', () => {
    const r = validateDiscordInviteUrl('https://discord.com/invite/abc123');
    assert.ok(r.ok);
    assert.equal(r.value, 'https://discord.gg/abc123');
  });

  test('https://discordapp.com/invite/code → OK, normalisé vers discord.gg', () => {
    const r = validateDiscordInviteUrl('https://discordapp.com/invite/abc123');
    assert.ok(r.ok);
    assert.equal(r.value, 'https://discord.gg/abc123');
  });

  test('discord.gg/code (sans https) → normalisé automatiquement', () => {
    const r = validateDiscordInviteUrl('discord.gg/abc123');
    assert.ok(r.ok);
    assert.equal(r.value, 'https://discord.gg/abc123');
  });

  test('espaces autour → accepté après trim', () => {
    const r = validateDiscordInviteUrl('  https://discord.gg/abc123  ');
    assert.ok(r.ok);
    assert.equal(r.value, 'https://discord.gg/abc123');
  });
});

describe('validateDiscordInviteUrl — liens refusés', () => {
  test('https://discord.gg/ (sans code) → refusé', () => {
    const r = validateDiscordInviteUrl('https://discord.gg/');
    assert.ok(!r.ok);
  });

  test('https://google.com → refusé', () => {
    const r = validateDiscordInviteUrl('https://google.com');
    assert.ok(!r.ok);
  });

  test('javascript:alert(1) → refusé (protocol non https)', () => {
    const r = validateDiscordInviteUrl('javascript:alert(1)');
    assert.ok(!r.ok);
  });

  test('faux domaine discord.gg.evil.com → refusé', () => {
    const r = validateDiscordInviteUrl('https://discord.gg.evil.com/invite/code');
    assert.ok(!r.ok);
  });

  test('texte autour du lien → refusé', () => {
    const r = validateDiscordInviteUrl('rejoins-nous : https://discord.gg/abc123');
    assert.ok(!r.ok);
  });

  test('chaîne vide → refusé', () => {
    const r = validateDiscordInviteUrl('');
    assert.ok(!r.ok);
  });

  test('null → refusé', () => {
    const r = validateDiscordInviteUrl(null);
    assert.ok(!r.ok);
  });
});

// ---------------------------------------------------------------------------
// Embed — ligne structure
// ---------------------------------------------------------------------------

describe('buildScrimEmbed — ligne structure', () => {
  test('avec structureNameSnapshot + structureInviteUrl → lien markdown dans la description', () => {
    const desc = buildScrimEmbed(makePayload({
      structureNameSnapshot: 'Demo Server',
      structureInviteUrl: 'https://discord.gg/demo',
    })).data.description ?? '';
    assert.ok(
      desc.includes('[Demo Server](https://discord.gg/demo)'),
      `Attendu un lien markdown. Description reçue:\n${desc}`,
    );
    assert.ok(
      !desc.includes('https://discord.gg/demo\n') && !desc.includes('https://discord.gg/demo '),
      `L'URL ne doit pas apparaître en brut après le lien. Description:\n${desc}`,
    );
  });

  test('avec structureNameSnapshot sans structureInviteUrl → texte simple, pas de lien markdown', () => {
    const desc = buildScrimEmbed(makePayload({
      structureNameSnapshot: 'Demo Server',
      structureInviteUrl: null,
    })).data.description ?? '';
    assert.ok(
      desc.includes('🌐 Structure : Demo Server'),
      `Attendu texte simple. Description:\n${desc}`,
    );
    assert.ok(
      !desc.includes('[Demo Server]'),
      `Aucun lien markdown attendu. Description:\n${desc}`,
    );
  });

  test('sans structureNameSnapshot → ligne structure absente', () => {
    const desc = buildScrimEmbed(makePayload({
      structureNameSnapshot: null,
      structureInviteUrl: null,
    })).data.description ?? '';
    assert.ok(
      !desc.includes('🌐 Structure'),
      `Ligne structure ne doit pas apparaître. Description:\n${desc}`,
    );
  });

  test('injection markdown dans le nom — ] ( ) échappés, lien pointe vers l\'URL sûre', () => {
    const maliciousName = 'x](https://evil.com)';
    const safeUrl = 'https://discord.gg/safe';
    const desc = buildScrimEmbed(makePayload({
      structureNameSnapshot: maliciousName,
      structureInviteUrl: safeUrl,
    })).data.description ?? '';

    // Le pattern d'injection ](evil.com) NE doit pas apparaître tel quel (il serait parsé comme lien)
    assert.ok(
      !desc.includes('](https://evil.com)'),
      `Le pattern d'injection markdown ne doit pas être présent. Description:\n${desc}`,
    );
    // Le lien sûr doit être la cible du lien markdown
    assert.ok(
      desc.includes('](https://discord.gg/safe)'),
      `L'URL sûre doit être la cible du lien. Description:\n${desc}`,
    );
    // Les caractères ] et ( du nom doivent être échappés avec un backslash
    assert.ok(
      desc.includes('\\]') && desc.includes('\\('),
      `Les caractères ] et ( doivent être échappés. Description:\n${desc}`,
    );
  });
});
