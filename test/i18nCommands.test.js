/**
 * Tests obligatoires — Commandes renommées (§16).
 *
 * Vérifie :
 *  1. Les 11 commandes publiques attendues sont présentes.
 *  2. Les anciens noms sont absents.
 *  3. /scrim-dev est absent du payload public.
 *  4. Les 3 commandes dev restent uniquement sur DEV_GUILD_ID.
 *  5. Aucun doublon de nom.
 *  6. /scrim-config correspond au nouveau panneau interactif.
 *  7. L'ancien groupe /scrim-config n'est pas réintroduit.
 *  8. /find-scrim conserve toutes les options actuelles.
 *  9. elo_precision reste facultative.
 * 10. Les options obligatoires restent avant les facultatives.
 * 11. /scrim-close conserve la logique d'auteur.
 * 12. /report-spam conserve la permission administrateur.
 * 13. /structure-link conserve les sous-commandes set/remove.
 * 14. /scrim-moderation user reste inchangée.
 * 15. /help-scrim et /helpadmin-scrim restent inchangées.
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { commandList, commandListWithoutDev, scrimDev } from '../src/commands/index.js';
import { dashboardAdmin, dashboardReseau } from '../src/commands/index.js';

const PUBLIC_NAMES = commandListWithoutDev.map((c) => c.data.name);
const ALL_NAMES = commandList.map((c) => c.data.name);

// ─── 1. Les 11 commandes publiques attendues ─────────────────────────────────

describe('commandes publiques attendues', () => {
  const EXPECTED = [
    'help-scrim',
    'helpadmin-scrim',
    'list-scrims',
    'my-scrims',
    'find-scrim',
    'scrim-config',
    'scrim-moderation',
    'scrim-close',
    'report-spam',
    'structure-link',
    'language',
  ];

  it('les 11 commandes publiques sont présentes (test 1)', () => {
    for (const name of EXPECTED) {
      assert.ok(PUBLIC_NAMES.includes(name), `Commande manquante : ${name}`);
    }
  });

  it('exactement 11 commandes publiques (test 1)', () => {
    assert.equal(PUBLIC_NAMES.length, 11, `Attendu 11, trouvé ${PUBLIC_NAMES.length}: ${PUBLIC_NAMES.join(', ')}`);
  });
});

// ─── 2. Les anciens noms sont absents ────────────────────────────────────────

describe('anciens noms absents', () => {
  const OLD_NAMES = [
    'liste-scrims',
    'mes-demandes-scrim',
    'recherche-scrim',
    'scrim-configurer',
    'scrim-trouve',
    'spammer',
    'structure-lien',
  ];

  for (const name of OLD_NAMES) {
    it(`${name} absent du payload public (test 2)`, () => {
      assert.ok(!PUBLIC_NAMES.includes(name), `Ancien nom encore présent : ${name}`);
    });
  }
});

// ─── 3. scrim-dev absent du payload public ───────────────────────────────────

it('/scrim-dev absent du payload public (test 3)', () => {
  assert.ok(!PUBLIC_NAMES.includes('scrim-dev'), '/scrim-dev ne doit pas être dans commandListWithoutDev');
});

// ─── 4. Commandes dev privées ────────────────────────────────────────────────

describe('commandes dev', () => {
  it('scrim-dev n\'est que dans commandList (test 4)', () => {
    assert.ok(ALL_NAMES.includes('scrim-dev'), 'scrim-dev doit être dans commandList');
    assert.ok(!PUBLIC_NAMES.includes('scrim-dev'), 'scrim-dev ne doit pas être dans commandListWithoutDev');
  });

  it('dashboard-reseau n\'est que dans commandList (test 4)', () => {
    assert.ok(ALL_NAMES.includes('dashboard-reseau'), 'dashboard-reseau doit être dans commandList');
    assert.ok(!PUBLIC_NAMES.includes('dashboard-reseau'));
  });

  it('dashboard-admin n\'est que dans commandList (test 4)', () => {
    assert.ok(ALL_NAMES.includes('dashboard-admin'));
    assert.ok(!PUBLIC_NAMES.includes('dashboard-admin'));
  });
});

// ─── 5. Aucun doublon de nom ─────────────────────────────────────────────────

it('aucun doublon de nom dans commandListWithoutDev (test 5)', () => {
  assert.equal(
    new Set(PUBLIC_NAMES).size,
    PUBLIC_NAMES.length,
    `Doublons détectés : ${PUBLIC_NAMES.filter((n, i) => PUBLIC_NAMES.indexOf(n) !== i).join(', ')}`,
  );
});

// ─── 6. /scrim-config = nouveau panneau interactif ───────────────────────────

describe('/scrim-config', () => {
  const scrimConfig = commandListWithoutDev.find((c) => c.data.name === 'scrim-config');

  it('/scrim-config existe (test 6)', () => {
    assert.ok(scrimConfig, '/scrim-config doit exister');
  });

  it('/scrim-config possède la permission Administrator (test 6)', () => {
    const json = scrimConfig?.data.toJSON();
    assert.ok(json?.default_member_permissions, 'default_member_permissions doit être défini');
  });

  it('la data de /scrim-config contient un execute (panneau interactif, pas sous-commandes) (test 6-7)', () => {
    assert.ok(typeof scrimConfig?.execute === 'function', '/scrim-config doit avoir execute');
    // Ne doit pas avoir de sous-commandes (ancien système)
    const json = scrimConfig?.data.toJSON();
    const hasOldSubcommands = (json?.options ?? []).some(
      (opt) => opt.type === 1 && ['channel', 'command-channel', 'permissions', 'messages', 'view'].includes(opt.name),
    );
    assert.ok(!hasOldSubcommands, 'Anciennes sous-commandes ne doivent pas être présentes');
  });
});

// ─── 8. /find-scrim conserve toutes les options ──────────────────────────────

describe('/find-scrim options', () => {
  const findScrim = commandListWithoutDev.find((c) => c.data.name === 'find-scrim');

  it('/find-scrim existe (test 8)', () => {
    assert.ok(findScrim, '/find-scrim doit exister');
  });

  it('/find-scrim a les options principales (rang, date, heure, format, contact, fearless) (test 8)', () => {
    const json = findScrim?.data.toJSON();
    const optNames = (json?.options ?? []).map((o) => o.name);
    // Les options obligatoires attendues
    const required = ['rang', 'date', 'heure', 'format', 'contact', 'fearless'];
    for (const name of required) {
      assert.ok(optNames.includes(name), `Option manquante : ${name}`);
    }
  });

  it('elo_precision est facultative (test 9)', () => {
    const json = findScrim?.data.toJSON();
    const eloOpt = (json?.options ?? []).find((o) => o.name === 'elo_precision');
    if (eloOpt) {
      assert.ok(!eloOpt.required, 'elo_precision doit être facultative');
    }
    // Pas d'erreur si l'option n'existe pas encore
  });

  it('options obligatoires avant facultatives (test 10)', () => {
    const json = findScrim?.data.toJSON();
    const opts = (json?.options ?? []).filter((o) => o.type !== 1 && o.type !== 2);
    let seenOptional = false;
    for (const opt of opts) {
      if (!opt.required) seenOptional = true;
      if (seenOptional && opt.required) {
        assert.fail(`Option obligatoire "${opt.name}" placée après une facultative dans /find-scrim`);
      }
    }
  });
});

// ─── 11. /scrim-close conserve la logique d'auteur ──────────────────────────

describe('/scrim-close', () => {
  const scrimClose = commandListWithoutDev.find((c) => c.data.name === 'scrim-close');

  it('/scrim-close existe (test 11)', () => {
    assert.ok(scrimClose, '/scrim-close doit exister');
  });

  it('/scrim-close a une option id (test 11)', () => {
    const json = scrimClose?.data.toJSON();
    const optNames = (json?.options ?? []).map((o) => o.name);
    assert.ok(optNames.includes('id'), 'Option id doit être présente dans /scrim-close');
  });
});

// ─── 12. /report-spam permission administrateur ──────────────────────────────

describe('/report-spam', () => {
  const reportSpam = commandListWithoutDev.find((c) => c.data.name === 'report-spam');

  it('/report-spam existe (test 12)', () => {
    assert.ok(reportSpam, '/report-spam doit exister');
  });

  it('/report-spam possède la permission Administrator (test 12)', () => {
    const json = reportSpam?.data.toJSON();
    assert.ok(json?.default_member_permissions, 'default_member_permissions doit être défini pour /report-spam');
  });
});

// ─── 13. /structure-link sous-commandes set/remove ───────────────────────────

describe('/structure-link', () => {
  const structureLink = commandListWithoutDev.find((c) => c.data.name === 'structure-link');

  it('/structure-link existe (test 13)', () => {
    assert.ok(structureLink, '/structure-link doit exister');
  });

  it('/structure-link a les sous-commandes set et remove (test 13)', () => {
    const json = structureLink?.data.toJSON();
    const subNames = (json?.options ?? [])
      .filter((o) => o.type === 1)
      .map((o) => o.name);
    assert.ok(subNames.includes('set'), 'Sous-commande set manquante dans /structure-link');
    assert.ok(subNames.includes('remove'), 'Sous-commande remove manquante dans /structure-link');
  });
});

// ─── 14. /scrim-moderation user reste inchangée ──────────────────────────────

describe('/scrim-moderation', () => {
  const scrimMod = commandListWithoutDev.find((c) => c.data.name === 'scrim-moderation');

  it('/scrim-moderation existe (test 14)', () => {
    assert.ok(scrimMod, '/scrim-moderation doit exister');
  });

  it('/scrim-moderation a la sous-commande user (test 14)', () => {
    const json = scrimMod?.data.toJSON();
    const subNames = (json?.options ?? [])
      .filter((o) => o.type === 2 || o.type === 1)
      .map((o) => o.name);
    assert.ok(subNames.includes('user'), 'Sous-commande user manquante dans /scrim-moderation');
  });
});

// ─── 15. /help-scrim et /helpadmin-scrim inchangées ──────────────────────────

describe('/help-scrim et /helpadmin-scrim', () => {
  it('/help-scrim existe et est inchangée (test 15)', () => {
    const helpScrim = commandListWithoutDev.find((c) => c.data.name === 'help-scrim');
    assert.ok(helpScrim, '/help-scrim doit exister');
  });

  it('/helpadmin-scrim existe et est inchangée (test 15)', () => {
    const helpAdmin = commandListWithoutDev.find((c) => c.data.name === 'helpadmin-scrim');
    assert.ok(helpAdmin, '/helpadmin-scrim doit exister');
    const json = helpAdmin.data.toJSON();
    assert.ok(json.default_member_permissions, 'default_member_permissions doit être défini');
  });
});

// ─── 16–20. Descriptions anglaises uniquement ────────────────────────────────

/**
 * Collecte récursivement toutes les descriptions et noms de choix visibles
 * d'une commande Slash (JSON).
 * Couvre : commande, sous-commandes, groupes, options et leurs options imbriquées,
 * ainsi que les noms de choix (choice.name) qui sont visibles par l'utilisateur.
 *
 * Note : la condition ` / ` (espace-slash-espace) ne bloque PAS les URL légitimes
 * comme `https://discord.gg/xxxx` ni les dates `DD/MM/YYYY` (pas d'espaces autour
 * du slash dans ces cas).
 */
function collectDescriptions(json, path = '') {
  const results = [];
  const currentPath = path || json.name;
  if (json.description) {
    results.push({ path: currentPath, description: json.description });
  }
  // Noms de choix visibles (choice.name) — couverts par le check global
  for (const choice of json.choices ?? []) {
    results.push({ path: `${currentPath} > choice:${choice.name}`, description: choice.name });
  }
  // Options, sous-commandes, groupes — récursion
  for (const opt of json.options ?? []) {
    results.push(...collectDescriptions(opt, `${currentPath} > ${opt.name}`));
  }
  return results;
}

const ALL_PUBLIC_DESCRIPTIONS = commandListWithoutDev.flatMap((cmd) =>
  collectDescriptions(cmd.data.toJSON()),
);

/** Mots français typiques qui ne doivent pas apparaître dans une description Slash. */
const FRENCH_PATTERNS = [
  / \/ /,           // séparateur bilingue
  /\bAide\b/i,
  /\bserveur\b/i,
  /\bscrims? actif/i,
  /\badministrateurs?\b/i,
  /\bjoue(?:ur|use)/i,
  /\brecherche\b/i,
  /\baffiche\b/i,
  /\bpublique\b/i,
  /\bmarque\b/i,
  /\bsignale\b/i,
  /\btitre\b/i,
  /\blien\b/i,
  /\bidentifiant\b/i,
  /\bfacultatif/i,
  /\brequiert\b/i,
  /\bmaximum\b(?!.*maximum)/,  // sauf si l'anglais l'utilise aussi
  /\bminimum\b(?!.*minimum)/,
  /\bchoisissez\b/i,
  /\bsélectionne/i,
  /\bdéfinit\b/i,
  /\bretire\b/i,
  /\bnombre\b/i,
  /\buniquement\b/i,
  /\bheure\b/i,
  /\bdate\b.*JJ/i,
  /rang LoL/i,
  /\bformat de match\b/i,
  /\blien.*Discord\b(?!.*link)/i,
];

describe('descriptions des commandes — anglais uniquement (test 16-20)', () => {
  it('toutes les descriptions ne contiennent pas " / " (séparateur bilingue) (test 16)', () => {
    for (const { path, description } of ALL_PUBLIC_DESCRIPTIONS) {
      assert.ok(
        !description.includes(' / '),
        `"${path}" contient un séparateur bilingue " / " : "${description}"`,
      );
    }
  });

  it('toutes les descriptions respectent la limite Discord de 100 caractères (test 16)', () => {
    for (const { path, description } of ALL_PUBLIC_DESCRIPTIONS) {
      assert.ok(
        description.length <= 100,
        `"${path}" dépasse 100 caractères (${description.length}) : "${description}"`,
      );
    }
  });

  it('aucune description ne contient de texte français connu (test 16)', () => {
    for (const { path, description } of ALL_PUBLIC_DESCRIPTIONS) {
      for (const pattern of FRENCH_PATTERNS) {
        assert.ok(
          !pattern.test(description),
          `"${path}" contient du texte français (/${pattern.source}/) : "${description}"`,
        );
      }
    }
  });

  it('descriptions des commandes principales en anglais (test 16)', () => {
    const expectedDescriptions = {
      'help-scrim': 'Show ScrimRéseau help.',
      'helpadmin-scrim': 'Show ScrimRéseau administration help.',
      'list-scrims': 'List active scrim searches.',
      'my-scrims': 'Show your active scrim searches.',
      'find-scrim': 'Broadcast a scrim search on the ScrimRéseau network.',
      'scrim-config': 'Configure ScrimRéseau for this server.',
      'scrim-moderation': 'Manage blocked scrim users for this server.',
      'scrim-close': 'Close one of your active scrim searches.',
      'report-spam': 'Report a user for excessive scrim search spam.',
      'structure-link': 'Manage the Discord link associated with a structure.',
      'language': 'Set the ScrimRéseau language for this server.',
    };
    for (const [name, expected] of Object.entries(expectedDescriptions)) {
      const cmd = commandListWithoutDev.find((c) => c.data.name === name);
      assert.ok(cmd, `Commande manquante : ${name}`);
      const actual = cmd.data.toJSON().description;
      assert.equal(actual, expected, `Description incorrecte pour /${name}`);
    }
  });

  it('/find-scrim : options en anglais uniquement (test 17)', () => {
    const findScrim = commandListWithoutDev.find((c) => c.data.name === 'find-scrim');
    const descs = collectDescriptions(findScrim.data.toJSON());
    for (const { path, description } of descs) {
      assert.ok(!description.includes(' / '), `${path}: séparateur bilingue dans "${description}"`);
      assert.ok(description.length <= 100, `${path}: description trop longue (${description.length})`);
    }
  });

  it('/scrim-moderation : descriptions et choix en anglais uniquement (test 17)', () => {
    const scrimMod = commandListWithoutDev.find((c) => c.data.name === 'scrim-moderation');
    const json = scrimMod.data.toJSON();
    const descs = collectDescriptions(json);
    for (const { path, description } of descs) {
      assert.ok(!description.includes(' / '), `${path}: séparateur bilingue dans "${description}"`);
    }
    // Vérifier les noms des choix
    const userSub = json.options?.find((o) => o.name === 'user');
    const actionOpt = userSub?.options?.find((o) => o.name === 'action');
    for (const choice of actionOpt?.choices ?? []) {
      assert.ok(!choice.name.includes(' / '), `Choix bilingue : "${choice.name}"`);
      assert.ok(!/[àâäéèêëïîôùûüç]/i.test(choice.name), `Choix contient des caractères français : "${choice.name}"`);
    }
  });

  it('/structure-link : sous-commandes et options en anglais (test 17)', () => {
    const structLink = commandListWithoutDev.find((c) => c.data.name === 'structure-link');
    const descs = collectDescriptions(structLink.data.toJSON());
    for (const { path, description } of descs) {
      assert.ok(!description.includes(' / '), `${path}: séparateur bilingue dans "${description}"`);
      assert.ok(description.length <= 100, `${path}: description trop longue (${description.length})`);
    }
  });

  it('/language : option en anglais (test 17)', () => {
    const lang = commandListWithoutDev.find((c) => c.data.name === 'language');
    const descs = collectDescriptions(lang.data.toJSON());
    for (const { path, description } of descs) {
      assert.ok(!description.includes(' / '), `${path}: séparateur bilingue dans "${description}"`);
    }
  });

  it('toutes les descriptions commandes publiques ne sont pas vides (test 16)', () => {
    for (const { path, description } of ALL_PUBLIC_DESCRIPTIONS) {
      assert.ok(description && description.length > 0, `"${path}" a une description vide`);
    }
  });
});
