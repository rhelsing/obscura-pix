import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Friend, ModelEntry } from '../native/ObscuraModule';
import type { RootStackParamList, StoryGroup } from './types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * Open the shared StoryViewer on a set of view-once pix from a single sender.
 *
 * Entries are shown oldest-first so the viewer opens on the first unopened pix
 * and taps forward to the newest. `markViewed` fires a `viewedAt` receipt per
 * pix as the viewer advances, and (in the viewer) disables backward tap-nav so
 * a consumed pix can't be re-viewed.
 *
 * `sender` is passed in rather than read off `entries[0].data.senderUsername`, which is a name the
 * peer who sent the pix chose (SPEC §0.5). Both call sites already hold the `Friend` whose
 * conversation they are showing — an authenticated identity out of the kit's friend graph — so the
 * name comes from there.
 */
export function openPixViewer(nav: Nav, sender: Friend, entries: ModelEntry[]) {
  if (entries.length === 0) return;
  const stories = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const group: StoryGroup = {
    userId: sender.userId,
    username: sender.username,
    stories,
    isMe: false,
  };
  nav.navigate('StoryViewer', { groups: [group], startIndex: 0, markViewed: true });
}
