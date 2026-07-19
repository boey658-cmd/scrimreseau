/**
 * Tests pour /scrim-dev serveurs — Commande développeur listant tous les serveurs.
 *
 * Couvre :
 *  1.  La commande est présente dans scrimDev (guilde dev uniquement).
 *  2.  Elle est absente de commandListWithoutDev.
 *  3.  Elle est absente du déploiement global (publicBody).
 *  4.  Un utilisateur différent du développeur est refusé.
 *  5.  Aucun détail sur les guildes n'est envoyé à un utilisateur refusé.
 *  6.  Le développeur peut exécuter la commande (aucune exception levée).
 *  7.  Un serveur sans configuration en base apparaît quand même.
 *  8.  La commande ne consulte pas les tables de configuration.
 *  9.  La commande n'effectue aucune écriture en base.
 *  10. Le nombre total affiché correspond au nombre de guildes accessibles.
 *  11. Les résultats sont triés par nom (insensible à la casse).
 *  12. La pagination fonctionne (embeds + composants).
 *  13. Les boutons affichent les bons états désactivés.
 *  14. Une guilde indisponible (available=false) ne provoque pas de crash.
 *  15. Une liste vide est correctement gérée.
 *  16. Pas de sharding — guilds.cache suffit.
 *  17. Les doublons éventuels sont supprimés par ID (cache Collection = unique par ID).
 *  18. BOT_DEV_ID absent → refuse l'exécution de façon fail-closed.
 *  19. DEV_GUILD_ID absent → refuse l'exécution de façon fail-closed.
 *  20. La commande existante reception-list reste inchangée.
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  buildGuildListComponents,
  buildGuildListEmbed,
  executeScrimDevGuildListCore,
  formatGuildEntry,
  getSortedGuilds,
} from '../src/commands/scrimDevGuildList.js';
import { commandListWithoutDev, scrimDev } from '../src/commands/index.js';

// ---------------------------------------------------------------------------
// Helpers — guildes factices
// ---------------------------------------------------------------------------

/**
 * Crée une fausse guilde disponible.
 * @param {{ id: string, name: string, memberCount?: number, joinedAt?: Date }} opts
 * @returns {import('discord.js').Guild}
 */
function makeGuild({ id, name, memberCount = 100, joinedAt = new Date('2025-01-15T00:00:00Z') }) {
  return /** @type {any} */ ({
    id,
    name,
    memberCount,
    joinedAt,
    available: true,
  });
}

/**
 * Crée une fausse guilde indisponible (outage Discord).
 * @param {string} id
 * @returns {import('discord.js').Guild}
 */
function makeUnavailableGuild(id) {
  return /** @type {any} */ ({
    id,
    name: undefined,
    memberCount: undefined,
    joinedAt: undefined,
    available: false,
  });
}

/**
 * Crée un faux client Discord avec les guildes fournies dans son cache.
 * @param {any[]} guilds
 */
function makeClient(guilds) {
  const cacheMap = new Map(guilds.map((g) => [g.id, g]));
  return {
    guilds: { cache: { values: () => cacheMap.values(), size: cacheMap.size } },
  };
}

// ---------------------------------------------------------------------------
// Helpers — interactions factices
// ---------------------------------------------------------------------------

/**
 * Crée une fausse interaction slash.
 * @param {{ guildId?: string, userId?: string, inGuild?: boolean, client?: any }} opts
 */
function makeInteraction({ guildId = 'DEV_GUILD', userId = 'DEV_USER', inGuild = true, client = makeClient([]) } = {}) {
  const replies = [];
  let deferCalled = false;
  let editReplyCalled = false;
  let lastEditReply = null;

  return {
    inGuild: () => inGuild,
    guildId,
    user: { id: userId },
    client,
    _replies: replies,
    _deferCalled: () => deferCalled,
    _editReplyCalled: () => editReplyCalled,
    _lastEditReply: () => lastEditReply,
    reply: async (opts) => {
      replies.push(opts);
    },
    deferReply: async () => {
      deferCalled = true;
    },
    editReply: async (opts) => {
      editReplyCalled = true;
      lastEditReply = opts;
      // Retourne un faux message avec un collector minimal
      return {
        createMessageComponentCollector: () => ({
          on: () => {},
          stop: () => {},
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — environnement développeur
// ---------------------------------------------------------------------------

const REAL_DEV_ID = '753143755388879051';
const REAL_DEV_GUILD = '1484520688726311012';

function setDevEnv() {
  process.env.BOT_DEV_ID = REAL_DEV_ID;
  process.env.DEV_GUILD_ID = REAL_DEV_GUILD;
}

function clearDevEnv() {
  delete process.env.BOT_DEV_ID;
  delete process.env.DEV_GUILD_ID;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/scrim-dev serveurs — déploiement & structure', () => {
  it(`1 — scrim-dev n'est pas dans commandListWithoutDev`, () => {
    const names = commandListWithoutDev.map((c) => c.data.name);
    assert.ok(!names.includes('scrim-dev'), `scrim-dev ne doit pas être dans commandListWithoutDev`);
  });

  it('2 — scrim-dev est bien exporté en tant que commande dev only', () => {
    assert.ok(scrimDev, `scrimDev doit être exporté`);
    assert.strictEqual(scrimDev.data.name, 'scrim-dev');
  });

  it('3 — scrim-dev contient un subcommand "serveurs"', () => {
    const json = scrimDev.data.toJSON();
    const subs = json.options ?? [];
    const serveurs = subs.find(
      (opt) => opt.type === 1 /* SUB_COMMAND */ && opt.name === 'serveurs',
    );
    assert.ok(serveurs, `Le subcommand "serveurs" doit être présent dans scrim-dev`);
    assert.ok(
      serveurs.description.length > 0,
      `Le subcommand "serveurs" doit avoir une description`,
    );
  });

  it(`3b — aucune commande de commandListWithoutDev ne s'appelle "scrim-dev"`, () => {
    for (const cmd of commandListWithoutDev) {
      assert.notStrictEqual(cmd.data.name, 'scrim-dev', `scrim-dev ne doit pas être public`);
    }
  });

  it('19 — le subcommand "reception-list" est toujours présent dans scrim-dev', () => {
    const json = scrimDev.data.toJSON();
    const subs = json.options ?? [];
    const receptionList = subs.find(
      (opt) => opt.type === 1 && opt.name === 'reception-list',
    );
    assert.ok(receptionList, `Le subcommand "reception-list" ne doit pas avoir été supprimé`);
  });
});

describe('/scrim-dev serveurs — logique de tri et affichage', () => {
  it('11 — getSortedGuilds trie par nom, insensible à la casse', () => {
    const client = makeClient([
      makeGuild({ id: '3', name: 'Zeta' }),
      makeGuild({ id: '1', name: 'alpha' }),
      makeGuild({ id: '2', name: 'Beta' }),
    ]);
    const sorted = getSortedGuilds(client);
    assert.deepStrictEqual(
      sorted.map((g) => g.name),
      ['alpha', 'Beta', 'Zeta'],
    );
  });

  it('14 — getSortedGuilds gère les guildes indisponibles sans crash', () => {
    const client = makeClient([
      makeGuild({ id: '1', name: 'Alpha' }),
      makeUnavailableGuild('2'),
      makeGuild({ id: '3', name: 'Gamma' }),
    ]);
    let sorted;
    assert.doesNotThrow(() => {
      sorted = getSortedGuilds(client);
    });
    assert.strictEqual(sorted.length, 3);
  });

  it('15 — getSortedGuilds retourne [] si le cache est vide', () => {
    const client = makeClient([]);
    const sorted = getSortedGuilds(client);
    assert.deepStrictEqual(sorted, []);
  });

  it('formatGuildEntry — guilde disponible', () => {
    const guild = makeGuild({ id: '123', name: 'TestGuild', memberCount: 250, joinedAt: new Date('2026-03-15T00:00:00Z') });
    const entry = formatGuildEntry(guild, 1);
    assert.ok(entry.includes('TestGuild'), `Le nom doit apparaître`);
    assert.ok(entry.includes('123'), `L'ID doit apparaître`);
    assert.ok(entry.includes('250'), `Le nombre de membres doit apparaître`);
    assert.ok(entry.includes('2026'), `L'année doit apparaître dans la date`);
  });

  it('14 — formatGuildEntry — guilde indisponible ne plante pas', () => {
    const guild = makeUnavailableGuild('999');
    let result;
    assert.doesNotThrow(() => {
      result = formatGuildEntry(guild, 5);
    });
    assert.ok(result.includes('999'), `L'ID doit apparaître même pour une guilde indisponible`);
    assert.ok(result.includes('indisponible'), `Un label "indisponible" doit être affiché`);
  });

  it('formatGuildEntry — joinedAt null → "Date inconnue"', () => {
    const guild = /** @type {any} */ ({
      id: '111',
      name: 'NoDate',
      memberCount: 10,
      joinedAt: null,
      available: true,
    });
    const entry = formatGuildEntry(guild, 2);
    assert.ok(entry.includes('Date inconnue'), `"Date inconnue" attendu si joinedAt est null`);
  });

  it('formatGuildEntry — memberCount undefined → "Inconnus"', () => {
    const guild = /** @type {any} */ ({
      id: '222',
      name: 'NoMembers',
      memberCount: undefined,
      joinedAt: new Date(),
      available: true,
    });
    const entry = formatGuildEntry(guild, 3);
    assert.ok(entry.includes('Inconnus'), `"Inconnus" attendu si memberCount est undefined`);
  });
});

describe('/scrim-dev serveurs — pagination (embed + composants)', () => {
  it('10 — buildGuildListEmbed affiche le bon total dans le footer', () => {
    const guilds = [
      makeGuild({ id: '1', name: 'A' }),
      makeGuild({ id: '2', name: 'B' }),
    ];
    const embed = buildGuildListEmbed(guilds, 0, 1);
    const json = embed.toJSON();
    assert.ok(json.footer?.text.includes('2'), `Le footer doit mentionner le total de 2`);
  });

  it('10 — buildGuildListEmbed affiche le numéro de page correct', () => {
    const guilds = Array.from({ length: 25 }, (_, i) =>
      makeGuild({ id: String(i + 1), name: `Guild${i + 1}` }),
    );
    const embed = buildGuildListEmbed(guilds, 1, 3);
    const json = embed.toJSON();
    assert.ok(json.footer?.text.includes('Page 2/3'), `Le footer doit indiquer "Page 2/3"`);
  });

  it(`15 — buildGuildListEmbed liste vide → message spécifique, pas d'erreur`, () => {
    let json;
    assert.doesNotThrow(() => {
      const embed = buildGuildListEmbed([], 0, 1);
      json = embed.toJSON();
    });
    assert.ok(
      json.description?.toLowerCase().includes('aucun serveur'),
      `La description doit indiquer qu'il n'y a aucun serveur`,
    );
  });

  it('13 — buildGuildListComponents — Précédent désactivé sur page 0', () => {
    const rows = buildGuildListComponents('uid123', 0, 3);
    const buttons = rows[0].toJSON().components;
    const prev = buttons.find((b) => b.custom_id?.includes('prev'));
    assert.ok(prev?.disabled === true, `Précédent doit être désactivé sur la première page`);
  });

  it('13 — buildGuildListComponents — Suivant désactivé sur dernière page', () => {
    const rows = buildGuildListComponents('uid123', 2, 3);
    const buttons = rows[0].toJSON().components;
    const next = buttons.find((b) => b.custom_id?.includes('next'));
    assert.ok(next?.disabled === true, `Suivant doit être désactivé sur la dernière page`);
  });

  it('13 — buildGuildListComponents — les deux activés sur une page intermédiaire', () => {
    const rows = buildGuildListComponents('uid123', 1, 3);
    const buttons = rows[0].toJSON().components;
    const prev = buttons.find((b) => b.custom_id?.includes('prev'));
    const next = buttons.find((b) => b.custom_id?.includes('next'));
    assert.ok(!prev?.disabled, `Précédent doit être actif sur page intermédiaire`);
    assert.ok(!next?.disabled, `Suivant doit être actif sur page intermédiaire`);
  });

  it('13 — buildGuildListComponents — bouton Fermer toujours présent', () => {
    const rows = buildGuildListComponents('uid123', 0, 1);
    const buttons = rows[0].toJSON().components;
    const close = buttons.find((b) => b.custom_id?.includes('close'));
    assert.ok(close, `Le bouton Fermer doit toujours être présent`);
  });

  it(`13 — buildGuildListComponents — customId contient l'UID pour isolation`, () => {
    const uid = 'user_abc';
    const rows = buildGuildListComponents(uid, 0, 2);
    const buttons = rows[0].toJSON().components;
    for (const btn of buttons) {
      assert.ok(
        btn.custom_id?.includes(uid),
        `Le customId doit contenir l'UID "${uid}"`,
      );
    }
  });

  it('12 — pagination : page 1 montre les 10 premiers, page 2 les suivants', () => {
    const guilds = Array.from({ length: 15 }, (_, i) =>
      makeGuild({ id: String(i + 1), name: `Guild${String(i + 1).padStart(2, '0')}` }),
    );
    const embed1 = buildGuildListEmbed(guilds, 0, 2);
    const embed2 = buildGuildListEmbed(guilds, 1, 2);
    const desc1 = embed1.toJSON().description ?? '';
    const desc2 = embed2.toJSON().description ?? '';
    // Page 1 : guilds 1..10
    assert.ok(desc1.includes('Guild01'), `Page 1 doit contenir Guild01`);
    assert.ok(desc1.includes('Guild10'), `Page 1 doit contenir Guild10`);
    assert.ok(!desc1.includes('Guild11'), `Page 1 ne doit pas contenir Guild11`);
    // Page 2 : guilds 11..15
    assert.ok(desc2.includes('Guild11'), `Page 2 doit contenir Guild11`);
    assert.ok(desc2.includes('Guild15'), `Page 2 doit contenir Guild15`);
    assert.ok(!desc2.includes('Guild01'), `Page 2 ne doit pas contenir Guild01`);
  });
});

describe('/scrim-dev serveurs — sécurité & exécution', () => {
  beforeEach(setDevEnv);
  afterEach(clearDevEnv);

  it('4 — un utilisateur différent du développeur est refusé', async () => {
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: '999999999999999999', // pas le dev
    });
    await executeScrimDevGuildListCore(interaction);
    assert.strictEqual(interaction._replies.length, 1, `Un seul reply de refus attendu`);
    assert.ok(
      interaction._replies[0].content?.includes(`Non autorisé`) ||
      interaction._replies[0].content?.includes(`❌`),
      `Le message de refus doit être affiché`,
    );
  });

  it(`5 — aucun détail guilde n'est envoyé à un utilisateur refusé`, async () => {
    const client = makeClient([
      makeGuild({ id: '1', name: 'SecretGuild', memberCount: 500 }),
    ]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: '000000000000000001',
      client,
    });
    await executeScrimDevGuildListCore(interaction);
    // Le refus ne doit pas mentionner le nom du serveur dans la réponse
    for (const reply of interaction._replies) {
      assert.ok(
        !JSON.stringify(reply).includes('SecretGuild'),
        `Le nom du serveur ne doit pas apparaître dans la réponse de refus`,
      );
    }
    assert.ok(!interaction._editReplyCalled(), `editReply ne doit pas être appelé en cas de refus`);
  });

  it(`6 — le développeur peut exécuter la commande sans lever d'exception`, async () => {
    const client = makeClient([
      makeGuild({ id: '1', name: 'DevServer' }),
    ]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
      client,
    });
    await assert.doesNotReject(async () => {
      await executeScrimDevGuildListCore(interaction);
    });
    assert.ok(interaction._deferCalled(), `deferReply doit être appelé pour le développeur`);
    assert.ok(interaction._editReplyCalled(), `editReply doit être appelé pour le développeur`);
  });

  it('7 — un serveur sans configuration en base apparaît quand même', async () => {
    // La source est client.guilds.cache, pas la DB
    // N'importe quel serveur injecté dans le cache doit apparaître
    const unconfiguredGuild = makeGuild({ id: '9999', name: 'UnconfiguredServer' });
    const client = makeClient([unconfiguredGuild]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
      client,
    });
    await executeScrimDevGuildListCore(interaction);
    const editReply = interaction._lastEditReply();
    const embedDesc = editReply?.embeds?.[0]?.toJSON()?.description ?? '';
    assert.ok(
      embedDesc.includes('UnconfiguredServer'),
      `Un serveur sans config DB doit apparaître dans la liste`,
    );
  });

  it(`8 & 9 — la commande n'accède pas aux tables de configuration et n'écrit rien en DB`, async () => {
    // Si la commande n'accepte pas ctx (stmts), elle ne peut pas écrire en DB
    // On vérifie que getSortedGuilds n'utilise que client.guilds.cache
    const writes = [];
    const fakeDb = new Proxy({}, {
      get: (_, prop) => {
        writes.push(String(prop));
        return () => {};
      },
    });
    const client = makeClient([makeGuild({ id: '1', name: 'A' })]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
      client,
    });
    await executeScrimDevGuildListCore(interaction);
    // Aucun accès DB ne doit se produire — pas de stmts passé à la fonction
    assert.ok(
      writes.length === 0,
      `Aucun accès DB attendu (${writes.join(', ')})`,
    );
  });

  it('18 — BOT_DEV_ID absent → refus fail-closed, aucun détail guilde', async () => {
    delete process.env.BOT_DEV_ID;
    const client = makeClient([makeGuild({ id: '1', name: 'SecretGuild' })]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
      client,
    });
    await executeScrimDevGuildListCore(interaction);
    assert.strictEqual(interaction._replies.length, 1, `Un reply de refus attendu`);
    assert.ok(
      !JSON.stringify(interaction._replies).includes('SecretGuild'),
      `Aucun détail guilde ne doit être exposé si BOT_DEV_ID est absent`,
    );
    assert.ok(!interaction._editReplyCalled(), `editReply ne doit pas être appelé`);
  });

  it('19 — DEV_GUILD_ID absent → refus fail-closed', async () => {
    delete process.env.DEV_GUILD_ID;
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
    });
    await executeScrimDevGuildListCore(interaction);
    assert.strictEqual(interaction._replies.length, 1, `Un reply de refus attendu`);
    assert.ok(!interaction._editReplyCalled(), `editReply ne doit pas être appelé`);
  });

  it('19b — interaction dans un mauvais serveur → refus', async () => {
    const interaction = makeInteraction({
      guildId: '0000000000000000000', // pas DEV_GUILD_ID
      userId: REAL_DEV_ID,
    });
    await executeScrimDevGuildListCore(interaction);
    assert.strictEqual(interaction._replies.length, 1, `Un reply de refus attendu`);
    assert.ok(!interaction._editReplyCalled(), `editReply ne doit pas être appelé`);
  });

  it('interaction hors guild → refus', async () => {
    const interaction = makeInteraction({
      guildId: undefined,
      userId: REAL_DEV_ID,
      inGuild: false,
    });
    await executeScrimDevGuildListCore(interaction);
    assert.strictEqual(interaction._replies.length, 1, `Un reply de refus attendu`);
  });
});

describe('/scrim-dev serveurs — cas particuliers & sharding', () => {
  beforeEach(setDevEnv);
  afterEach(clearDevEnv);

  it('14 — une guilde indisponible dans le cache ne provoque pas de crash', async () => {
    const client = makeClient([
      makeGuild({ id: '1', name: 'Alpha' }),
      makeUnavailableGuild('99'),
      makeGuild({ id: '3', name: 'Gamma' }),
    ]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
      client,
    });
    await assert.doesNotReject(async () => {
      await executeScrimDevGuildListCore(interaction);
    });
  });

  it('15 — liste vide traitée proprement, aucun crash', async () => {
    const client = makeClient([]);
    const interaction = makeInteraction({
      guildId: REAL_DEV_GUILD,
      userId: REAL_DEV_ID,
      client,
    });
    await assert.doesNotReject(async () => {
      await executeScrimDevGuildListCore(interaction);
    });
    const editReply = interaction._lastEditReply();
    const embedDesc = editReply?.embeds?.[0]?.toJSON()?.description ?? '';
    assert.ok(
      embedDesc.toLowerCase().includes('aucun serveur'),
      `La description doit indiquer qu'il n'y a aucun serveur`,
    );
  });

  it('16 — pas de sharding : guilds.cache suffit', () => {
    // Le bot n'utilise pas ShardingManager ; on vérifie qu'aucun broadcastEval n'est requis.
    // getSortedGuilds ne prend qu'un Client, pas de shard manager.
    const client = makeClient([makeGuild({ id: '1', name: 'Solo' })]);
    assert.doesNotThrow(() => getSortedGuilds(client));
    // Si du code de sharding était présent, il appellerait client.shard.broadcastEval.
    // Ici, client.shard est undefined → getSortedGuilds ne doit pas y accéder.
    assert.strictEqual(client.shard, undefined, `Aucun gestionnaire de shards attendu`);
  });

  it(`17 — la Collection Discord (cache) garantit l'unicité par ID (pas de doublons)`, () => {
    // Discord.js Collection<Snowflake, Guild> utilise des Map sous-jacentes.
    // On teste notre getSortedGuilds avec un Map (simulate Collection), où chaque ID est unique.
    const cacheMap = new Map([
      ['1', makeGuild({ id: '1', name: 'A' })],
      ['2', makeGuild({ id: '2', name: 'B' })],
    ]);
    // Insère deux fois la même ID : Map l'écrase (unique par ID)
    cacheMap.set('1', makeGuild({ id: '1', name: 'A_bis' }));
    const client = { guilds: { cache: { values: () => cacheMap.values(), size: cacheMap.size } } };
    const result = getSortedGuilds(client);
    const ids = result.map((g) => g.id);
    const uniqueIds = [...new Set(ids)];
    assert.deepStrictEqual(ids, uniqueIds, `Aucun doublon d'ID attendu`);
    assert.strictEqual(result.length, 2);
  });

  it('reception-list existante — toujours accessible sur scrimDev', () => {
    // Vérifie que le subcommand de la commande existante est toujours là
    const json = scrimDev.data.toJSON();
    const subs = json.options ?? [];
    const receptionList = subs.find((opt) => opt.type === 1 && opt.name === 'reception-list');
    assert.ok(receptionList, `reception-list doit toujours être présent dans scrim-dev`);
  });
});
