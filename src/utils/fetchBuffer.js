/**
 * Télécharge un buffer depuis une URL (timeout strict).
 * Helper partagé (dashboard réseau, scripts locaux).
 *
 * @param {string} url
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<Buffer | null>}
 */
export async function fetchBuffer(url, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}
