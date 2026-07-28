import { Obscura } from '../native/ObscuraModule';
import { resolveAudience, type AudienceConfig, type AudienceFriend } from '../domain/audience';
import { obscuraSchema } from '../models/schema';
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

/** `schema.ts` declares audience per model; an absent one means "all accepted friends". */
function audienceFor(model: string): AudienceConfig | undefined {
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
  const sentAt = Date.now();
  const payload = JSON.stringify(data);

  // The author's own device, which is what the merge tie-break compares (SPEC §0.10 rule 4). For a
  // local write this device IS the authenticated author, so there is nothing to authenticate against.
  await Obscura.entryPut(model, id, payload, sentAt, myDeviceId);

  try {
    await Obscura.sendEntry(recipients, model, id, args.id === undefined ? 'CREATE' : 'UPDATE', sentAt, payload);
  } catch (e) {
    // The local write already succeeded, so the user keeps their content. The kit queues and retries
    // sends of its own accord; surfacing this as a throw would make the caller undo a write that is
    // perfectly good.
    logError('writeEntry.send:' + model, e);
  }

  return id;
}
