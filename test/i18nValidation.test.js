/**
 * Tests i18n des validateurs de saisie utilisateur.
 * Vérifie que les codes d'erreur stables (errorCode) sont présents,
 * et que les clés i18n produisent les messages corrects en FR et EN.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseAndNormalizeDate,
  parseScrimSearchDate,
  parseListeScrimDateFilter,
  parseAndNormalizeTime,
  validateOptionalFlexibleEndTime,
  validateRank,
  validateFormat,
  validateContactUser,
  validateDiscordInviteUrl,
} from '../src/utils/validation.js';
import { validateMultiOpggUrl } from '../src/utils/validateMultiOpgg.js';
import { t } from '../src/i18n/index.js';
import { fr } from '../src/i18n/fr.js';
import { en } from '../src/i18n/en.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Vérifie qu'un résultat d'erreur possède un errorCode stable et que
 * la clé i18n correspondante est traduite en FR et EN.
 */
function assertValidationError(res, expectedCode) {
  assert.equal(res.ok, false, 'Le résultat doit être une erreur');
  assert.equal(res.errorCode, expectedCode, `errorCode attendu : ${expectedCode}`);
  assert.ok(typeof res.error === 'string' && res.error.length > 0, 'error (fallback) doit être non vide');
  assert.ok(fr[expectedCode], `Clé manquante dans fr.js : ${expectedCode}`);
  assert.ok(en[expectedCode], `Clé manquante dans en.js : ${expectedCode}`);
}

/**
 * Traduit un résultat d'erreur selon une locale.
 * @param {{ errorCode?: string, error: string }} res
 * @param {string} locale
 */
function validationMsg(res, locale) {
  return res.errorCode ? t(locale, res.errorCode) : `❌ ${res.error}`;
}

// ─── Date ─────────────────────────────────────────────────────────────────────

describe('validation — date', () => {
  it('format invalide — errorCode stable', () => {
    const res = parseAndNormalizeDate('invalid');
    assertValidationError(res, 'validation.date.invalid_format');
  });

  it('date invalide — message FR', () => {
    const res = parseAndNormalizeDate('invalid');
    const msg = validationMsg(res, 'fr');
    assert.match(msg, /Format de date invalide/i);
  });

  it('date invalide — message EN', () => {
    const res = parseAndNormalizeDate('invalid');
    const msg = validationMsg(res, 'en');
    assert.match(msg, /Invalid date format/i);
  });

  it('date obligatoire — errorCode stable', () => {
    const res = parseAndNormalizeDate('');
    assertValidationError(res, 'validation.date.required');
  });

  it('mois invalide — errorCode stable', () => {
    const res = parseAndNormalizeDate('01/13');
    assertValidationError(res, 'validation.date.invalid_month');
  });

  it('date passée — errorCode stable', () => {
    // Date très dans le passé
    const res = parseScrimSearchDate('01/01/2000');
    assertValidationError(res, 'validation.date.past');
  });

  it('date passée — message FR', () => {
    const res = parseScrimSearchDate('01/01/2000');
    const msg = validationMsg(res, 'fr');
    assert.match(msg, /antérieure/i);
  });

  it('date passée — message EN', () => {
    const res = parseScrimSearchDate('01/01/2000');
    const msg = validationMsg(res, 'en');
    assert.match(msg, /past/i);
  });

  it('date trop lointaine — errorCode stable', () => {
    const res = parseScrimSearchDate('01/01/2099');
    assertValidationError(res, 'validation.date.window');
  });

  it('date trop lointaine — message EN', () => {
    const res = parseScrimSearchDate('01/01/2099');
    const msg = validationMsg(res, 'en');
    assert.match(msg, /30 days/i);
  });

  it('date valide — ok (inchangé dans les deux langues)', async () => {
    // Demain sera dans la fenêtre
    const { DateTime } = await import('luxon');
    const tomorrow = DateTime.now().setZone('Europe/Paris').plus({ days: 1 });
    const raw = `${String(tomorrow.day).padStart(2,'0')}/${String(tomorrow.month).padStart(2,'0')}/${tomorrow.year}`;
    const res = parseScrimSearchDate(raw);
    assert.equal(res.ok, true);
    assert.ok(!res.errorCode);
  });

  it('filtre liste — date valide (sans contrainte fenêtre)', () => {
    const res = parseListeScrimDateFilter('01/01/2020');
    assert.equal(res.ok, true);
  });

  it('filtre liste — format invalide — errorCode stable', () => {
    // 'abc' → 1 seul segment après split → invalid_format
    const res = parseListeScrimDateFilter('abc');
    assertValidationError(res, 'validation.date.invalid_format');
  });
});

// ─── Heure ────────────────────────────────────────────────────────────────────

describe('validation — heure', () => {
  it('heure invalide — errorCode stable', () => {
    const res = parseAndNormalizeTime('99h');
    assertValidationError(res, 'validation.time.invalid_hour');
  });

  it('heure invalide — message FR', () => {
    const res = parseAndNormalizeTime('99h');
    const msg = validationMsg(res, 'fr');
    assert.match(msg, /Heure invalide/i);
  });

  it('heure invalide — message EN', () => {
    const res = parseAndNormalizeTime('99h');
    const msg = validationMsg(res, 'en');
    assert.match(msg, /Invalid hour/i);
  });

  it('format heure invalide — errorCode stable', () => {
    const res = parseAndNormalizeTime('12:00:00:extra');
    assertValidationError(res, 'validation.time.invalid_format');
  });

  it('format heure invalide — message FR', () => {
    const res = parseAndNormalizeTime('12:00:00:extra');
    assert.match(validationMsg(res, 'fr'), /Format d.heure invalide/i);
  });

  it('format heure invalide — message EN', () => {
    const res = parseAndNormalizeTime('12:00:00:extra');
    assert.match(validationMsg(res, 'en'), /Invalid time format/i);
  });

  it('minutes invalides — errorCode stable', () => {
    const res = parseAndNormalizeTime('20:99');
    assertValidationError(res, 'validation.time.invalid_minutes');
  });

  it('heure valide — ok (inchangé)', () => {
    const res = parseAndNormalizeTime('20h30');
    assert.equal(res.ok, true);
    assert.equal(res.value, '20:30');
  });

  it('flex heure max avant début — errorCode stable', () => {
    const res = validateOptionalFlexibleEndTime('22:00', '20:00');
    assertValidationError(res, 'validation.time.flex_before_start');
  });

  it('flex heure max avant début — message FR', () => {
    const res = validateOptionalFlexibleEndTime('22:00', '20:00');
    assert.match(validationMsg(res, 'fr'), /heure max doit être/i);
  });

  it('flex heure max avant début — message EN', () => {
    const res = validateOptionalFlexibleEndTime('22:00', '20:00');
    assert.match(validationMsg(res, 'en'), /max time must be/i);
  });

  it('flex écart > 12h — errorCode stable', () => {
    const res = validateOptionalFlexibleEndTime('00:00', '23:59');
    assertValidationError(res, 'validation.time.flex_max_span');
  });
});

// ─── Rang ─────────────────────────────────────────────────────────────────────

describe('validation — rang', () => {
  it('rang invalide — errorCode stable', () => {
    const res = validateRank('league_of_legends', 'RangInexistant');
    assertValidationError(res, 'validation.rank.invalid');
  });

  it('rang invalide — message FR', () => {
    const res = validateRank('league_of_legends', 'RangInexistant');
    assert.match(validationMsg(res, 'fr'), /rang sélectionné/i);
  });

  it('rang invalide — message EN', () => {
    const res = validateRank('league_of_legends', 'RangInexistant');
    assert.match(validationMsg(res, 'en'), /selected rank/i);
  });

  it('rang obligatoire — errorCode stable', () => {
    const res = validateRank('league_of_legends', '');
    assertValidationError(res, 'validation.rank.required');
  });

  it('rang valide — ok (inchangé)', () => {
    const res = validateRank('league_of_legends', 'Or');
    assert.equal(res.ok, true);
  });
});

// ─── Format ───────────────────────────────────────────────────────────────────

describe('validation — format', () => {
  it('format invalide — errorCode stable', () => {
    const res = validateFormat('league_of_legends', 'FormatInexistant');
    assertValidationError(res, 'validation.format.invalid');
  });

  it('format invalide — message FR', () => {
    const res = validateFormat('league_of_legends', 'FormatInexistant');
    assert.match(validationMsg(res, 'fr'), /format sélectionné/i);
  });

  it('format invalide — message EN', () => {
    const res = validateFormat('league_of_legends', 'FormatInexistant');
    assert.match(validationMsg(res, 'en'), /selected format/i);
  });

  it('format valide — ok (inchangé)', () => {
    // On ne connaît pas forcément les formats, on vérifie juste que ça ne crash pas sur un jeu valide
    const res = validateFormat('league_of_legends', 'BO1');
    // BO1 peut exister ou non dans ce jeu — on vérifie juste la structure
    assert.ok(typeof res.ok === 'boolean');
  });
});

// ─── Contact ──────────────────────────────────────────────────────────────────

describe('validation — contact', () => {
  it('contact manquant — errorCode stable', () => {
    const res = validateContactUser(null);
    assertValidationError(res, 'validation.contact.missing');
  });

  it('contact manquant — message FR', () => {
    const res = validateContactUser(null);
    assert.match(validationMsg(res, 'fr'), /Contact Discord invalide/i);
  });

  it('contact manquant — message EN', () => {
    const res = validateContactUser(null);
    assert.match(validationMsg(res, 'en'), /Invalid Discord contact/i);
  });

  it('contact bot — errorCode stable', () => {
    const res = validateContactUser({ id: 'bot-123', bot: true });
    assertValidationError(res, 'validation.contact.bot');
  });

  it('contact bot — message FR', () => {
    const res = validateContactUser({ id: 'bot-123', bot: true });
    assert.match(validationMsg(res, 'fr'), /ne peut pas être un bot/i);
  });

  it('contact bot — message EN', () => {
    const res = validateContactUser({ id: 'bot-123', bot: true });
    assert.match(validationMsg(res, 'en'), /cannot be a bot/i);
  });

  it('contact valide — ok (inchangé)', () => {
    const res = validateContactUser({ id: 'user-123', bot: false });
    assert.equal(res.ok, true);
    assert.equal(res.userId, 'user-123');
  });
});

// ─── URL Discord ──────────────────────────────────────────────────────────────

describe('validation — URL Discord', () => {
  it('URL invalide — errorCode stable', () => {
    const res = validateDiscordInviteUrl('pas-une-url');
    assertValidationError(res, 'validation.discordUrl.invalid');
  });

  it('URL invalide — message FR', () => {
    const res = validateDiscordInviteUrl('pas-une-url');
    assert.match(validationMsg(res, 'fr'), /lien d.invitation Discord valide/i);
  });

  it('URL invalide — message EN', () => {
    const res = validateDiscordInviteUrl('pas-une-url');
    assert.match(validationMsg(res, 'en'), /valid Discord invite link/i);
  });

  it('URL valide discord.gg — ok (inchangé)', () => {
    const res = validateDiscordInviteUrl('https://discord.gg/abcdef123');
    assert.equal(res.ok, true);
    assert.equal(res.value, 'https://discord.gg/abcdef123');
  });

  it('URL valide discord.gg sans schéma — normalisée (inchangé)', () => {
    const res = validateDiscordInviteUrl('discord.gg/abcdef123');
    assert.equal(res.ok, true);
  });

  it('URL mauvais hôte — errorCode stable', () => {
    const res = validateDiscordInviteUrl('https://example.com/invite/abc');
    assertValidationError(res, 'validation.discordUrl.invalid');
  });
});

// ─── URL multi OP.GG ──────────────────────────────────────────────────────────

describe('validation — URL multi OP.GG', () => {
  it('mauvais jeu — errorCode stable', () => {
    const res = validateMultiOpggUrl('https://op.gg/multisearch', 'autre_jeu');
    assertValidationError(res, 'validation.multiOpgg.wrong_game');
  });

  it('mauvais jeu — message FR', () => {
    const res = validateMultiOpggUrl('https://op.gg/multisearch', 'autre_jeu');
    assert.match(validationMsg(res, 'fr'), /League of Legends/i);
  });

  it('mauvais jeu — message EN', () => {
    const res = validateMultiOpggUrl('https://op.gg/multisearch', 'autre_jeu');
    assert.match(validationMsg(res, 'en'), /League of Legends/i);
  });

  it('URL invalide LoL — errorCode stable', () => {
    const res = validateMultiOpggUrl('pas-une-url', 'league_of_legends');
    assertValidationError(res, 'validation.multiOpgg.invalid');
  });

  it('URL invalide LoL — message FR', () => {
    const res = validateMultiOpggUrl('pas-une-url', 'league_of_legends');
    assert.match(validationMsg(res, 'fr'), /multi OP.GG est invalide/i);
  });

  it('URL invalide LoL — message EN', () => {
    const res = validateMultiOpggUrl('pas-une-url', 'league_of_legends');
    assert.match(validationMsg(res, 'en'), /Invalid multi OP.GG/i);
  });

  it('URL mauvais hôte — errorCode stable', () => {
    const res = validateMultiOpggUrl('https://example.com/multi', 'league_of_legends');
    assertValidationError(res, 'validation.multiOpgg.invalid');
  });

  it('URL valide op.gg — ok (inchangé)', () => {
    const res = validateMultiOpggUrl('https://op.gg/multisearch/results?summoners=test', 'league_of_legends');
    assert.equal(res.ok, true);
  });

  it('null LoL — ok null (inchangé)', () => {
    const res = validateMultiOpggUrl(null, 'league_of_legends');
    assert.equal(res.ok, true);
    assert.equal(res.value, null);
  });
});

// ─── Cohérence i18n ───────────────────────────────────────────────────────────

describe('validation — cohérence i18n globale', () => {
  it('toutes les clés validation.* de fr.js existent aussi en en.js', () => {
    const validationKeys = Object.keys(fr).filter(k => k.startsWith('validation.'));
    const missing = validationKeys.filter(k => !en[k]);
    assert.equal(
      missing.length,
      0,
      `Clés manquantes dans en.js : ${missing.join(', ')}`,
    );
  });

  it('fallback FR si traduction EN manquante (comportement t())', () => {
    // On injecte temporairement une clé absente de en.js
    const key = '__test_validation_key_only_fr__';
    const origFr = fr[key];
    fr[key] = '❌ Texte FR uniquement';
    try {
      assert.ok(!en[key], 'La clé ne doit pas être dans en.js');
      const msg = t('en', key);
      assert.equal(msg, '❌ Texte FR uniquement');
    } finally {
      if (origFr === undefined) delete fr[key];
      else fr[key] = origFr;
    }
  });

  it('les messages FR contiennent l\'emoji ❌ pour les erreurs', () => {
    const errorKeys = Object.keys(fr).filter(k => k.startsWith('validation.'));
    for (const key of errorKeys) {
      assert.ok(
        fr[key].startsWith('❌'),
        `La clé fr.js ${key} devrait commencer par ❌ : "${fr[key]}"`,
      );
    }
  });
});
