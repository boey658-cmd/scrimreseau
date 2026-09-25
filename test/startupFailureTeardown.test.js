/**
 * Pre-RC micro-fix — teardownFailedStartup (demi-boot).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { teardownFailedStartup } from '../src/services/startupFailureTeardown.js';

describe('teardownFailedStartup — demi-boot', () => {
  it('HTTP fail path : jobs → http → destroy → closeDb → exitCode 1', async () => {
    const order = [];
    let destroyCount = 0;
    let dbCloseCount = 0;
    let exitCode = null;
    let httpStopped = false;

    const client = {
      destroy: async () => {
        destroyCount += 1;
        order.push('client.destroy');
      },
    };

    await teardownFailedStartup({
      client,
      stopJobs: [
        async () => {
          order.push('job1');
        },
        async () => {
          order.push('job2');
        },
      ],
      stopHttp: async () => {
        httpStopped = true;
        order.push('http');
      },
      closeDb: () => {
        dbCloseCount += 1;
        order.push('closeDb');
      },
      setExitCode: (code) => {
        exitCode = code;
        order.push(`exit:${code}`);
      },
    });

    assert.equal(destroyCount, 1);
    assert.equal(dbCloseCount, 1);
    assert.equal(httpStopped, true);
    assert.equal(exitCode, 1);
    assert.deepEqual(order, ['job1', 'job2', 'http', 'client.destroy', 'closeDb', 'exit:1']);
  });

  it('client null : closeDb + exitCode 1 sans throw', async () => {
    let dbCloseCount = 0;
    let exitCode = null;
    await teardownFailedStartup({
      client: null,
      stopJobs: [],
      stopHttp: async () => {},
      closeDb: () => {
        dbCloseCount += 1;
      },
      setExitCode: (c) => {
        exitCode = c;
      },
    });
    assert.equal(dbCloseCount, 1);
    assert.equal(exitCode, 1);
  });

  it('erreur job / destroy n’empêche pas closeDb ni exitCode', async () => {
    let dbCloseCount = 0;
    let exitCode = null;
    await teardownFailedStartup({
      client: {
        destroy: async () => {
          throw new Error('destroy fail');
        },
      },
      stopJobs: [
        async () => {
          throw new Error('job fail');
        },
      ],
      stopHttp: async () => {
        throw new Error('http fail');
      },
      closeDb: () => {
        dbCloseCount += 1;
      },
      setExitCode: (c) => {
        exitCode = c;
      },
    });
    assert.equal(dbCloseCount, 1);
    assert.equal(exitCode, 1);
  });

  it('index.js appelle teardownFailedStartup dans le catch startup', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(src, /teardownFailedStartup/);
    assert.match(src, /client\.destroy|failedClient/);
    assert.match(src, /stopScrimBroadcastDeliveryJob/);
  });
});
