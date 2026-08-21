/**
 * Tests du graceful shutdown — createGracefulShutdown (shutdownOrchestrator.js)
 *
 * Vérifie :
 * - Idempotence : SIGINT + SIGTERM simultanés → une seule séquence
 * - Idempotence : deux SIGINT → une seule séquence
 * - Ordre strict : worker → client Discord → SQLite
 * - worker arrêté exactement une fois
 * - client.destroy() appelé exactement une fois
 * - closeDb() appelé exactement une fois
 * - Erreur d'un composant ne bloque pas les suivants
 * - Aucune promesse rejetée non gérée
 * - Mutation : sans garde-fou, les tests doivent échouer
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGracefulShutdown } from '../src/services/shutdownOrchestrator.js';

/**
 * Construit un environnement de test avec compteurs.
 *
 * @param {{
 *   steps?: Array<{ name: string, phase: string, stop: () => void | Promise<void> }>,
 *   clientDestroyFn?: () => void | Promise<void>,
 *   closeDbFn?: () => void,
 *   exitFn?: (code: number) => void,
 * }} [opts]
 */
function makeEnv({
  steps = [],
  clientDestroyFn,
  closeDbFn,
  exitFn = () => {},
} = {}) {
  const calls = {
    destroyCount: 0,
    dbCloseCount: 0,
    exitCode: /** @type {number | null} */ (null),
    order: /** @type {string[]} */ ([]),
  };

  const client = {
    destroy: async () => {
      calls.destroyCount++;
      calls.order.push('client.destroy');
      if (clientDestroyFn) await clientDestroyFn();
    },
  };

  const closeDb = () => {
    calls.dbCloseCount++;
    calls.order.push('closeDb');
    if (closeDbFn) closeDbFn();
  };

  const onExit = (code) => {
    calls.exitCode = code;
    if (exitFn) exitFn(code);
  };

  const gracefulShutdown = createGracefulShutdown({
    steps,
    getClient: () => client,
    closeDb,
    onExit,
  });

  return { gracefulShutdown, calls, client };
}

describe('createGracefulShutdown — idempotence', () => {
  it('un seul SIGINT → exactement une séquence', async () => {
    let execCount = 0;
    const { gracefulShutdown } = makeEnv({
      steps: [{ name: 'step1', phase: 'step1', stop: () => { execCount++; } }],
    });
    await gracefulShutdown('SIGINT');
    assert.strictEqual(execCount, 1, 'La séquence doit s\'exécuter exactement une fois');
  });

  it('SIGINT + SIGTERM simultanés → exactement une séquence', async () => {
    let execCount = 0;
    const { gracefulShutdown } = makeEnv({
      steps: [{
        name: 'step1',
        phase: 'step1',
        stop: async () => {
          execCount++;
          await new Promise((r) => setTimeout(r, 20));
        },
      }],
    });
    const p1 = gracefulShutdown('SIGINT');
    const p2 = gracefulShutdown('SIGTERM');
    await Promise.all([p1, p2]);
    assert.strictEqual(execCount, 1, 'SIGINT + SIGTERM : une seule séquence attendue');
  });

  it('deux SIGINT rapprochés → exactement une séquence', async () => {
    let execCount = 0;
    const { gracefulShutdown } = makeEnv({
      steps: [{
        name: 'step1',
        phase: 'step1',
        stop: async () => {
          execCount++;
          await new Promise((r) => setTimeout(r, 20));
        },
      }],
    });
    const p1 = gracefulShutdown('SIGINT');
    const p2 = gracefulShutdown('SIGINT');
    await Promise.all([p1, p2]);
    assert.strictEqual(execCount, 1, 'Double SIGINT : une seule séquence attendue');
  });

  it('appels successifs après complétion → toujours une seule séquence', async () => {
    let execCount = 0;
    const { gracefulShutdown } = makeEnv({
      steps: [{ name: 'step1', phase: 'step1', stop: () => { execCount++; } }],
    });
    await gracefulShutdown('SIGINT');
    await gracefulShutdown('SIGTERM');
    assert.strictEqual(execCount, 1, 'Appels successifs post-completion : une seule exécution');
  });
});

describe('createGracefulShutdown — ordre strict', () => {
  it('worker arrêté avant client.destroy et closeDb', async () => {
    const order = /** @type {string[]} */ ([]);
    const { gracefulShutdown } = makeEnv({
      steps: [
        {
          name: 'worker persistant',
          phase: 'worker_stop',
          stop: () => { order.push('worker'); },
        },
        {
          name: 'file Discord',
          phase: 'queue_stop',
          stop: () => { order.push('queue'); },
        },
      ],
      clientDestroyFn: () => { order.push('client'); },
      closeDbFn: () => { order.push('db'); },
    });
    await gracefulShutdown('SIGINT');
    assert.deepStrictEqual(order, ['worker', 'queue', 'client', 'db'],
      'Ordre attendu : worker → queue → client → db');
  });

  it('client.destroy appelé exactement une fois', async () => {
    const { gracefulShutdown, calls } = makeEnv();
    await gracefulShutdown('SIGINT');
    assert.strictEqual(calls.destroyCount, 1, 'client.destroy doit être appelé une seule fois');
  });

  it('closeDb appelé exactement une fois', async () => {
    const { gracefulShutdown, calls } = makeEnv();
    await gracefulShutdown('SIGINT');
    assert.strictEqual(calls.dbCloseCount, 1, 'closeDb doit être appelé une seule fois');
  });

  it('SIGINT + SIGTERM simultanés : client.destroy appelé une seule fois', async () => {
    const { gracefulShutdown, calls } = makeEnv({
      steps: [{
        name: 'slow step',
        phase: 'slow',
        stop: () => new Promise((r) => setTimeout(r, 15)),
      }],
    });
    await Promise.all([gracefulShutdown('SIGINT'), gracefulShutdown('SIGTERM')]);
    assert.strictEqual(calls.destroyCount, 1, 'client.destroy une seule fois même avec deux signaux');
  });

  it('SIGINT + SIGTERM simultanés : closeDb appelé une seule fois', async () => {
    const { gracefulShutdown, calls } = makeEnv({
      steps: [{
        name: 'slow step',
        phase: 'slow',
        stop: () => new Promise((r) => setTimeout(r, 15)),
      }],
    });
    await Promise.all([gracefulShutdown('SIGINT'), gracefulShutdown('SIGTERM')]);
    assert.strictEqual(calls.dbCloseCount, 1, 'closeDb une seule fois même avec deux signaux');
  });

  it('SQLite fermée après client Discord', async () => {
    const { gracefulShutdown, calls } = makeEnv();
    await gracefulShutdown('SIGINT');
    const clientIdx = calls.order.indexOf('client.destroy');
    const dbIdx = calls.order.indexOf('closeDb');
    assert.ok(clientIdx < dbIdx, 'closeDb doit être appelé après client.destroy');
  });

  it('onExit(0) appelé à la fin', async () => {
    const { gracefulShutdown, calls } = makeEnv();
    await gracefulShutdown('SIGINT');
    assert.strictEqual(calls.exitCode, 0, 'onExit doit être appelé avec code 0');
  });
});

describe('createGracefulShutdown — robustesse', () => {
  it('erreur sur un step n\'empêche pas les steps suivants', async () => {
    const order = /** @type {string[]} */ ([]);
    const { gracefulShutdown } = makeEnv({
      steps: [
        {
          name: 'step1 (échoue)',
          phase: 'step1',
          stop: () => { order.push('step1'); throw new Error('crash step1'); },
        },
        {
          name: 'step2 (doit s\'exécuter)',
          phase: 'step2',
          stop: () => { order.push('step2'); },
        },
      ],
      clientDestroyFn: () => { order.push('client'); },
      closeDbFn: () => { order.push('db'); },
    });
    await gracefulShutdown('SIGINT');
    assert.ok(order.includes('step2'), 'step2 doit s\'exécuter malgré l\'erreur de step1');
    assert.ok(order.includes('client'), 'client.destroy doit s\'exécuter malgré l\'erreur de step1');
    assert.ok(order.includes('db'), 'closeDb doit s\'exécuter malgré l\'erreur de step1');
  });

  it('erreur client.destroy n\'empêche pas closeDb', async () => {
    const { gracefulShutdown, calls } = makeEnv({
      clientDestroyFn: () => { throw new Error('crash client.destroy'); },
    });
    await gracefulShutdown('SIGINT');
    assert.strictEqual(calls.dbCloseCount, 1, 'closeDb doit être appelé même si client.destroy échoue');
  });

  it('worker persistant arrêté une seule fois (feature flag ON)', async () => {
    let workerStopCount = 0;
    const { gracefulShutdown } = makeEnv({
      steps: [
        {
          name: 'worker persistant',
          phase: 'worker_stop',
          stop: () => { workerStopCount++; },
        },
      ],
    });
    const p1 = gracefulShutdown('SIGINT');
    const p2 = gracefulShutdown('SIGTERM');
    await Promise.all([p1, p2]);
    assert.strictEqual(workerStopCount, 1, 'Le worker persistant ne doit être arrêté qu\'une seule fois');
  });

  it('aucune promesse rejetée non gérée sur SIGINT + SIGTERM', async () => {
    const errors = /** @type {unknown[]} */ ([]);
    const origHandler = process.listeners('unhandledRejection').slice(-1)[0];

    // Temporairement surveiller les rejets non gérés
    process.once('unhandledRejection', (reason) => { errors.push(reason); });

    const { gracefulShutdown } = makeEnv({
      steps: [
        {
          name: 'step avec rejet',
          phase: 'reject',
          stop: async () => { throw new Error('rejet contrôlé'); },
        },
      ],
    });
    await Promise.all([gracefulShutdown('SIGINT'), gracefulShutdown('SIGTERM')]);

    // Nettoyer le listener de test
    process.removeListener('unhandledRejection', /** @type {never} */ (origHandler));

    assert.strictEqual(errors.length, 0, 'Aucune promesse rejetée non gérée ne doit apparaître');
  });
});

describe('createGracefulShutdown — MUTATION', () => {
  it('MUTATION : sans garde-fou shutdownPromise, double exécution serait possible', async () => {
    // Simule createGracefulShutdown SANS le garde-fou (version mutante)
    let execCount = 0;

    const mutantGracefulShutdown = async () => {
      // Mutant : pas de guard → exécute toujours
      execCount++;
      await new Promise((r) => setTimeout(r, 10));
    };

    const p1 = mutantGracefulShutdown();
    const p2 = mutantGracefulShutdown();
    await Promise.all([p1, p2]);

    // Le mutant exécute deux fois — ce comportement prouve que le garde-fou est nécessaire
    assert.strictEqual(execCount, 2, 'Sans garde-fou, double exécution confirmée (comportement muté)');

    // La version réelle avec garde-fou exécute une seule fois
    let realExecCount = 0;
    const { gracefulShutdown } = makeEnv({
      steps: [{
        name: 'step',
        phase: 'step',
        stop: async () => {
          realExecCount++;
          await new Promise((r) => setTimeout(r, 10));
        },
      }],
    });
    await Promise.all([gracefulShutdown('SIGINT'), gracefulShutdown('SIGTERM')]);
    assert.strictEqual(realExecCount, 1, 'Avec garde-fou, une seule exécution confirmée');
  });

  it('MUTATION : listener redondant dans bot.js — plus aucun process.once SIGINT/SIGTERM dans bot.js', async () => {
    // Lit le source de bot.js pour confirmer l'absence des handlers redondants
    const fs = await import('node:fs/promises');
    const botSrc = await fs.readFile(new URL('../src/bot.js', import.meta.url), 'utf8');
    const hasSigint = botSrc.includes("process.once('SIGINT'") || botSrc.includes('process.once("SIGINT"');
    const hasSigterm = botSrc.includes("process.once('SIGTERM'") || botSrc.includes('process.once("SIGTERM"');
    assert.strictEqual(hasSigint, false, 'bot.js ne doit plus contenir process.once(\'SIGINT\')');
    assert.strictEqual(hasSigterm, false, 'bot.js ne doit plus contenir process.once(\'SIGTERM\')');
  });

  it('MUTATION : index.js doit contenir exactement UN enregistrement par signal', async () => {
    const fs = await import('node:fs/promises');
    const indexSrc = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    // Compte les enregistrements SIGINT et SIGTERM dans index.js
    const sigintMatches = (indexSrc.match(/process\.on\('SIGINT'/g) ?? []).length;
    const sigtermMatches = (indexSrc.match(/process\.on\('SIGTERM'/g) ?? []).length;
    assert.strictEqual(sigintMatches, 1, 'index.js doit enregistrer SIGINT exactement une fois');
    assert.strictEqual(sigtermMatches, 1, 'index.js doit enregistrer SIGTERM exactement une fois');
  });

  it('MUTATION : stopScrimBroadcastDeliveryJob doit être référencé dans index.js', async () => {
    const fs = await import('node:fs/promises');
    const indexSrc = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.ok(
      indexSrc.includes('stopScrimBroadcastDeliveryJob'),
      'stopScrimBroadcastDeliveryJob doit être présent dans index.js',
    );
  });

  it('MUTATION : stop broadcast ne doit PAS être conditionné au feature flag', async () => {
    const fs = await import('node:fs/promises');
    const indexSrc = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.equal(
      indexSrc.includes('isPersistentBroadcastEnabled'),
      false,
      'index.js ne doit plus importer/utiliser isPersistentBroadcastEnabled pour le shutdown',
    );
    // Le step stop doit appeler stopScrimBroadcastDeliveryJob sans if (flag)
    const stopBlock = indexSrc.match(
      /phase:\s*'persistent_broadcast_job_stop'[\s\S]*?stop:\s*([^,}]+)/,
    );
    assert.ok(stopBlock, 'step persistent_broadcast_job_stop introuvable');
    assert.equal(
      /isPersistentBroadcastEnabled/.test(stopBlock[0]),
      false,
      'stop broadcast ne doit pas dépendre du flag',
    );
  });
});
