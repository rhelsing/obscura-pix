/**
 * The app's model semantics — the single source of truth for what a model *means*, and the
 * accessors that answer it.
 *
 * Read by the APP, not by the kit: `drainInbox` takes each model's `merge` rule plus its
 * authorization rules, and `writeEntry` takes its `audience`. The kit
 * does not parse application schemas (NATIVE_CONTRACT §0.4).
 *
 * ## Identity is never a payload field
 *
 * There is deliberately no `senderUsername` / `authorUsername` / `recipientUsername` here. A
 * payload-supplied name is attacker-chosen (NATIVE_CONTRACT §0.5, §0.10 rule 5).
 * Attribution comes from the **authenticated** envelope, stamped into
 * `_authorUserId` by the drain or `writeEntry`; display names are resolved from
 * the friend graph at render time.
 *
 * `fields` is documentation now — nothing parses it — but `_authorUserId` is listed on every model
 * because it is the field the screens key on.
 */

import { DirectRoutingUnresolved, type AudienceConfig } from '../domain/audience';
import type { ModelRules } from '../domain/drain';
import type { MergeRule } from '../domain/merge';

/** App-owned metadata on every stored entry: the authenticated userId of whoever created it. */
export const AUTHOR_USER_ID = '_authorUserId';

/**
 * A `profile` entry's id is derived from its owner, which is what makes the entry authorizable:
 * only `<userId>` may write `profile_<userId>` (see `drain.ts`). Kept here so the one place that
 * mints the id and the one place that checks it cannot drift.
 */
export const PROFILE_ID_PREFIX = 'profile_';
export function profileEntryId(userId: string): string {
  return PROFILE_ID_PREFIX + userId;
}

/** What one model declares. */
export interface ModelDeclaration {
  /**
   * Documentation only: nothing parses this and no payload is validated against it. It records what
   * a model carries for a human reading the schema, which is why the values are prose (`'string?'`)
   * rather than a type vocabulary something could enforce.
   */
  fields: Record<string, string>;
  /** How two writes to one entry id reconcile (`domain/merge.ts`). */
  merge: MergeRule;
  /** Who an entry reaches. Omitted means every accepted friend (`domain/audience.ts`). */
  audience?: AudienceConfig;
  /** An entry-id prefix binding an entry to its owner: only `<userId>` may write `<prefix><userId>`. */
  ownerIdPrefix?: string;
}

/** Every model the app declares, by model key. */
export type ModelSchema = Record<string, ModelDeclaration>;

/**
 * `satisfies`, not `:`. The annotation has to CHECK the declarations without erasing the literal
 * key types that `Object.keys(obscuraSchema)` and the screens' model names rely on.
 *
 * Checking is the point: while these values were untyped, a typo'd merge rule passed both typecheck
 * and the whole test suite while silently flipping a model from APPEND to REPLACE.
 */
export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string', _authorUserId: 'string' },
    merge: 'APPEND',
    // 1:1 — deliver to both conversation participants; never broadcast.
    audience: { kind: 'conversation', field: 'conversationId' },
  },
  story: {
    fields: {
      content: 'string',
      _authorUserId: 'string',
      // Attachment fields — present iff the story has a photo (text-only stories
      // omit all three). Same shape as pix so a single viewer can render both.
      mediaRef: 'string?',
      contentKey: 'string?',
      nonce: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
    },
    merge: 'APPEND',
    // Stories are permanent until the app implements `expiresAt` storage and
    // filtering (KIT_API §8.3).
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?', _authorUserId: 'string' },
    merge: 'REPLACE',
    // The id binds the entry to its owner: only `<userId>` may write
    // `profile_<userId>`.
    ownerIdPrefix: PROFILE_ID_PREFIX,
  },
  pix: {
    fields: {
      // Canonical sorted "userIdA_userIdB" — targets both parties so the
      // viewed-receipt (Bob → Alice) resolves in either direction.
      conversationId: 'string',
      _authorUserId: 'string',
      mediaRef: 'string',
      contentKey: 'string',
      nonce: 'string',
      caption: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
      displayDuration: 'number',
      viewedAt: 'number?',
    },
    merge: 'REPLACE',
    // 1:1 — deliver to both conversation participants so the viewed-receipt
    // (recipient → sender) resolves in either direction; never broadcast.
    audience: { kind: 'conversation', field: 'conversationId' },
  },
} satisfies ModelSchema;

/**
 * The same declarations, widened so they can be looked up by a model name that is only known at
 * runtime. `obscuraSchema` itself keeps its literal keys and cannot be indexed by a `string`.
 */
const declarations: ModelSchema = obscuraSchema;

/**
 * The audience a model declares.
 *
 * **Throws on a model the schema does not declare**, and that is the point. Before this check, a
 * lookup miss and a deliberate "no audience declared" were indistinguishable — both produced
 * `undefined`, which `resolveAudience` treats as *broadcast to every friend*. So a single-character
 * typo in a model name turned a 1:1 message into a broadcast, silently. An unknown model is a bug in
 * the app, and a bug must not fail open into a wider audience.
 */
export function audienceFor(model: string): AudienceConfig | undefined {
  if (!Object.prototype.hasOwnProperty.call(obscuraSchema, model)) {
    throw new DirectRoutingUnresolved(
      `'${model}' is not declared in schema.ts, so its audience is unknown`,
    );
  }
  return declarations[model].audience;
}

/**
 * What the drain needs per model: the merge rule and the authorization rules.
 *
 * The authorization rules are derived from the same declarations the *send* side uses, so the two
 * directions cannot disagree: a model whose audience is a conversation is exactly a model whose
 * inbound entries must name a conversation between this user and the sender.
 */
export function modelRules(): Map<string, ModelRules> {
  const rules = new Map<string, ModelRules>();
  for (const [model, config] of Object.entries(declarations)) {
    rules.set(model, {
      merge: config.merge,
      conversationField: config.audience?.kind === 'conversation' ? config.audience.field : undefined,
      ownerIdPrefix: config.ownerIdPrefix,
    });
  }
  return rules;
}
