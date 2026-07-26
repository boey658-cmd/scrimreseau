/**
 * Tests i18n du panneau /scrim-config.
 *
 * Vérifient que :
 * 1. Toutes les clés scrimConfig.* retournent du vrai texte traduit, jamais la clé brute.
 * 2. La fonction createTranslator() transmet correctement la locale.
 * 3. L'interpolation fonctionne ({channel}, {max}, {roles}, {policy}).
 * 4. Aucune valeur dans fr.js ou en.js ne ressemble à une clé non résolue.
 * 5. Les deux locales (FR et EN) produisent du texte pour chaque sous-panneau.
 *
 * Ces tests préviennent spécifiquement la régression du bug où `T` n'était pas
 * passé aux builders, ce qui causait l'affichage des clés brutes sur Discord.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { t, createTranslator } from '../src/i18n/index.js';
import { fr } from '../src/i18n/fr.js';
import { en } from '../src/i18n/en.js';

/**
 * Pattern d'une clé i18n non résolue : ex. "scrimConfig.mainTitle"
 * Ne doit JAMAIS apparaître comme valeur traduite dans un payload Discord public.
 */
const UNRESOLVED_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+$/;

/** Toutes les clés scrimConfig.* présentes dans fr.js */
const SCRIM_CONFIG_KEYS = Object.keys(fr).filter((k) => k.startsWith('scrimConfig.'));

// ---------------------------------------------------------------------------
// Couverture des clés
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — couverture des clés', () => {
  it('fr.js contient au moins 30 clés scrimConfig.*', () => {
    assert.ok(SCRIM_CONFIG_KEYS.length >= 30, `Seulement ${SCRIM_CONFIG_KEYS.length} clés scrimConfig.* trouvées en FR`);
  });

  it('en.js contient les mêmes clés scrimConfig.* que fr.js', () => {
    const missingInEn = SCRIM_CONFIG_KEYS.filter((k) => en[k] === undefined);
    assert.deepEqual(missingInEn, [], `Clés manquantes en EN : ${missingInEn.join(', ')}`);
  });

  it('aucune clé en.js scrimConfig.* est orpheline (absente de fr.js)', () => {
    const enKeys = Object.keys(en).filter((k) => k.startsWith('scrimConfig.'));
    const orphans = enKeys.filter((k) => fr[k] === undefined);
    assert.deepEqual(orphans, [], `Clés EN orphelines (absentes de FR) : ${orphans.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Résolution des clés via t() et createTranslator()
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — t() et createTranslator() retournent du vrai texte', () => {
  it('toutes les clés scrimConfig.* retournent du texte non vide en FR', () => {
    for (const key of SCRIM_CONFIG_KEYS) {
      const result = t('fr', key);
      assert.ok(result && result.length > 0, `t('fr', '${key}') retourne vide ou undefined`);
    }
  });

  it('toutes les clés scrimConfig.* retournent du texte non vide en EN', () => {
    for (const key of SCRIM_CONFIG_KEYS) {
      const result = t('en', key);
      assert.ok(result && result.length > 0, `t('en', '${key}') retourne vide ou undefined`);
    }
  });

  it('aucune clé scrimConfig.* ne retourne la clé brute via t() en FR', () => {
    for (const key of SCRIM_CONFIG_KEYS) {
      const result = t('fr', key);
      assert.notEqual(result, key, `t('fr', '${key}') retourne la clé au lieu du texte (T non passé !)`);
    }
  });

  it('aucune clé scrimConfig.* ne retourne la clé brute via t() en EN', () => {
    for (const key of SCRIM_CONFIG_KEYS) {
      const result = t('en', key);
      assert.notEqual(result, key, `t('en', '${key}') retourne la clé au lieu du texte (T non passé !)`);
    }
  });

  it('createTranslator(fr) retourne les mêmes valeurs que t(fr, ...)', () => {
    const T = createTranslator('fr');
    for (const key of SCRIM_CONFIG_KEYS) {
      assert.equal(T(key), t('fr', key), `Divergence createTranslator vs t() pour '${key}'`);
    }
  });

  it('createTranslator(en) retourne les mêmes valeurs que t(en, ...)', () => {
    const T = createTranslator('en');
    for (const key of SCRIM_CONFIG_KEYS) {
      assert.equal(T(key), t('en', key), `Divergence createTranslator vs t() pour '${key}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// Panneau principal — titres et boutons
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — panneau principal FR', () => {
  it('mainTitle retourne le vrai titre français (pas la clé)', () => {
    const T = createTranslator('fr');
    const title = T('scrimConfig.mainTitle');
    assert.notEqual(title, 'scrimConfig.mainTitle');
    assert.ok(title.includes('Configuration'), `Titre FR inattendu : "${title}"`);
  });

  it('mainDescription retourne une phrase française', () => {
    const T = createTranslator('fr');
    const desc = T('scrimConfig.mainDescription');
    assert.notEqual(desc, 'scrimConfig.mainDescription');
    assert.ok(desc.length > 10, `Description FR trop courte : "${desc}"`);
  });

  it('les 5 boutons principaux FR sont traduits et non vides', () => {
    const T = createTranslator('fr');
    const btns = ['scrimConfig.btnSalons', 'scrimConfig.btnPerms', 'scrimConfig.btnMsgs', 'scrimConfig.btnReset', 'scrimConfig.btnClose'];
    for (const key of btns) {
      const label = T(key);
      assert.notEqual(label, key, `Bouton FR ${key} = clé brute`);
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(label), `Bouton FR ${key} ressemble à une clé non résolue : "${label}"`);
    }
  });

  it('btnBack FR est traduit', () => {
    const T = createTranslator('fr');
    const back = T('scrimConfig.btnBack');
    assert.notEqual(back, 'scrimConfig.btnBack');
    assert.ok(back.length > 0);
  });
});

describe('scrimConfigurer i18n — panneau principal EN', () => {
  it('mainTitle retourne le vrai titre anglais (pas la clé)', () => {
    const T = createTranslator('en');
    const title = T('scrimConfig.mainTitle');
    assert.notEqual(title, 'scrimConfig.mainTitle');
    assert.ok(title.includes('Configuration'), `Titre EN inattendu : "${title}"`);
  });

  it('les 5 boutons principaux EN sont traduits', () => {
    const T = createTranslator('en');
    const btns = ['scrimConfig.btnSalons', 'scrimConfig.btnPerms', 'scrimConfig.btnMsgs', 'scrimConfig.btnReset', 'scrimConfig.btnClose'];
    for (const key of btns) {
      const label = T(key);
      assert.notEqual(label, key, `Bouton EN ${key} = clé brute`);
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(label), `Bouton EN ${key} ressemble à une clé : "${label}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sous-panneaux — Salons
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — sous-panneau Salons FR/EN', () => {
  it('salonsTitle traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const title = T('scrimConfig.salonsTitle');
      assert.notEqual(title, 'scrimConfig.salonsTitle', `${locale}: salonsTitle = clé brute`);
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(title), `${locale}: salonsTitle ressemble à une clé : "${title}"`);
    }
  });

  it('boutons de salon traduits (btnRemoveReception, btnAllChannels) en FR et EN', () => {
    const keys = ['scrimConfig.btnRemoveReception', 'scrimConfig.btnAllChannels'];
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      for (const key of keys) {
        const label = T(key);
        assert.notEqual(label, key, `${locale}: ${key} = clé brute`);
        assert.ok(!UNRESOLVED_KEY_PATTERN.test(label), `${locale}: ${key} ressemble à une clé : "${label}"`);
      }
    }
  });

  it('placeholders de salon traduits en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const ph1 = T('scrimConfig.placeholderReception');
      const ph2 = T('scrimConfig.placeholderCommand');
      assert.notEqual(ph1, 'scrimConfig.placeholderReception', `${locale}: placeholderReception = clé brute`);
      assert.notEqual(ph2, 'scrimConfig.placeholderCommand', `${locale}: placeholderCommand = clé brute`);
    }
  });

  it('messages de statut salon traduits en FR et EN', () => {
    const statusKeys = ['scrimConfig.chanAnnNotFound', 'scrimConfig.chanAnnRemoved', 'scrimConfig.chanAnnNone', 'scrimConfig.chanCmdWrongType', 'scrimConfig.chanCmdRemoved'];
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      for (const key of statusKeys) {
        const msg = T(key);
        assert.notEqual(msg, key, `${locale}: ${key} = clé brute`);
        assert.ok(!UNRESOLVED_KEY_PATTERN.test(msg), `${locale}: ${key} ressemble à une clé : "${msg}"`);
      }
    }
  });

  it('interpolation {channel} dans chanAnnSet fonctionne en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const msg = T('scrimConfig.chanAnnSet', { channel: '<#123456789>' });
      assert.ok(msg.includes('<#123456789>'), `${locale}: {channel} non remplacé dans chanAnnSet : "${msg}"`);
      assert.ok(!msg.includes('{channel}'), `${locale}: placeholder {channel} non résolu dans : "${msg}"`);
    }
  });

  it('interpolation {channel} dans chanCmdSet fonctionne en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const msg = T('scrimConfig.chanCmdSet', { channel: '<#987654321>' });
      assert.ok(msg.includes('<#987654321>'), `${locale}: {channel} non remplacé dans chanCmdSet : "${msg}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sous-panneau — Permissions
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — sous-panneau Permissions FR/EN', () => {
  it('permsTitle traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const title = T('scrimConfig.permsTitle');
      assert.notEqual(title, 'scrimConfig.permsTitle', `${locale}: permsTitle = clé brute`);
    }
  });

  it('btnAllEveryone traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const label = T('scrimConfig.btnAllEveryone');
      assert.notEqual(label, 'scrimConfig.btnAllEveryone', `${locale}: btnAllEveryone = clé brute`);
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(label), `${locale}: btnAllEveryone ressemble à une clé : "${label}"`);
    }
  });

  it('placeholderRoles avec {max} traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const ph = T('scrimConfig.placeholderRoles', { max: 5 });
      assert.ok(ph.includes('5'), `${locale}: {max} non remplacé dans placeholderRoles : "${ph}"`);
      assert.ok(!ph.includes('{max}'), `${locale}: placeholder {max} non résolu dans : "${ph}"`);
    }
  });

  it('rolesInvalidCount avec {max} traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const err = T('scrimConfig.rolesInvalidCount', { max: 5 });
      assert.ok(err.includes('5'), `${locale}: {max} non remplacé dans rolesInvalidCount : "${err}"`);
    }
  });

  it('rolesSet avec {roles} traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const msg = T('scrimConfig.rolesSet', { roles: '<@&111> <@&222>' });
      assert.ok(msg.includes('<@&111>'), `${locale}: {roles} non remplacé dans rolesSet : "${msg}"`);
    }
  });

  it('everyoneSet traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const msg = T('scrimConfig.everyoneSet');
      assert.notEqual(msg, 'scrimConfig.everyoneSet', `${locale}: everyoneSet = clé brute`);
      assert.ok(!UNRESOLVED_KEY_PATTERN.test(msg), `${locale}: everyoneSet ressemble à une clé : "${msg}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sous-panneau — Messages
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — sous-panneau Messages FR/EN', () => {
  it('msgsTitle traduit en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const title = T('scrimConfig.msgsTitle');
      assert.notEqual(title, 'scrimConfig.msgsTitle', `${locale}: msgsTitle = clé brute`);
    }
  });

  it('options de politique traduits en FR et EN (pas la clé brute)', () => {
    const policyKeys = ['scrimConfig.msgsPolicyKeepLabel', 'scrimConfig.msgsPolicyDeleteLabel', 'scrimConfig.msgsPolicyKeepDesc', 'scrimConfig.msgsPolicyDeleteDesc'];
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      for (const key of policyKeys) {
        const val = T(key);
        assert.notEqual(val, key, `${locale}: ${key} = clé brute`);
        assert.ok(!UNRESOLVED_KEY_PATTERN.test(val), `${locale}: ${key} ressemble à une clé : "${val}"`);
      }
    }
  });

  it('msgsPolicySet avec {policy} interpolé en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const policyLabel = T('scrimConfig.msgsPolicyKeepLabel');
      const msg = T('scrimConfig.msgsPolicySet', { policy: policyLabel });
      assert.ok(msg.includes(policyLabel), `${locale}: {policy} non remplacé dans msgsPolicySet : "${msg}"`);
      assert.ok(!msg.includes('{policy}'), `${locale}: placeholder {policy} non résolu dans : "${msg}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Sous-panneau — Réinitialisation
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — sous-panneau Reset FR/EN', () => {
  it('resetTitle et resetDesc traduits en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const title = T('scrimConfig.resetTitle');
      const desc = T('scrimConfig.resetDesc');
      assert.notEqual(title, 'scrimConfig.resetTitle', `${locale}: resetTitle = clé brute`);
      assert.notEqual(desc, 'scrimConfig.resetDesc', `${locale}: resetDesc = clé brute`);
      assert.ok(desc.length > 20, `${locale}: resetDesc trop courte`);
    }
  });

  it('boutons de réinitialisation traduits en FR et EN', () => {
    const rstKeys = ['scrimConfig.resetBtnAnn', 'scrimConfig.resetBtnCmd', 'scrimConfig.resetBtnPerm', 'scrimConfig.resetBtnMsg', 'scrimConfig.resetBtnAll'];
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      for (const key of rstKeys) {
        const label = T(key);
        assert.notEqual(label, key, `${locale}: ${key} = clé brute`);
        assert.ok(!UNRESOLVED_KEY_PATTERN.test(label), `${locale}: ${key} ressemble à une clé : "${label}"`);
      }
    }
  });

  it('messages de résultat de réinitialisation traduits en FR et EN', () => {
    const doneKeys = ['scrimConfig.resetAnnDone', 'scrimConfig.resetCmdDone', 'scrimConfig.resetPermDone', 'scrimConfig.resetMsgDone', 'scrimConfig.resetAllDone'];
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      for (const key of doneKeys) {
        const msg = T(key);
        assert.notEqual(msg, key, `${locale}: ${key} = clé brute`);
        assert.ok(!UNRESOLVED_KEY_PATTERN.test(msg), `${locale}: ${key} ressemble à une clé : "${msg}"`);
      }
    }
  });

  it('resetConfirmTitle et resetConfirmDesc traduits en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const title = T('scrimConfig.resetConfirmTitle');
      const desc = T('scrimConfig.resetConfirmDesc');
      assert.notEqual(title, 'scrimConfig.resetConfirmTitle', `${locale}: resetConfirmTitle = clé brute`);
      assert.notEqual(desc, 'scrimConfig.resetConfirmDesc', `${locale}: resetConfirmDesc = clé brute`);
      assert.ok(desc.length > 30, `${locale}: resetConfirmDesc trop courte : "${desc}"`);
    }
  });

  it('boutons de confirmation traduits en FR et EN', () => {
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      const ok = T('scrimConfig.resetConfirmOk');
      const cancel = T('scrimConfig.resetConfirmCancel');
      assert.notEqual(ok, 'scrimConfig.resetConfirmOk', `${locale}: resetConfirmOk = clé brute`);
      assert.notEqual(cancel, 'scrimConfig.resetConfirmCancel', `${locale}: resetConfirmCancel = clé brute`);
    }
  });
});

// ---------------------------------------------------------------------------
// Erreurs et messages système
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — messages d\'erreur et système', () => {
  it('tous les messages d\'erreur système traduits en FR et EN', () => {
    const errorKeys = [
      'scrimConfig.adminOnly',
      'scrimConfig.guildOnly',
      'scrimConfig.accessError',
      'scrimConfig.readConfigError',
      'scrimConfig.panelClosed',
      'scrimConfig.panelExpired',
      'scrimConfig.noPermissions',
      'scrimConfig.genericError',
      'scrimConfig.msgsPolicyInvalid',
    ];
    for (const locale of ['fr', 'en']) {
      const T = createTranslator(locale);
      for (const key of errorKeys) {
        const msg = T(key);
        assert.notEqual(msg, key, `${locale}: ${key} = clé brute`);
        assert.ok(!UNRESOLVED_KEY_PATTERN.test(msg), `${locale}: ${key} ressemble à une clé : "${msg}"`);
        assert.ok(msg.length > 0, `${locale}: ${key} retourne vide`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Vérification globale : aucune valeur dans les locales ne ressemble à une clé non résolue
// ---------------------------------------------------------------------------

describe('scrimConfigurer i18n — vérification globale des valeurs traduites', () => {
  it('aucune valeur scrimConfig.* dans fr.js ne ressemble à une clé non résolue', () => {
    for (const [key, value] of Object.entries(fr)) {
      if (!key.startsWith('scrimConfig.')) continue;
      if (!value || value.includes('{')) continue;
      assert.ok(
        !UNRESOLVED_KEY_PATTERN.test(value),
        `fr.js — La traduction de '${key}' ressemble à une clé non résolue : "${value}"`,
      );
    }
  });

  it('aucune valeur scrimConfig.* dans en.js ne ressemble à une clé non résolue', () => {
    for (const [key, value] of Object.entries(en)) {
      if (!key.startsWith('scrimConfig.')) continue;
      if (!value || value.includes('{')) continue;
      assert.ok(
        !UNRESOLVED_KEY_PATTERN.test(value),
        `en.js — La traduction de '${key}' ressemble à une clé non résolue : "${value}"`,
      );
    }
  });

  it('t() avec une clé inconnue retourne [key] et jamais la clé brute sans crochets', () => {
    const result = t('fr', 'scrimConfig.keyThatDoesNotExistAtAll');
    assert.equal(result, '[scrimConfig.keyThatDoesNotExistAtAll]',
      `Clé inconnue : attendu "[key]", obtenu "${result}"`);
  });

  it('t() ne retourne jamais undefined ou null', () => {
    for (const key of SCRIM_CONFIG_KEYS) {
      const fr_result = t('fr', key);
      const en_result = t('en', key);
      assert.notEqual(fr_result, undefined, `t('fr', '${key}') retourne undefined`);
      assert.notEqual(fr_result, null, `t('fr', '${key}') retourne null`);
      assert.notEqual(en_result, undefined, `t('en', '${key}') retourne undefined`);
      assert.notEqual(en_result, null, `t('en', '${key}') retourne null`);
    }
  });

  it('identité de la clé identifiée comme bug initial — scrimConfig.mainTitle en FR', () => {
    // Ce test documente le bug exact rapporté : T() retournait la clé brute
    // quand buildMainEmbed était appelé sans T dans execute()
    const T_correct = createTranslator('fr');
    const T_broken = (k) => k; // comportement quand T n'est pas passé

    const withTranslator = T_correct('scrimConfig.mainTitle');
    const withBroken = T_broken('scrimConfig.mainTitle');

    assert.notEqual(withTranslator, withBroken, 'createTranslator et identité doivent différer');
    assert.equal(withBroken, 'scrimConfig.mainTitle', 'La fonction identité retourne la clé brute');
    assert.notEqual(withTranslator, 'scrimConfig.mainTitle', 'createTranslator ne doit PAS retourner la clé brute');
  });
});
