/**
 * Teardown après échec de démarrage (Discord éventuellement connecté / jobs Ready).
 * Ne remplace pas le graceful shutdown signal — usage startup only.
 *
 * Ordre : jobs → HTTP → client.destroy → closeDb → exitCode=1
 */

/**
 * @param {{
 *   client?: { destroy: () => void | Promise<void> } | null,
 *   stopJobs?: Array<() => void | Promise<void>>,
 *   stopHttp?: () => void | Promise<void>,
 *   closeDb: () => void,
 *   setExitCode?: (code: number) => void,
 * }} deps
 */
export async function teardownFailedStartup(deps) {
  const setExitCode = deps.setExitCode ?? ((code) => {
    process.exitCode = code;
  });

  const jobs = Array.isArray(deps.stopJobs) ? deps.stopJobs : [];
  for (const stop of jobs) {
    try {
      await stop();
    } catch {
      /* best-effort */
    }
  }

  if (typeof deps.stopHttp === 'function') {
    try {
      await deps.stopHttp();
    } catch {
      /* best-effort */
    }
  }

  const client = deps.client ?? null;
  if (client && typeof client.destroy === 'function') {
    try {
      await client.destroy();
    } catch {
      /* best-effort */
    }
  }

  try {
    deps.closeDb();
  } catch {
    /* closeDb défensif */
  }

  setExitCode(1);
}
