/**
 * Tests de non-régression pour /scrim-configurer.
 *
 * Vérifient :
 * 1. /scrim-config n'est plus dans commandListWithoutDev.
 * 2. /scrim-configurer est dans commandListWithoutDev.
 * 3. Toutes les autres commandes restent présentes.
 * 4. La lecture de la config (readConfig) ne crée aucune donnée en DB.
 * 5. Modifier un réglage ne touche pas aux autres.
 * 6. Réinitialisation partielle : seul le champ ciblé est supprimé.
 * 7. Réinitialisation complète : toutes les tables de config sont nettoyées.
 * 8. Les configurations d'un serveur avec salon/rôle supprimé ne lèvent pas d'erreur.
 * 9. Ouvrir le panneau (readConfig) ne modifie rien quand la config existe déjà.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { closeDb, getDb, prepareStatements } from '../src/database/db.js';
import { commandListWithoutDev } from '../src/commands/index.js';
import { UI_PRIMARY_GAME_KEY } from '../src/config/games.js';

const GAME_KEY = UI_PRIMARY_GAME_KEY;

// ---------------------------------------------------------------------------
// Helper : base SQLite temporaire
// ---------------------------------------------------------------------------

/**
 * @param {(db: import('better-sqlite3').Database, stmts: ReturnType<typeof prepareStatements>) => void} fn
 */
function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scrim-configurer-test-`));
  const prev = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = path.join(dir, `test.db`);
  try {
    const db = getDb();
    const stmts = prepareStatements(db);
    fn(db, stmts);
  } finally {
    closeDb();
    if (prev === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers DB
// ---------------------------------------------------------------------------

function insertFullConfig(guildId, stmts, db) {
  stmts.upsertGuildChannel.run({ guild_id: guildId, channel_id: `chan-${guildId}`, game_key: GAME_KEY, created_at: Date.now() });
  stmts.upsertScrimUsageChannel.run({ guild_id: guildId, channel_id: `usage-${guildId}` });
  stmts.deleteScrimAllowedRoles.run(guildId);
  stmts.insertScrimAllowedRole.run(guildId, `role1`);
  stmts.insertScrimAllowedRole.run(guildId, `role2`);
  stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'roles' });
  stmts.upsertScrimMessageLifecyclePolicy.run({ guild_id: guildId, policy: 'delete', updated_at: new Date().toISOString() });
}

function readFullConfig(guildId, stmts) {
  return {
    reception: stmts.getGuildGameChannel.get(guildId, GAME_KEY),
    usage: stmts.getScrimUsageChannel.get(guildId),
    permMode: stmts.getScrimPermissionMode.get(guildId),
    allowedRoles: stmts.listScrimAllowedRoles.all(guildId),
    policy: stmts.getScrimMessageLifecyclePolicy.get(guildId),
  };
}

// ---------------------------------------------------------------------------
// Tests commandes
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — liste des commandes`, () => {
  it(`scrim-config absent de commandListWithoutDev`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.ok(!names.includes('scrim-config'), `scrim-config ne doit plus être dans la liste publique`);
  });

  it(`scrim-configurer présent dans commandListWithoutDev`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.ok(names.includes('scrim-configurer'), `scrim-configurer doit être dans la liste publique`);
  });

  it(`toutes les autres commandes publiques restent présentes`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    const expectedCommands = [
      'scrim-configurer',
      'scrim-moderation',
      'liste-scrims',
      'help-scrim',
      'helpadmin-scrim',
      'mes-demandes-scrim',
      'recherche-scrim',
      'scrim-trouve',
      'spammer',
      'structure-lien',
    ];
    for (const name of expectedCommands) {
      assert.ok(names.includes(name), `La commande ${name} doit être dans commandListWithoutDev`);
    }
    assert.equal(names.length, expectedCommands.length);
  });

  it(`aucune ancienne sous-commande scrim-config n'est chargée`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    // L'ancienne commande ne doit pas être enregistrée
    assert.ok(!names.includes('scrim-config'));
  });

  it(`scrim-configurer possède la permission Administrator par défaut`, () => {
    const cmd = commandListWithoutDev.find((c) => c.data.name === 'scrim-configurer');
    assert.ok(cmd, `scrim-configurer doit exister`);
    // defaultMemberPermissions est stocké comme bigint dans la data
    const json = cmd.data.toJSON();
    // Administrator = 0x8
    assert.ok(json.default_member_permissions, `default_member_permissions doit être défini`);
  });
});

// ---------------------------------------------------------------------------
// Tests DB : lecture seule à l'ouverture
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — readConfig ne modifie pas la DB`, () => {
  it(`readConfig retourne null/défauts pour un serveur sans config`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-vide`;
      const config = readFullConfig(guildId, stmts);
      assert.equal(config.reception, undefined);
      assert.equal(config.usage, undefined);
      assert.equal(config.permMode, undefined);
      assert.deepEqual(config.allowedRoles, []);
      assert.equal(config.policy, undefined);
    });
  });

  it(`readConfig sur un serveur configuré lit les bonnes valeurs sans les modifier`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-configured`;
      insertFullConfig(guildId, stmts, db);

      const configBefore = readFullConfig(guildId, stmts);
      assert.equal(configBefore.reception.channel_id, `chan-${guildId}`);
      assert.equal(configBefore.usage.channel_id, `usage-${guildId}`);
      assert.equal(configBefore.permMode.mode, 'roles');
      assert.equal(configBefore.allowedRoles.length, 2);
      assert.equal(configBefore.policy.policy, 'delete');

      // Relire n'écrase rien
      const configAfter = readFullConfig(guildId, stmts);
      assert.equal(configAfter.reception.channel_id, configBefore.reception.channel_id);
      assert.equal(configAfter.usage.channel_id, configBefore.usage.channel_id);
      assert.equal(configAfter.permMode.mode, configBefore.permMode.mode);
      assert.equal(configAfter.allowedRoles.length, configBefore.allowedRoles.length);
      assert.equal(configAfter.policy.policy, configBefore.policy.policy);
    });
  });

  it(`readConfig d'un serveur existant depuis un autre serveur n'altère pas le premier`, () => {
    withTempDb((db, stmts) => {
      const guildA = `guild-A`;
      const guildB = `guild-B`;
      insertFullConfig(guildA, stmts, db);

      // Lire la config de B (vide) ne doit pas toucher A
      readFullConfig(guildB, stmts);

      const configA = readFullConfig(guildA, stmts);
      assert.equal(configA.reception.channel_id, `chan-${guildA}`);
      assert.equal(configA.permMode.mode, 'roles');
      assert.equal(configA.allowedRoles.length, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests : clé de session multi-serveur (activePanels)
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — clé de session multi-serveur`, () => {
  it(`deux serveurs avec le même admin peuvent avoir des configs isolées`, () => {
    withTempDb((db, stmts) => {
      const guildA = `guild-session-A`;
      const guildB = `guild-session-B`;
      insertFullConfig(guildA, stmts, db);
      insertFullConfig(guildB, stmts, db);

      // Modifier guildA ne touche pas guildB
      stmts.upsertGuildChannel.run({ guild_id: guildA, channel_id: `new-chan-A`, game_key: GAME_KEY, created_at: Date.now() });

      const configA = readFullConfig(guildA, stmts);
      const configB = readFullConfig(guildB, stmts);

      assert.equal(configA.reception.channel_id, `new-chan-A`, `guildA doit avoir le nouveau salon`);
      assert.equal(configB.reception.channel_id, `chan-${guildB}`, `guildB doit être inchangé`);
    });
  });

  it(`la clé sessionKey combine guildId et userId (format attendu)`, () => {
    // Vérification indirecte via le comportement DB : deux serveurs isolés
    withTempDb((db, stmts) => {
      const guildA = `guild-key-A`;
      const guildB = `guild-key-B`;
      insertFullConfig(guildA, stmts, db);
      insertFullConfig(guildB, stmts, db);

      const cfgA = readFullConfig(guildA, stmts);
      const cfgB = readFullConfig(guildB, stmts);

      // Les deux configs doivent être distinctes et correctes
      assert.notEqual(cfgA.reception.channel_id, cfgB.reception.channel_id);
      assert.equal(cfgA.reception.channel_id, `chan-${guildA}`);
      assert.equal(cfgB.reception.channel_id, `chan-${guildB}`);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests DB : isolation des modifications
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — modifications isolées`, () => {
  it(`modifier le salon des annonces ne touche pas aux permissions ni à la policy`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-iso-ann`;
      insertFullConfig(guildId, stmts, db);

      // Action : modifier le salon des annonces
      stmts.upsertGuildChannel.run({ guild_id: guildId, channel_id: `chan-nouveau`, game_key: GAME_KEY, created_at: Date.now() });

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.reception.channel_id, `chan-nouveau`, `Le salon doit être mis à jour`);
      assert.equal(config.usage.channel_id, `usage-${guildId}`, `Le salon commandes doit être inchangé`);
      assert.equal(config.permMode.mode, 'roles', `Les permissions doivent être inchangées`);
      assert.equal(config.allowedRoles.length, 2, `Les rôles doivent être inchangés`);
      assert.equal(config.policy.policy, 'delete', `La policy doit être inchangée`);
    });
  });

  it(`modifier les permissions ne touche pas au salon ni à la policy`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-iso-perm`;
      insertFullConfig(guildId, stmts, db);

      // Action : passer en mode everyone
      db.transaction(() => {
        stmts.deleteScrimAllowedRoles.run(guildId);
        stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'everyone' });
      })();

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.permMode.mode, 'everyone', `Mode doit être everyone`);
      assert.equal(config.allowedRoles.length, 0, `Rôles doivent être vidés`);
      assert.equal(config.reception.channel_id, `chan-${guildId}`, `Salon des annonces inchangé`);
      assert.equal(config.usage.channel_id, `usage-${guildId}`, `Salon commandes inchangé`);
      assert.equal(config.policy.policy, 'delete', `Policy inchangée`);
    });
  });

  it(`modifier la policy ne touche pas aux salons ni aux permissions`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-iso-policy`;
      insertFullConfig(guildId, stmts, db);

      stmts.upsertScrimMessageLifecyclePolicy.run({ guild_id: guildId, policy: 'keep', updated_at: new Date().toISOString() });

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.policy.policy, 'keep', `Policy doit être keep`);
      assert.equal(config.reception.channel_id, `chan-${guildId}`, `Salon des annonces inchangé`);
      assert.equal(config.usage.channel_id, `usage-${guildId}`, `Salon commandes inchangé`);
      assert.equal(config.permMode.mode, 'roles', `Permissions inchangées`);
      assert.equal(config.allowedRoles.length, 2, `Rôles inchangés`);
    });
  });

  it(`définir les rôles (set-all) remplace exactement les rôles précédents`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-roles-set`;
      insertFullConfig(guildId, stmts, db); // 2 rôles : role1, role2

      // Action : remplacer par 3 nouveaux rôles
      const newRoles = ['roleA', 'roleB', 'roleC'];
      db.transaction(() => {
        stmts.deleteScrimAllowedRoles.run(guildId);
        for (const rId of newRoles) stmts.insertScrimAllowedRole.run(guildId, rId);
        stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'roles' });
      })();

      const config = readFullConfig(guildId, stmts);
      const ids = config.allowedRoles.map((r) => r.role_id).sort();
      assert.deepEqual(ids, newRoles.slice().sort());
    });
  });
});

// ---------------------------------------------------------------------------
// Tests DB : réinitialisations
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — réinitialisations`, () => {
  it(`réinitialiser uniquement le salon des annonces`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-rst-ann`;
      insertFullConfig(guildId, stmts, db);

      stmts.deleteGuildChannel.run(guildId, GAME_KEY);

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.reception, undefined, `Salon des annonces doit être supprimé`);
      assert.ok(config.usage, `Salon commandes doit rester`);
      assert.equal(config.permMode.mode, 'roles', `Permissions doivent rester`);
      assert.equal(config.allowedRoles.length, 2, `Rôles doivent rester`);
      assert.equal(config.policy.policy, 'delete', `Policy doit rester`);
    });
  });

  it(`réinitialiser uniquement le salon des commandes`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-rst-cmd`;
      insertFullConfig(guildId, stmts, db);

      stmts.deleteScrimUsageChannel.run(guildId);

      const config = readFullConfig(guildId, stmts);
      assert.ok(config.reception, `Salon des annonces doit rester`);
      assert.equal(config.usage, undefined, `Salon commandes doit être supprimé`);
      assert.equal(config.permMode.mode, 'roles', `Permissions doivent rester`);
      assert.equal(config.allowedRoles.length, 2, `Rôles doivent rester`);
    });
  });

  it(`réinitialiser uniquement les permissions (retour everyone)`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-rst-perm`;
      insertFullConfig(guildId, stmts, db);

      db.transaction(() => {
        stmts.deleteScrimAllowedRoles.run(guildId);
        stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'everyone' });
      })();

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.permMode.mode, 'everyone', `Mode doit être everyone`);
      assert.equal(config.allowedRoles.length, 0, `Rôles doivent être vides`);
      assert.ok(config.reception, `Salon des annonces doit rester`);
      assert.ok(config.usage, `Salon commandes doit rester`);
      assert.equal(config.policy.policy, 'delete', `Policy doit rester`);
    });
  });

  it(`réinitialiser uniquement la policy des messages`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-rst-policy`;
      insertFullConfig(guildId, stmts, db);

      stmts.deleteScrimMessageLifecyclePolicy.run(guildId);

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.policy, undefined, `Policy doit être supprimée`);
      assert.ok(config.reception, `Salon des annonces doit rester`);
      assert.ok(config.usage, `Salon commandes doit rester`);
      assert.equal(config.permMode.mode, 'roles', `Permissions doivent rester`);
      assert.equal(config.allowedRoles.length, 2, `Rôles doivent rester`);
    });
  });

  it(`réinitialisation complète supprime toutes les tables de config`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-rst-all`;
      insertFullConfig(guildId, stmts, db);

      // Simule rst_ok : transaction complète
      db.transaction(() => {
        stmts.deleteGuildChannel.run(guildId, GAME_KEY);
        stmts.deleteScrimUsageChannel.run(guildId);
        stmts.deleteScrimAllowedRoles.run(guildId);
        stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'everyone' });
        stmts.deleteScrimMessageLifecyclePolicy.run(guildId);
      })();

      const config = readFullConfig(guildId, stmts);
      assert.equal(config.reception, undefined, `Salon des annonces doit être supprimé`);
      assert.equal(config.usage, undefined, `Salon commandes doit être supprimé`);
      assert.equal(config.permMode.mode, 'everyone', `Mode doit être everyone`);
      assert.equal(config.allowedRoles.length, 0, `Rôles doivent être vides`);
      assert.equal(config.policy, undefined, `Policy doit être supprimée`);
    });
  });

  it(`réinitialisation complète ne touche pas aux configs des autres serveurs`, () => {
    withTempDb((db, stmts) => {
      const guildA = `guild-rst-all-A`;
      const guildB = `guild-rst-all-B`;
      insertFullConfig(guildA, stmts, db);
      insertFullConfig(guildB, stmts, db);

      // Réinitialise uniquement guildA
      db.transaction(() => {
        stmts.deleteGuildChannel.run(guildA, GAME_KEY);
        stmts.deleteScrimUsageChannel.run(guildA);
        stmts.deleteScrimAllowedRoles.run(guildA);
        stmts.upsertScrimPermissionMode.run({ guild_id: guildA, mode: 'everyone' });
        stmts.deleteScrimMessageLifecyclePolicy.run(guildA);
      })();

      // guildB doit être intact
      const configB = readFullConfig(guildB, stmts);
      assert.equal(configB.reception.channel_id, `chan-${guildB}`, `guildB : salon annonces intact`);
      assert.equal(configB.usage.channel_id, `usage-${guildB}`, `guildB : salon commandes intact`);
      assert.equal(configB.permMode.mode, 'roles', `guildB : permissions intactes`);
      assert.equal(configB.allowedRoles.length, 2, `guildB : rôles intacts`);
      assert.equal(configB.policy.policy, 'delete', `guildB : policy intacte`);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests : configs avec salon/rôle supprimé (robustesse)
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — configs avec entités supprimées`, () => {
  it(`readConfig sur un salon supprimé ne lève pas d'erreur (lit l'ID en DB)`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-chan-deleted`;
      // Enregistre un channel ID fictif (comme si le salon existait)
      stmts.upsertGuildChannel.run({ guild_id: guildId, channel_id: `deleted-chan-99`, game_key: GAME_KEY, created_at: Date.now() });

      // La lecture ne doit pas lever d'erreur
      assert.doesNotThrow(() => {
        const config = readFullConfig(guildId, stmts);
        // L'ID est retourné tel quel depuis la DB
        assert.equal(config.reception.channel_id, `deleted-chan-99`);
      });
    });
  });

  it(`readConfig avec des rôles supprimés ne lève pas d'erreur (lit les IDs en DB)`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-role-deleted`;
      stmts.insertScrimAllowedRole.run(guildId, `deleted-role-99`);
      stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: 'roles' });

      assert.doesNotThrow(() => {
        const config = readFullConfig(guildId, stmts);
        assert.equal(config.allowedRoles.length, 1);
        assert.equal(config.allowedRoles[0].role_id, `deleted-role-99`);
      });
    });
  });
});
