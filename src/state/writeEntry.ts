import { Obscura } from '../native/ObscuraModule';
import {
  resolveAudience, DirectRoutingUnresolved,
  type AudienceConfig, type AudienceFriend,
} from '../domain/audience';
import { obscuraSchema } from '../models/schema';
import { withEntryLock } from './entryLock';
import { logError } from '../utils/log';

/**
 * Writing an entry: store it locally, then send it (`obscura-proto/KIT_API.md` §5, §8.1).
 *
 * This replaces `Obscura.createEntry` / `Obscura.upsertEntry`, and the difference is not cosmetic —
 * those were one call that did four things inside the kit (generate an id, store, resolve an
 * audience, fan out). Three of the four now happen here, because three of the four are application
 * decisions the kit is forbidden to make (SPEC §0.4).
 *
 * ## The order, and why
 *
 * ```
 * resolve audience → WRITE locally → THEN send
 * ```
 *
 * - **Audience first**, because it can throw. An entry with an unresolvable audience must not be
 *   stored either: a local row the user can see but that reached nobody is worse than a refusal.
 * - **Write before send**, because the local write is the one that must not be lost. The user's own
 *   content is theirs whether or not the network cooperated; a send failure is retriable, a lost
 *   write is not. This also mirrors what the ORM did — "the local write survives; the server
 *   retries" — so behaviour does not change under the app.
 *
 * ## The sender writes its own copy
 *
 * §5 property 2: `send` produces no inbox row for the sender, by design. So this is the *only* place
 * an outgoing entry gets stored — there is no loopback to rely on, and the drain will never see it.
 */

/**
 * The audience `schema.ts` declares for a model.
 *
 * **Throws on a model the schema does not declare**, and that is the point. Before this check, a
 * lookup miss and a deliberate "no audience declared" were indistinguishable — both produced
 * `undefined`, which `resolveAudience` treats as *broadcast to every friend*. So a single-character
 * typo in a model name turned a 1:1 message into a broadcast, silently. An unknown model is a bug in
 * the app, and a bug must not fail open into a wider audience.
 */
function audienceFor(model: string): AudienceConfig | undefined {
  if (!Object.prototype.hasOwnProperty.call(obscuraSchema, model)) {
    throw new DirectRoutingUnresolved(
      `'${model}' is not declared in schema.ts, so its audience is unknown`,
    );
  }
  const config = (obscuraSchema as Record<string, { audience?: AudienceConfig }>)[model];
  return config?.audience;
}

/**
 * A new entry id.
 *
 * Timestamp plus randomness, matching the shape the kit generated (`story_1706389200_abc123`). Both
 * halves matter: the timestamp keeps ids roughly ordered for a human reading the store, and the
 * randomness is what makes APPEND's dedupe-by-id safe — two devices creating an entry in the same
 * millisecond must not collide, or one would silently discard the other's.
 */
export function newEntryId(model: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${model}_${Date.now()}_${random}`;
}

/**
 * A timestamp that is guaranteed to win against what is already stored for this entry.
 *
 * Normally just `Date.now()`. When an existing row is somehow ahead of us — a peer's clock skew
 * within SPEC §2.4's 60-second tolerance, or our own clock moving backwards — it steps one
 * millisecond past it instead. `+1` rather than a larger jump because the goal is only to win this
 * comparison, not to poison every future one.
 */
async function nextSentAt(model: string, id: string): Promise<number> {
  const now = Date.now();
  try {
    const existing = (await Obscura.entryAll(model)).find((e) => e.id === id);
    return existing === undefined ? now : Math.max(now, existing.sentAt + 1);
  } catch {
    // If we cannot read, do not block the write — `now` is right in every case except the skew one.
    return now;
  }
}

export interface WriteEntryArgs {
  model: string;
  /** Omit to create; pass an existing id to update (a REPLACE model's second write). */
  id?: string;
  data: Record<string, unknown>;
  selfUserId: string;
  myDeviceId: string;
  friends: readonly AudienceFriend[];
}

/**
 * Store an entry locally and send it to its audience.
 *
 * @throws DirectRoutingUnresolved when the audience cannot be resolved — nothing is stored or sent.
 * @returns the entry id, generated when not supplied.
 */
export async function writeEntry(args: WriteEntryArgs): Promise<string> {
  const { model, data, selfUserId, myDeviceId, friends } = args;

  // Throws before anything is written. An unresolvable audience must not leave a local row behind.
  const recipients = resolveAudience(audienceFor(model), data, selfUserId, friends);

  const id = args.id ?? newEntryId(model);
  const payload = JSON.stringify(data);

  // `sentAt` must beat whatever is already stored, or a local write can lose to it.
  //
  // `entryPut` is a BLIND upsert (§8.1) — the app decides who wins — so a lower `sentAt` silently
  // wins LOCALLY while losing everywhere else, which is the worst possible outcome: the user sees
  // their edit applied and no peer ever does. That is not hypothetical. SPEC §2.4 lets a stored
  // `sentAt` run up to `now + 60s` (the kit clamps to exactly that), so a peer with a fast clock
  // leaves a row 45 seconds in our future; anything we write inside that window has a lower
  // timestamp and loses every REPLACE comparison on every other device. The same happens between
  // two of a user's own devices with skewed clocks.
  //
  // Reading first and stepping past it keeps the local write authoritative, which is what the user
  // just asked for.
  //
  // Read and write under the lock together: computing `sentAt` from a row that a concurrent drain
  // then replaces would put us right back where we started.
  //
  // The SEND deliberately stays OUTSIDE the lock — it is a network call, and holding a store-wide
  // lock across it would let one slow recipient stall every write in the app.
  const sentAt = await withEntryLock(async () => {
    const next = await nextSentAt(model, id);
    // The author's own device, which is what the merge tie-break compares (SPEC §0.10 rule 4). For a
    // local write this device IS the authenticated author, so nothing needs authenticating.
    await Obscura.entryPut(model, id, payload, next, myDeviceId);
    return next;
  });

  try {
    await Obscura.sendEntry(recipients, model, id, args.id === undefined ? 'CREATE' : 'UPDATE', sentAt, payload);
  } catch (e) {
    // The local write already succeeded and STAYS — the user's content is theirs whether or not the
    // network cooperated, and undoing it would be the worse failure.
    //
    // But the error is re-thrown rather than only logged, because the kit throws here **only when a
    // send reached NOBODY** (a partial failure is best-effort and silent by design). Swallowing that
    // would leave the user looking at an entry in their own timeline, with no indication it got
    // nowhere, forever. An earlier version justified swallowing with "the kit queues and retries" —
    // that is not true in the sense required: the retry queue is in-memory, flushed on the next
    // send, and lost on process death.
    logError('writeEntry.send:' + model, e);
    throw e;
  }

  return id;
}
