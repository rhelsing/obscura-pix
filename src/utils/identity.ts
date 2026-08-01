/**
 * Turning an authenticated userId into something to put on screen (SPEC §0.5, KIT_API §8.3).
 *
 * > The envelope tells you *who really sent this*. The payload tells you *what they chose to say*.
 * > Never confuse the two.
 *
 * Every rendered name resolves through the **local friend graph**, keyed by
 * the userId from the authenticated envelope.
 *
 * Resolving at render time rather than storing a snapshot is deliberate: a friend who changes their
 * username should be relabelled everywhere, and a stored copy of a name is a stored copy of a claim
 * that was true once.
 */

import type { Friend } from '../native/ObscuraModule';

export interface Identity {
  myUserId: string;
  myUsername: string;
  friends: readonly Friend[];
}

/**
 * The display name for `userId`, or `null` when this device has no authenticated name for them.
 *
 * `null` is not a rendering hint, it is the honest answer: the user is neither me nor an accepted
 * friend, so the only name available would be one they chose for themselves. Callers filter such
 * content out rather than labelling it "unknown" — a stranger can deliver to any device (KIT_API
 * §4.1), and an unnamed row in the feed is still a row a stranger put there.
 */
export function displayNameFor(userId: string, id: Identity): string | null {
  if (userId === '') return null;
  if (userId === id.myUserId) return id.myUsername;
  return id.friends.find((f) => f.userId === userId && f.status === 'accepted')?.username ?? null;
}

/** The authenticated author of an entry, or `''` when it carries none. */
export function authorOf(data: Record<string, unknown>, key: string): string {
  const author = data[key];
  return typeof author === 'string' ? author : '';
}
