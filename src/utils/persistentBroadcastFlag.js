/**
 * Feature flag pour la diffusion persistante.
 * Désactivé par défaut — activer avec SCRIM_PERSISTENT_BROADCAST_ENABLED=1
 */
export function isPersistentBroadcastEnabled() {
  const v = process.env.SCRIM_PERSISTENT_BROADCAST_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}
