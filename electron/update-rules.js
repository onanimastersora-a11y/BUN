// When a downloaded update may restart BUN by itself (no Electron import, so it can be tested).

export const AWAY_SECONDS = 10 * 60; // no keyboard or mouse for this long
export const BOOT_MS = 15 * 60 * 1000; // BUN started with the computer this recently

/**
 * 'boot': BUN just started with the computer and its window isn't open, so nobody is using it yet.
 * 'away': nobody has touched the computer for a while.
 * null: wait for the button, for quitting, or for one of the above.
 */
export function autoInstallReason({ now, bootUntil, mainVisible, idleSeconds }) {
  if (now < bootUntil && !mainVisible) return 'boot';
  if (idleSeconds >= AWAY_SECONDS) return 'away';
  return null;
}
