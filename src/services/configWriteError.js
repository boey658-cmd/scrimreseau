/**
 * Erreurs métier config write (Web5B) — mappées vers HTTP sans stack/SQL.
 */

export class ConfigWriteError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} [message]
   */
  constructor(status, code, message = code) {
    super(message);
    this.name = 'ConfigWriteError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {unknown} err
 * @returns {err is ConfigWriteError}
 */
export function isConfigWriteError(err) {
  return err instanceof ConfigWriteError;
}
