/**
 * Friend-QR payload format. The QR encodes the friend code behind an Obscura
 * prefix so the scanner can ignore any non-Obscura QR it happens to see and
 * only react to ours. Shared by the QR generator (AddFriendScreen) and the
 * scanner (camera scan mode).
 */
const PREFIX = 'obscura:friend:';

/** Wrap a friend code into the QR payload string. */
export function encodeFriendQR(code: string): string {
  return `${PREFIX}${code}`;
}

/** Extract the friend code from a scanned QR value, or null if it isn't ours. */
export function parseFriendQR(value: string | null | undefined): string | null {
  if (!value || !value.startsWith(PREFIX)) return null;
  const code = value.slice(PREFIX.length).trim();
  return code.length > 0 ? code : null;
}
