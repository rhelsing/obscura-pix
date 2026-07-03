/**
 * Lightweight JS-side diagnostic log.
 *
 * Swallowed-error handlers route here (`logError`) so failures are VISIBLE —
 * in the console AND the in-app debug log (Settings/Profile) — instead of
 * vanishing into a no-op `.catch(() => {})`. This exists because silently
 * swallowed errors hid two real bugs: pix view-once (a failed `viewedAt`
 * upsert) and the camera `file://` path (a failed resize). The ESLint
 * `no-restricted-syntax` rule bans new empty catches; this is where they go.
 */
const buffer: string[] = [];
const MAX_LINES = 200;

/** Record a (usually swallowed) error. Best-effort ops stay best-effort — they
 *  just become visible when they fail. */
export function logError(tag: string, e: unknown): void {
  const msg = (e as { message?: string })?.message ?? String(e);
  const line = `[${tag}] ${msg}`;
  console.warn(line);
  const ts = new Date().toISOString().slice(11, 19);
  buffer.push(`${ts} JS ${line}`);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

/** Snapshot of the JS log lines — merged into the in-app debug log view. */
export function getJsLog(): string[] {
  return buffer.slice();
}
