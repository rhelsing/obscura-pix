/**
 * Serialises everything that writes to the entry store.
 *
 * ## Why this exists
 *
 * Both write paths call `Obscura.entryPut`, which is a **blind** upsert by contract (`KIT_API.md`
 * §8.1) — the app decides who wins, so the store applies whatever it is handed. That is correct, and
 * it makes overlapping writers dangerous in a specific way:
 *
 * ```
 * drain:  read state ──────────────────────► merge ──► put(peer's entry)
 * write:            put(my entry) ─────────►
 *                   ▲ lands inside the drain's read→write window,
 *                     so the drain's merge never saw it and overwrites it
 * ```
 *
 * The drain snapshots state, decides, then writes. Any write that lands in between is computed
 * against a stale snapshot and silently reverted. Concretely: viewing a pix writes a `viewedAt`
 * receipt and sends it to the peer; if an incoming drain overlaps, the local row reverts to the
 * peer's version — so the sender sees "viewed" and the recipient sees "unviewed", permanently, with
 * no error anywhere.
 *
 * That overlap is ordinary rather than exotic: `store.ts` fires a drain per incoming message and on
 * three lifecycle triggers, while `StoriesScreen` writes its receipt on screen exit.
 *
 * ## Why a mutex and not something cleverer
 *
 * Per-entry locking, optimistic retry, or a compare-and-set `entryPut` would all work and all cost
 * more — a new bridge method, or a retry loop with its own failure modes. This is a phone app with
 * one user: the writes are small, infrequent, and already awaiting the bridge. Serialising them
 * costs nothing measurable and removes the whole class of interleaving.
 *
 * If this ever becomes a bottleneck, the honest fix is a compare-and-set at the store, not a finer
 * lock here.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `work` after every previously-enqueued piece of work has settled.
 *
 * A rejection propagates to the caller but does **not** poison the queue — the chain continues from
 * a resolved promise, so one failed write cannot wedge every write after it.
 */
export function withEntryLock<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  // `catch` keeps the chain alive; the caller still sees the original rejection through `result`.
  tail = result.catch(() => undefined);
  return result;
}

/** Test-only: wait for the queue to be empty. */
export async function entryLockIdle(): Promise<void> {
  await tail;
}
