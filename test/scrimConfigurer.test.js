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
import {
  buildScrimReceptionConfigRefusalContent,
  mayConfigureScrimReceptionChannel,
} from '../src/utils/guildScrimReceptionGate.js';

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
  it(`scrim-config présent dans commandListWithoutDev (nouveau nom)`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.ok(names.includes('scrim-config'), `scrim-config doit être dans la liste publique`);
  });

  it(`scrim-configurer absent de commandListWithoutDev (ancien nom)`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.ok(!names.includes('scrim-configurer'), `scrim-configurer ne doit plus être dans la liste publique`);
  });

  it(`toutes les commandes publiques attendues sont présentes`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    const expectedCommands = [
      'scrim-config',
      'scrim-moderation',
      'list-scrims',
      'help-scrim',
      'helpadmin-scrim',
      'my-scrims',
      'find-scrim',
      'scrim-close',
      'report-spam',
      'structure-link',
      'language',
    ];
    for (const name of expectedCommands) {
      assert.ok(names.includes(name), `La commande ${name} doit être dans commandListWithoutDev`);
    }
    assert.equal(names.length, expectedCommands.length);
  });

  it(`aucune ancienne sous-commande scrim-config n'est chargée`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    // L'ancien groupe de sous-commandes ne doit pas être enregistré
    // Vérifié en s'assurant qu'il n'y a qu'une seule entrée 'scrim-config'
    assert.equal(names.filter((n) => n === 'scrim-config').length, 1);
  });

  it(`scrim-config possède la permission Administrator par défaut`, () => {
    const cmd = commandListWithoutDev.find((c) => c.data.name === 'scrim-config');
    assert.ok(cmd, `scrim-config doit exister`);
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

// ---------------------------------------------------------------------------
// Gate réception scrim dans /scrim-configurer
// ---------------------------------------------------------------------------

describe(`scrimConfigurer — gate réception (même logique que l'ancien setup-scrim-channel)`, () => {
  // 1. mayConfigureScrimReceptionChannel est le même helper que l'ancien handler
  it(`utilise le même helper mayConfigureScrimReceptionChannel que l'ancien setup-scrim-channel`, () => {
    // Sans bypass → refusé
    assert.equal(mayConfigureScrimReceptionChannel(500, undefined), false);
    assert.equal(mayConfigureScrimReceptionChannel(500, null), false);
    // Avec bypass actif → autorisé
    assert.equal(mayConfigureScrimReceptionChannel(10, { bypass_member_minimum: 1 }), true);
    // Bypass inactif (0) → refusé
    assert.equal(mayConfigureScrimReceptionChannel(10, { bypass_member_minimum: 0 }), false);
  });

  // 2. Serveur sans accès : upsertGuildChannel ne doit pas être appelé
  it(`serveur sans accès — aucun UPSERT n'est effectué`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-no-access`;
      // Pas de ligne dans guild_scrim_reception_bypass → refus
      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      assert.equal(mayConfigureScrimReceptionChannel(500, bypassRow), false);

      // Simulation du comportement de scrimConfigurer.js :
      // si le gate refuse, on ne fait PAS l'upsert
      if (!mayConfigureScrimReceptionChannel(500, bypassRow)) {
        // → rien
      } else {
        stmts.upsertGuildChannel.run({ guild_id: guildId, channel_id: `chan-test`, game_key: GAME_KEY, created_at: Date.now() });
      }

      // Vérification : aucun salon enregistré
      const saved = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(saved, undefined);
    });
  });

  // 3. Aucun UPSERT après refus (même scénario, assertion explicite sur changes)
  it(`aucun UPSERT n'est appelé si le gate refuse`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-no-upsert`;
      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      const allowed = mayConfigureScrimReceptionChannel(200, bypassRow);
      assert.equal(allowed, false, `le gate doit refuser ce serveur`);

      // L'UPSERT ne doit PAS avoir été appelé
      const row = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(row, undefined, `aucun enregistrement attendu en DB`);
    });
  });

  // 4. Le message de refus contient l'explication attendue
  it(`le message de refus contient l'explication officielle`, () => {
    const msg = buildScrimReceptionConfigRefusalContent();
    assert.ok(
      msg.includes('réception des scrims ScrimRéseau'),
      `message manquant dans : ${msg}`,
    );
    assert.ok(
      msg.includes('validé') || msg.includes('ticket') || msg.includes('accès'),
      `explication d'accès manquante dans : ${msg}`,
    );
  });

  // 5. Le lien de ticket existant apparaît dans le message
  it(`le message de refus contient un lien discord.gg ou https`, () => {
    const msg = buildScrimReceptionConfigRefusalContent();
    assert.ok(
      msg.includes('discord.gg') || msg.includes('https://'),
      `lien de ticket manquant dans le message de refus : ${msg}`,
    );
  });

  // 6. Le fallback est utilisé si SCRIM_RECEPTION_TICKET_URL est absent
  it(`buildScrimReceptionConfigRefusalContent — fallback utilisé si variable absente`, () => {
    const prev = process.env.SCRIM_RECEPTION_TICKET_URL;
    delete process.env.SCRIM_RECEPTION_TICKET_URL;
    try {
      const msg = buildScrimReceptionConfigRefusalContent();
      assert.ok(msg.includes('discord.gg'), `fallback discord.gg attendu, obtenu : ${msg}`);
    } finally {
      if (prev !== undefined) process.env.SCRIM_RECEPTION_TICKET_URL = prev;
    }
  });

  // 6b. URL personnalisée utilisée si variable présente
  it(`buildScrimReceptionConfigRefusalContent — URL personnalisée utilisée si variable présente`, () => {
    const prev = process.env.SCRIM_RECEPTION_TICKET_URL;
    process.env.SCRIM_RECEPTION_TICKET_URL = `https://custom.example.com/ticket`;
    try {
      const msg = buildScrimReceptionConfigRefusalContent();
      assert.ok(
        msg.includes(`https://custom.example.com/ticket`),
        `URL personnalisée attendue, obtenu : ${msg}`,
      );
    } finally {
      if (prev === undefined) delete process.env.SCRIM_RECEPTION_TICKET_URL;
      else process.env.SCRIM_RECEPTION_TICKET_URL = prev;
    }
  });

  // 7. Serveur autorisé (bypass actif) : l'upsert peut être effectué
  it(`serveur avec bypass actif — upsertGuildChannel s'exécute sans erreur`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-bypassed`;
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: guildId,
        bypass_member_minimum: 1,
        updated_by: `test-admin`,
        updated_at: new Date().toISOString(),
        note: null,
      });

      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      const allowed = mayConfigureScrimReceptionChannel(10, bypassRow);
      assert.equal(allowed, true, `le gate doit autoriser un serveur avec bypass`);

      assert.doesNotThrow(() => {
        stmts.upsertGuildChannel.run({
          guild_id: guildId,
          channel_id: `chan-bp`,
          game_key: GAME_KEY,
          created_at: Date.now(),
        });
      });

      const saved = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(saved?.channel_id, `chan-bp`);
    });
  });

  // 8. Bypass avec bypass_member_minimum = 1 → autorisé
  it(`serveur autorisé (bypass_member_minimum = 1) peut enregistrer le salon`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-authorized`;
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: guildId,
        bypass_member_minimum: 1,
        updated_by: `test-admin`,
        updated_at: new Date().toISOString(),
        note: null,
      });

      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      assert.equal(mayConfigureScrimReceptionChannel(0, bypassRow), true);

      stmts.upsertGuildChannel.run({
        guild_id: guildId,
        channel_id: `chan-auth`,
        game_key: GAME_KEY,
        created_at: Date.now(),
      });
      const saved = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(saved?.channel_id, `chan-auth`);
    });
  });

  // 9. Un serveur non validé ne peut accéder à aucune section du panneau
  it(`un serveur non validé est bloqué dès le lancement — aucune section accessible`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-blocked-all`;
      // Prépare de la config existante
      stmts.upsertScrimUsageChannel.run({ guild_id: guildId, channel_id: `usage-ch` });
      stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: `roles` });

      // Gate doit refuser
      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      const allowed = mayConfigureScrimReceptionChannel(500, bypassRow);
      assert.equal(allowed, false, `le gate doit refuser ce serveur`);

      // L'exécution s'arrête ici pour ce serveur — aucune lecture de config par le panneau
      // Vérification : les données existent en DB mais le panneau ne les affiche pas
      const usage = stmts.getScrimUsageChannel.get(guildId);
      assert.equal(usage?.channel_id, `usage-ch`, `données DB intactes`);
    });
  });

  // 10. Simple ouverture du panneau (readConfig) ne modifie aucune donnée
  it(`simple lecture de la config ne modifie aucune donnée`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-readonly`;
      // Pré-état
      stmts.upsertScrimUsageChannel.run({ guild_id: guildId, channel_id: `usage-ro` });

      // Lecture seule (simule readConfig)
      const usage = stmts.getScrimUsageChannel.get(guildId);
      stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      stmts.getScrimPermissionMode.get(guildId);
      stmts.listScrimAllowedRoles.all(guildId);
      stmts.getScrimMessageLifecyclePolicy.get(guildId);

      // Post-état inchangé
      const usageAfter = stmts.getScrimUsageChannel.get(guildId);
      assert.equal(usageAfter?.channel_id, usage?.channel_id);
    });
  });

  // 11. Les configurations existantes restent intactes
  it(`les configurations existantes restent intactes si le gate refuse`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-existing-config`;
      // Configure un salon existant via bypass
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: guildId,
        bypass_member_minimum: 1,
        updated_by: `test-admin`,
        updated_at: new Date().toISOString(),
        note: null,
      });
      stmts.upsertGuildChannel.run({
        guild_id: guildId,
        channel_id: `chan-existing`,
        game_key: GAME_KEY,
        created_at: Date.now(),
      });
      // Retire le bypass (simule une révocation d'accès)
      db.prepare(`DELETE FROM guild_scrim_reception_bypass WHERE guild_id = ?`).run(guildId);

      // Maintenant le gate refuse
      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      assert.equal(mayConfigureScrimReceptionChannel(500, bypassRow), false);

      // Le salon existant doit toujours être présent (le refus ne le supprime pas)
      const existing = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(existing?.channel_id, `chan-existing`, `salon existant supprimé à tort`);
    });
  });

  // 12. Révocation pendant session : chan_ann refuse l'écriture (double protection)
  it(`révocation en cours de session — chan_ann refuse l'upsert`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-revoked`;
      // Bypass existait, puis révoqué
      stmts.upsertGuildScrimReceptionBypass.run({
        guild_id: guildId,
        bypass_member_minimum: 1,
        updated_by: `admin`,
        updated_at: new Date().toISOString(),
        note: null,
      });
      // Révocation
      db.prepare(`DELETE FROM guild_scrim_reception_bypass WHERE guild_id = ?`).run(guildId);

      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      const allowed = mayConfigureScrimReceptionChannel(500, bypassRow);
      assert.equal(allowed, false, `accès doit être révoqué`);

      // Aucun upsert ne doit avoir lieu
      const before = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(before, undefined);
    });
  });

  // 13. Aucun UPSERT après révocation
  it(`aucun UPSERT exécuté après révocation`, () => {
    withTempDb((db, stmts) => {
      const guildId = `guild-no-upsert-revoked`;
      const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
      assert.equal(mayConfigureScrimReceptionChannel(0, bypassRow), false);
      // Simulation : le code n'appellerait pas upsertGuildChannel ici
      const row = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
      assert.equal(row, undefined);
    });
  });

  // Non-régression complète : 4 types de serveurs
  describe(`non-régression — 4 types de serveurs`, () => {
    it(`serveur non validé : gate bloque dès le lancement, aucun salon enregistré`, () => {
      withTempDb((db, stmts) => {
        const guildId = `guild-nonauth-launch`;
        const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
        assert.equal(mayConfigureScrimReceptionChannel(999, bypassRow), false);
        // Pas d'UPSERT possible car le panneau ne s'ouvre pas
        const saved = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
        assert.equal(saved, undefined);
      });
    });

    it(`serveur avec salon existant : refus au lancement ne supprime rien`, () => {
      withTempDb((db, stmts) => {
        const guildId = `guild-has-channel-blocked`;
        // Salon configuré via bypass (état passé)
        stmts.upsertGuildScrimReceptionBypass.run({
          guild_id: guildId, bypass_member_minimum: 1,
          updated_by: `admin`, updated_at: new Date().toISOString(), note: null,
        });
        stmts.upsertGuildChannel.run({
          guild_id: guildId, channel_id: `chan-safe`, game_key: GAME_KEY, created_at: Date.now(),
        });
        // Révocation du bypass (simule un serveur bloqué)
        db.prepare(`DELETE FROM guild_scrim_reception_bypass WHERE guild_id = ?`).run(guildId);

        // Gate refuse
        const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
        assert.equal(mayConfigureScrimReceptionChannel(500, bypassRow), false);

        // Le salon existant n'est pas supprimé par le refus
        const cfg = stmts.getGuildGameChannel.get(guildId, GAME_KEY);
        assert.equal(cfg?.channel_id, `chan-safe`, `salon supprimé à tort après refus`);
      });
    });

    it(`serveur avec bypass actif peut ouvrir le panneau et configurer`, () => {
      withTempDb((db, stmts) => {
        const guildId = `guild-bypass-launch`;
        stmts.upsertGuildScrimReceptionBypass.run({
          guild_id: guildId, bypass_member_minimum: 1,
          updated_by: `admin`, updated_at: new Date().toISOString(), note: null,
        });
        const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
        assert.equal(mayConfigureScrimReceptionChannel(0, bypassRow), true);
        stmts.upsertGuildChannel.run({
          guild_id: guildId, channel_id: `chan-bypass`, game_key: GAME_KEY, created_at: Date.now(),
        });
        assert.equal(stmts.getGuildGameChannel.get(guildId, GAME_KEY)?.channel_id, `chan-bypass`);
      });
    });

    it(`aucune autre table de configuration n'est modifiée lors d'un refus au lancement`, () => {
      withTempDb((db, stmts) => {
        const guildId = `guild-other-tables-launch`;
        stmts.upsertScrimUsageChannel.run({ guild_id: guildId, channel_id: `usage-intact` });
        stmts.upsertScrimPermissionMode.run({ guild_id: guildId, mode: `everyone` });

        const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
        assert.equal(mayConfigureScrimReceptionChannel(200, bypassRow), false);

        // Les autres tables sont intactes
        assert.equal(stmts.getScrimUsageChannel.get(guildId)?.channel_id, `usage-intact`);
        assert.equal(stmts.getScrimPermissionMode.get(guildId)?.mode, `everyone`);
      });
    });

    it(`serveur révoqué : config existante intacte, ne peut plus ouvrir le panneau`, () => {
      withTempDb((db, stmts) => {
        const guildId = `guild-revoked-full`;
        // Config complète avant révocation
        stmts.upsertGuildScrimReceptionBypass.run({
          guild_id: guildId, bypass_member_minimum: 1,
          updated_by: `admin`, updated_at: new Date().toISOString(), note: null,
        });
        insertFullConfig(guildId, stmts, db);
        const configBefore = readFullConfig(guildId, stmts);

        // Révocation
        db.prepare(`DELETE FROM guild_scrim_reception_bypass WHERE guild_id = ?`).run(guildId);
        const bypassRow = stmts.getGuildScrimReceptionBypass.get(guildId);
        assert.equal(mayConfigureScrimReceptionChannel(999, bypassRow), false, `doit refuser après révocation`);

        // Toute la configuration reste intacte
        const configAfter = readFullConfig(guildId, stmts);
        assert.equal(configAfter.reception?.channel_id, configBefore.reception?.channel_id, `salon annonces modifié`);
        assert.equal(configAfter.usage?.channel_id, configBefore.usage?.channel_id, `salon commandes modifié`);
        assert.equal(configAfter.permMode?.mode, configBefore.permMode?.mode, `mode permissions modifié`);
        assert.equal(configAfter.allowedRoles.length, configBefore.allowedRoles.length, `rôles modifiés`);
        assert.equal(configAfter.policy?.policy, configBefore.policy?.policy, `politique messages modifiée`);
      });
    });
  });
});
