import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Fichier isolé : pas d’import statique pour appliquer DISCORD_TASK_QUEUE_DELAY_MS=0
 * avant le premier chargement du module queue.
 */
test('discordTaskQueue : une high pass avant les low déjà en file (FIFO conservé par niveau)', async () => {
  process.env.DISCORD_TASK_QUEUE_DELAY_MS = '0';

  const {
    startDiscordTaskQueue,
    stopDiscordTaskQueue,
    enqueueDiscordTask,
  } = await import('../src/services/discordTaskQueue.js');

  startDiscordTaskQueue();

  /** @type {string[]} */
  const order = [];

  /** @type {() => void} */
  let signalL1Started;
  const l1Started = new Promise((resolve) => {
    signalL1Started = resolve;
  });

  const pL1 = enqueueDiscordTask(async () => {
    signalL1Started();
    order.push('L1');
    await new Promise((r) => setTimeout(r, 15));
  }, { kind: 'test_l1' }, 'low');

  await l1Started;

  const pL2 = enqueueDiscordTask(async () => {
    order.push('L2');
  }, { kind: 'test_l2' }, 'low');

  const pH1 = enqueueDiscordTask(async () => {
    order.push('H1');
  }, { kind: 'test_h1' }, 'high');

  await Promise.all([pL1, pL2, pH1]);

  assert.deepEqual(order, ['L1', 'H1', 'L2']);

  await stopDiscordTaskQueue();
});
