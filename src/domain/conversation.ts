/**
 * The canonical two-party conversation id (`docs/DOMAIN_CONTRACT.md`, "Canonical conversation ID").
 *
 * One constructor and one parser, in the domain rather than in the bridge facade, because this id is
 * the audience key on the way out (`audience.ts`) and the authorization key on the way in
 * (`drain.ts`). Written more than once, the two directions drift: the send side rejected an empty
 * participant while the receive side accepted it, and neither enforced the sort order the contract
 * requires.
 */

/**
 * NOTE the constraint this separator imposes: **a userId must not contain `_`**. Server-issued ids
 * are UUIDs (hyphens, no underscores), and both kits split the same way, so this holds today — but
 * it is an assumption, not a guarantee, and it is silent when violated. It fails in the SAFE
 * direction at least: an id with an extra `_` yields the wrong participant count and is refused,
 * rather than parsing to a wrong or wider audience.
 */
const SEPARATOR = '_';

/**
 * The id of the conversation between two users.
 *
 * Sorted, so both participants compute the same string from their own point of view. This is the
 * only constructor in the system; everything else parses.
 */
export function conversationId(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(SEPARATOR);
}

/**
 * The two participants of a canonical conversation id, or `null` when `id` is not one.
 *
 * Canonical is exactly what `conversationId` builds: two non-empty user ids in sorted order.
 * Anything else is REFUSED rather than interpreted, because the alternative is guessing an audience
 * (`DOMAIN_CONTRACT.md`) and a wrong guess mails a 1:1 payload to the wrong person.
 *
 * Sort order is part of the format, not a nicety. The only constructor sorts, so a reversed id was
 * not built by this app or by a peer running it; accepting one accepts an id of unknown provenance
 * as if it were our own.
 *
 * Membership is deliberately NOT decided here. The send and receive sides ask different questions of
 * the same two participants — `audience.ts` requires self, `drain.ts` requires self *and* the
 * authenticated sender — and collapsing them would weaken one of the two.
 */
export function parseConversationId(id: string): [string, string] | null {
  const parts = id.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const [first, second] = parts;
  if (first.length === 0 || second.length === 0) return null;
  if (first > second) return null;
  return [first, second];
}
