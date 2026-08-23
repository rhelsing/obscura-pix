import { Obscura } from '../native/ObscuraModule';
import { resolveAudience, type AudienceFriend } from '../domain/audience';
import { obscuraSchema, audienceFor, AUTHOR_USER_ID } from '../models/schema';
import { withEntryLock } from './entryLock';
import { logError } from '../utils/log';

/**
 * Writing an entry: store it locally, then send it (`obscura-native/docs/KIT_API.md` §5, §8.1).
 *
 * This replaces `Obscura.createEntry` / `Obscura.upsertEntry`, and the difference is not cosmetic —
 * those were one call that did four things inside the kit (generate an id, store, resolve an
 * audience, fan out). Three of the four now happen here, because three of the four are application
 * decisions the kit is forbidden to make (NATIVE_CONTRACT §0.4).
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
 * within NATIVE_CONTRACT §2.4's 60-second tolerance, or our own clock moving backwards — it steps one
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

  // ATTRIBUTION, the local half of `drain.ts`'s rule: this device authored the write, so this user
  // is the author — unless the caller is updating an entry someone else created, in which case the
  // author already recorded on it stands. That second case is the viewed-receipt: the RECIPIENT
  // writes `viewedAt` onto a `pix` the sender created, and stamping self there would relabel the
  // sender's pix as one of mine.
  //
  // A peer never gets to decide this. On the way in, `drain.ts` overwrites the field with the
  // authenticated sender; the copy that goes out on the wire is only ever a carrier.
  const priorAuthor = data[AUTHOR_USER_ID];
  const stored: Record<string, unknown> = {
    ...data,
    [AUTHOR_USER_ID]: typeof priorAuthor === 'string' ? priorAuthor : selfUserId,
  };
  const payload = JSON.stringify(stored);

  // `sentAt` must beat whatever is already stored, or a local write can lose to it.
  //
  // `entryPut` is a BLIND upsert (§8.1) — the app decides who wins — so a lower `sentAt` silently
  // wins LOCALLY while losing everywhere else, which is the worst possible outcome: the user sees
  // their edit applied and no peer ever does. That is not hypothetical. NATIVE_CONTRACT §2.4 lets a stored
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
    // The author's own device, which is what the merge tie-break compares (NATIVE_CONTRACT §0.10 rule 4). For a
    // local write this device IS the authenticated author, so nothing needs authenticating.
    await Obscura.entryPut(model, id, payload, next, myDeviceId);
    return next;
  });

  try {
    await Obscura.sendEntry(recipients, model, id, sentAt, payload);
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
    //
    // Which is why the row is also MARKED. Telling the user once and then forgetting is what left
    // an undelivered entry sitting in their timeline looking sent, forever, with no trigger that
    // would ever retry it — the receive side has four (reconnect, foreground, cold start, wake) and
    // the send side had none. See `flushOutbox`.
    await markUndelivered(model, id, stored, sentAt, myDeviceId);
    logError('writeEntry.send:' + model, e);
    throw e;
  }

  return id;
}

// ─── The outbox ──────────────────────────────────────────
//
// There is no separate outbox table. The mark lives on the entry itself, which makes it durable for
// free — the entry store is SQLite in the kit's own database (§8.1) — and means an undelivered entry
// cannot be orphaned from its content. It is stripped before the payload goes on the wire: it is
// this device's delivery bookkeeping and means nothing to a peer.

/** Set on a stored entry whose send reached nobody. */
const UNDELIVERED = '_undelivered';

/**
 * Record that this entry did not reach anybody, without disturbing a newer write.
 *
 * The read-then-write under the lock is not decoration: `entryPut` is blind, so re-putting our own
 * `sentAt` after a concurrent drain stored a NEWER version of the same id would roll that version
 * back. If we have been superseded there is also nothing to retry — the newer write is what the
 * peers should get, and it has its own delivery outcome.
 */
async function markUndelivered(
  model: string, id: string, data: Record<string, unknown>,
  sentAt: number, myDeviceId: string,
): Promise<void> {
  try {
    await withEntryLock(async () => {
      const existing = (await Obscura.entryAll(model)).find((e) => e.id === id);
      if (existing === undefined || existing.sentAt !== sentAt) return;
      const marked = JSON.stringify({ ...data, [UNDELIVERED]: true });
      await Obscura.entryPut(model, id, marked, sentAt, myDeviceId);
    });
  } catch (e) {
    // Best effort. The caller is already throwing about the send; failing to record the retry must
    // not replace that error with a less useful one.
    logError('writeEntry.mark:' + model, e);
  }
}

export interface FlushOutboxArgs {
  selfUserId: string;
  friends: readonly AudienceFriend[];
}

/**
 * Retry every entry whose send reached nobody, and clear the mark on the ones that get through.
 *
 * Wired to the same signals as the inbox drain (reconnect, foreground, cold start) — the asymmetry
 * this closes is that those signals mean "the network is back", which is exactly as true for the
 * outbound half as for the inbound one.
 *
 * @returns how many entries were delivered on this pass.
 */
export async function flushOutbox(args: FlushOutboxArgs): Promise<number> {
  const { selfUserId, friends } = args;
  let delivered = 0;

  for (const model of Object.keys(obscuraSchema)) {
    let stored;
    try {
      stored = await Obscura.entryAll(model);
    } catch (e) {
      logError('flushOutbox.read:' + model, e);
      continue;
    }

    for (const row of stored) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue; // `loadEntries` already logs unreadable rows; do not log the same row twice.
      }
      if (data[UNDELIVERED] !== true) continue;

      // Strip the mark before it goes anywhere. What the peer receives must be the entry, not this
      // device's opinion about its delivery.
      const payload = { ...data };
      delete payload[UNDELIVERED];
      try {
        const recipients = resolveAudience(audienceFor(model), payload, selfUserId, friends);
        await Obscura.sendEntry(recipients, model, row.id, row.sentAt, JSON.stringify(payload));
      } catch (e) {
        // Still undelivered, or now unroutable (a friend removed since). Either way the mark stays
        // and the next trigger tries again — dropping it silently is the behaviour being fixed.
        logError('flushOutbox.send:' + model, e);
        continue;
      }

      // Clearing the mark keeps the row's `(sentAt, authorDeviceId)` exactly as it was: this is
      // bookkeeping, and it must not shift the entry's position in a REPLACE comparison.
      await withEntryLock(async () => {
        const current = (await Obscura.entryAll(model)).find((e) => e.id === row.id);
        if (current === undefined || current.sentAt !== row.sentAt) return; // superseded
        await Obscura.entryPut(model, row.id, JSON.stringify(payload), row.sentAt, current.authorDeviceId);
      });
      delivered += 1;
    }
  }

  return delivered;
}
