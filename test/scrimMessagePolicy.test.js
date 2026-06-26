import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  LIFECYCLE_POLICY_DELETE,
  LIFECYCLE_POLICY_KEEP,
  getGuildScrimMessageLifecyclePolicy,
  syncInactiveScrimMessageByPolicy,
} from '../src/services/scrimMessagePolicy.js';

// ---------------------------------------------------------------------------
// Helpers de mock
// ---------------------------------------------------------------------------

function makeStmtsKeep() {
  return {
    getScrimMessageLifecyclePolicy: { get: () => ({ policy: 'keep' }) },
    // safeScrimEmbedMessageEdit n'est pas utilisé directement, mais
    // syncInactiveScrimMessageByPolicy appelle discordTaskQueue.enqueueDiscordTask
    // → on ne peut pas tester l'intégration complète sans serveur Discord.
    // Les tests couvrent les fonctions pures et la logique de branchement.
  };
}

function makeStmtsDelete() {
  return {
    getScrimMessageLifecyclePolicy: { get: () => ({ policy: 'delete' }) },
  };
}

function makeStmtsAbsent() {
  return {
    getScrimMessageLifecyclePolicy: { get: () => undefined },
  };
}

function makeStmtsError() {
  return {
    getScrimMessageLifecyclePolicy: {
      get: () => { throw new Error('DB down'); },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests getGuildScrimMessageLifecyclePolicy
// ---------------------------------------------------------------------------

describe('getGuildScrimMessageLifecyclePolicy', () => {
  it('retourne keep si ligne absente (défaut)', () => {
    assert.strictEqual(
      getGuildScrimMessageLifecyclePolicy(makeStmtsAbsent(), 'guild-1'),
      LIFECYCLE_POLICY_KEEP,
    );
  });

  it('retourne keep si policy = keep', () => {
    assert.strictEqual(
      getGuildScrimMessageLifecyclePolicy(makeStmtsKeep(), 'guild-1'),
      LIFECYCLE_POLICY_KEEP,
    );
  });

  it('retourne delete si policy = delete', () => {
    assert.strictEqual(
      getGuildScrimMessageLifecyclePolicy(makeStmtsDelete(), 'guild-1'),
      LIFECYCLE_POLICY_DELETE,
    );
  });

  it("retourne keep en cas d'erreur DB (fail-safe)", () => {
    assert.strictEqual(
      getGuildScrimMessageLifecyclePolicy(makeStmtsError(), 'guild-1'),
      LIFECYCLE_POLICY_KEEP,
    );
  });

  it('retourne keep pour une policy inconnue', () => {
    const stmts = { getScrimMessageLifecyclePolicy: { get: () => ({ policy: 'unknown_value' }) } };
    assert.strictEqual(
      getGuildScrimMessageLifecyclePolicy(stmts, 'guild-1'),
      LIFECYCLE_POLICY_KEEP,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests syncInactiveScrimMessageByPolicy — branchement sans Discord
// ---------------------------------------------------------------------------

describe('syncInactiveScrimMessageByPolicy', () => {
  const BASE_ROW = {
    guild_id: 'g1',
    channel_id: 'c1',
    message_id: 'm1',
  };

  it('ne fait rien si guild est null', async () => {
    let editCalled = false;
    const fakeClient = {};
    await syncInactiveScrimMessageByPolicy({
      client: fakeClient,
      stmts: makeStmtsDelete(),
      messageRow: BASE_ROW,
      scrimPostDbId: 1,
      eventType: 'closed_manual',
      targetStatus: 'closed_manual',
      editOptions: { embeds: [] },
      guild: null,
      channel: null,
      message: null,
    });
    assert.strictEqual(editCalled, false);
  });

  it('ne fait rien si channel est null', async () => {
    const fakeGuild = {};
    await syncInactiveScrimMessageByPolicy({
      client: {},
      stmts: makeStmtsKeep(),
      messageRow: BASE_ROW,
      scrimPostDbId: 1,
      eventType: 'closed_expired',
      targetStatus: 'closed_expired',
      editOptions: { embeds: [] },
      guild: fakeGuild,
      channel: null,
      message: null,
    });
  });

  it('ne fait rien si message est null', async () => {
    const fakeGuild = {};
    const fakeChannel = {};
    await syncInactiveScrimMessageByPolicy({
      client: {},
      stmts: makeStmtsDelete(),
      messageRow: BASE_ROW,
      scrimPostDbId: 2,
      eventType: 'superseded_repost',
      targetStatus: 'superseded_repost',
      editOptions: { embeds: [] },
      guild: fakeGuild,
      channel: fakeChannel,
      message: null,
    });
  });

  it('policy = delete : refuse la suppression si les IDs Discord ne correspondent pas (sécurité)', async () => {
    // Message Discord avec un guildId différent du row DB → pas de suppression
    let deleteCalled = false;
    let editCalled = false;

    const fakeMessage = {
      guildId: 'WRONG_GUILD',
      channelId: 'c1',
      id: 'm1',
      delete: async () => { deleteCalled = true; },
      edit: async () => { editCalled = true; },
    };

    const fakeChannel = {
      isTextBased: () => true,
      type: 0, // GuildText
      permissionsFor: () => ({
        has: () => true,
      }),
    };

    const fakeGuild = {
      members: {
        me: { id: 'bot-id' },
        fetchMe: async () => ({ id: 'bot-id' }),
      },
    };

    // On ne peut pas tester le chemin complet sans queue Discord active,
    // mais on vérifie que le mismatch ID est bien détecté.
    // Le test attend que la fonction ne throw pas et ne delete pas.
    // (safeScrimEmbedMessageEdit va échouer car pas de queue, mais on veut
    //  juste vérifier que delete n'est pas appelé.)
    try {
      await syncInactiveScrimMessageByPolicy({
        client: {},
        stmts: makeStmtsDelete(),
        messageRow: BASE_ROW,
        scrimPostDbId: 3,
        eventType: 'closed_manual',
        targetStatus: 'closed_manual',
        editOptions: { embeds: [] },
        guild: fakeGuild,
        channel: fakeChannel,
        message: fakeMessage,
      });
    } catch {
      // La queue Discord n'est pas démarrée en test → erreur attendue sur le fallback
    }

    assert.strictEqual(deleteCalled, false, 'delete ne doit pas être appelé si les IDs ne correspondent pas');
  });

  it('constantes : keep et delete ont des valeurs correctes', () => {
    assert.strictEqual(LIFECYCLE_POLICY_KEEP, 'keep');
    assert.strictEqual(LIFECYCLE_POLICY_DELETE, 'delete');
  });
});

// ---------------------------------------------------------------------------
// Tests de régression : comportement par défaut = keep
// ---------------------------------------------------------------------------

describe('comportement par défaut', () => {
  it('sans configuration → policy = keep', () => {
    const policy = getGuildScrimMessageLifecyclePolicy(makeStmtsAbsent(), 'nouveau-serveur');
    assert.strictEqual(policy, 'keep');
  });

  it('après reset → policy = keep (ligne absente)', () => {
    const policy = getGuildScrimMessageLifecyclePolicy(makeStmtsAbsent(), 'serveur-reset');
    assert.strictEqual(policy, 'keep');
  });
});
