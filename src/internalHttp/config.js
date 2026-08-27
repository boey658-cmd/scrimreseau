/**
 * Configuration serveur HTTP interne (Web2B).
 * Host hardcodé 127.0.0.1 — jamais 0.0.0.0.
 */

export const INTERNAL_HTTP_HOST = '127.0.0.1';

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: false } | { enabled: true, port: number, token: string }}
 */
export function parseInternalHttpConfig(env = process.env) {
  const rawPort = env.INTERNAL_HTTP_PORT?.trim() ?? '';
  if (!rawPort) {
    return { enabled: false };
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error('INTERNAL_HTTP_PORT invalide : entier attendu');
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`INTERNAL_HTTP_PORT hors plage (${MIN_PORT}–${MAX_PORT})`);
  }

  const token = env.INTERNAL_HTTP_TOKEN?.trim() ?? '';
  if (!token) {
    throw new Error('INTERNAL_HTTP_TOKEN obligatoire quand INTERNAL_HTTP_PORT est défini');
  }

  return { enabled: true, port, token };
}

/**
 * @param {unknown} config
 * @returns {config is { enabled: true, port: number, token: string }}
 */
export function isInternalHttpEnabled(config) {
  return typeof config === 'object' && config !== null && config.enabled === true;
}
