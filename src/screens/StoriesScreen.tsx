import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, Image, ActivityIndicator, useWindowDimensions,
} from 'react-native';
import Video from 'react-native-video';
import { CaptionView, parseCaptionMeta } from '../components/Caption';
import { toast } from '../components/Toast';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, type ModelEntry } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { useSession, useModelEntries } from '../state/store';
import type { RootStackParamList, RootStackScreenProps, StoryGroup } from '../navigation/types';
import { colors } from '../styles';

const STORY_DURATION = 5000; // 5 seconds per story

// ─── Story Circle (avatar with ring) ──────────────────────

function StoryCircle({ group, onPress }: { group: StoryGroup; onPress: () => void }) {
  return (
    <TouchableOpacity style={sc.container} onPress={onPress}>
      <View style={[sc.ring, group.isMe && group.stories.length === 0 && sc.ringEmpty]}>
        <View style={sc.avatar}>
          <Text style={sc.avatarText}>{group.username[0]?.toUpperCase()}</Text>
        </View>
      </View>
      {group.isMe && group.stories.length === 0 && (
        <View style={sc.addBadge}><Text style={sc.addBadgeText}>+</Text></View>
      )}
      <Text style={sc.username} numberOfLines={1}>
        {group.isMe ? 'my story' : group.username}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Story Viewer (full-screen, route-driven) ─────────────

export function StoryViewer({ route, navigation }: RootStackScreenProps<'StoryViewer'>) {
  const { groups, startIndex, markViewed } = route.params;
  const [groupIdx, setGroupIdx] = useState(startIndex);
  const [storyIdx, setStoryIdx] = useState(0);
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const { width: W, height: H } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const group = groups[groupIdx];
  const story = group?.stories[storyIdx];

  // Dedup `viewedAt` upserts so multiple exit paths don't double-fire for
  // the same entry.
  const viewedIdsRef = useRef<Set<string>>(new Set());

  // If `markViewed` was requested, fire a viewedAt upsert on the currently
  // displayed pix. LWW merges so the sender gets the receipt. The
  // `entriesChanged` event then re-renders other screens reactively.
  const markCurrentViewed = useCallback(() => {
    if (!markViewed || !story) return;
    if (viewedIdsRef.current.has(story.id)) return;
    viewedIdsRef.current.add(story.id);
    Obscura.upsertEntry('pix', story.id, {
      ...story.data,
      viewedAt: Date.now(),
    }).catch((e) => logError('viewonce.upsert:' + story.id, e));
  }, [markViewed, story]);

  // Catch ALL exit paths uniformly (header back, hardware back, iOS
  // swipe-back, close button). Without this, hardware/swipe back would skip
  // the viewedAt receipt entirely.
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', markCurrentViewed);
    return sub;
  }, [navigation, markCurrentViewed]);

  const close = useCallback(() => {
    markCurrentViewed();
    navigation.goBack();
  }, [markCurrentViewed, navigation]);

  const advance = useCallback(() => {
    if (!group) { navigation.goBack(); return; }
    markCurrentViewed();
    if (storyIdx < group.stories.length - 1) {
      setStoryIdx(i => i + 1);
    } else if (groupIdx < groups.length - 1) {
      setGroupIdx(i => i + 1);
      setStoryIdx(0);
    } else {
      navigation.goBack();
    }
  }, [group, groupIdx, storyIdx, groups.length, markCurrentViewed, navigation]);

  const goBack = useCallback(() => {
    if (storyIdx > 0) {
      setStoryIdx(i => i - 1);
    } else if (groupIdx > 0) {
      setGroupIdx(i => i - 1);
      setStoryIdx(0);
    }
  }, [storyIdx, groupIdx]);

  // Resolve the attachment ref into a stable object so the load effect's
  // dep array is honest. Without this, the effect either drops deps and
  // gets a stale closure warning, or includes them and re-fires whenever
  // React re-renders for any reason (sets up new fetches on every paint).
  const attachment = useMemo(() => {
    const mediaRef = story?.data.mediaRef as string | undefined;
    const contentKey = story?.data.contentKey as string | undefined;
    const nonce = story?.data.nonce as string | undefined;
    if (!mediaRef || !contentKey || !nonce) return null;
    return { mediaRef, contentKey, nonce };
  }, [story?.data.mediaRef, story?.data.contentKey, story?.data.nonce]);

  // Load media if the entry has an attachment — native decrypts to a cached
  // file and returns the path, which we use as a `file://` URI. No base64
  // payload in JS, no `data:` URI in Image. Story and pix share the shape.
  useEffect(() => {
    setMediaUri(null);
    if (!attachment) return;
    let cancelled = false;
    (async () => {
      try {
        setMediaLoading(true);
        const path = await Obscura.downloadAttachment(attachment.mediaRef, attachment.contentKey, attachment.nonce);
        if (!cancelled) setMediaUri(`file://${path}`);
      } catch (e) {
        console.warn('Media load failed:', e);
      } finally {
        if (!cancelled) setMediaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [attachment]);

  // Auto-advance timer — waits for media to load before starting.
  // (Declared AFTER mediaLoading/mediaUri so the closure sees real state.)
  const hasMedia = !!story?.data.mediaRef;
  const readyToPlay = !hasMedia || !mediaLoading;

  // Keep advance current in a ref so the timer effect doesn't re-fire every
  // time advance's identity changes (which is every story transition — would
  // double-schedule the timer).
  const advanceRef = useRef(advance);
  useEffect(() => { advanceRef.current = advance; }, [advance]);

  const displayDurationMs = story?.data.displayDuration
    ? Number(story.data.displayDuration) * 1000
    : STORY_DURATION;
  const isVideo = story?.data.mediaType === 'video';

  useEffect(() => {
    if (!readyToPlay) { progress.setValue(0); return; }
    // Video drives its own advance via onEnd (plays to its natural length),
    // so skip the fixed photo timer for it.
    if (isVideo) { progress.setValue(0); return; }
    const dur = displayDurationMs > 0 ? displayDurationMs : STORY_DURATION;
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1, duration: dur, useNativeDriver: false,
    });
    anim.start();
    timerRef.current = setTimeout(() => advanceRef.current(), dur);
    return () => {
      anim.stop();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [groupIdx, storyIdx, readyToPlay, displayDurationMs, progress, isVideo]);

  if (!story) { navigation.goBack(); return null; }

  const timeAgo = (() => {
    const mins = Math.floor((Date.now() - story.timestamp) / 60000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  })();

  return (
    <View style={sv.container}>
      {/* Background media (if any) */}
      {mediaUri && (isVideo ? (
        <Video
          source={{ uri: mediaUri, type: 'mp4' }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          paused={!readyToPlay}
          onEnd={() => advanceRef.current()}
          onError={(e) => logError('storyVideo', e)}
        />
      ) : (
        <Image source={{ uri: mediaUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ))}

      {/* Progress bars — only the currently-playing segment is Animated.
          Past/future segments are plain Views with explicit widths because
          React Native won't reset a previously-applied animated `width`
          when you switch to a style object that omits the property. */}
      <View style={sv.progressRow}>
        {group.stories.map((_, i) => (
          <View key={i} style={sv.progressTrack}>
            {i < storyIdx ? (
              <View style={[sv.progressFill, sv.progressFillFull]} />
            ) : i === storyIdx ? (
              <Animated.View style={[
                sv.progressFill,
                { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
              ]} />
            ) : null}
          </View>
        ))}
      </View>

      {/* Header */}
      <View style={sv.header}>
        <View style={sv.headerAvatar}>
          <Text style={sv.headerAvatarText}>{group.username[0]?.toUpperCase()}</Text>
        </View>
        <Text style={sv.headerName}>{group.username}</Text>
        <Text style={sv.headerTime}>{timeAgo}</Text>
        <TouchableOpacity onPress={close} style={sv.closeBtn}>
          <Text style={sv.closeBtnText}>X</Text>
        </TouchableOpacity>
      </View>

      {/* Text-only content (no media) — centered */}
      <View style={sv.content}>
        {mediaLoading && <ActivityIndicator color="#fff" size="large" />}
        {(() => {
          const text = story.data.content || story.data.caption || '';
          if (!text || mediaUri) return null; // captions over media handled below
          return <Text style={sv.contentText}>{text}</Text>;
        })()}
      </View>

      {/* Styled caption over media — positioned/rotated from captionMeta.
          Falls back to the legacy bottom overlay for entries without meta. */}
      {mediaUri && (() => {
        const text = story.data.content || story.data.caption || '';
        if (!text) return null;
        const meta = parseCaptionMeta(story.data.captionMeta);
        if (meta) return <CaptionView meta={meta} text={text} width={W} height={H} />;
        return <Text style={sv.captionOverlay}>{text}</Text>;
      })()}

      {/* Tap zones: left = back, right = next */}
      <View style={sv.tapZones}>
        <TouchableOpacity style={sv.tapLeft} onPress={goBack} activeOpacity={1} />
        <TouchableOpacity style={sv.tapRight} onPress={advance} activeOpacity={1} />
      </View>
    </View>
  );
}

// ─── Stories Row (horizontal scroll, embedded in ChatList) ────────

export function StoriesRow() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUsername } = useSession();
  const stories = useModelEntries('story');

  // Group stories by author, me first. Within each group, oldest first so
  // the viewer plays the day's stories in chronological order (Snapchat
  // convention). Across groups, "me" is pinned to position 0; the rest are
  // sorted by their most recent story so freshly-posting friends bubble up.
  const groups: StoryGroup[] = useMemo(() => {
    const map = new Map<string, ModelEntry[]>();
    for (const s of stories) {
      const author = s.data.authorUsername || 'unknown';
      if (!map.has(author)) map.set(author, []);
      map.get(author)!.push(s);
    }
    for (const entries of map.values()) {
      entries.sort((a, b) => a.timestamp - b.timestamp); // oldest first within a group
    }
    const result: StoryGroup[] = [];
    const myStories = map.get(myUsername) || [];
    result.push({ username: myUsername, stories: myStories, isMe: true });
    map.delete(myUsername);
    const friendGroups = Array.from(map.entries()).map(([username, entries]) => ({
      username,
      stories: entries,
      isMe: false,
    }));
    // Sort friend groups by their newest story (latest activity bubbles up)
    friendGroups.sort((a, b) => {
      const aLatest = a.stories[a.stories.length - 1]?.timestamp ?? 0;
      const bLatest = b.stories[b.stories.length - 1]?.timestamp ?? 0;
      return bLatest - aLatest;
    });
    result.push(...friendGroups);
    return result;
  }, [stories, myUsername]);

  const openViewer = (idx: number) => {
    const group = groups[idx];
    if (group.isMe && group.stories.length === 0) {
      toast.info('Take a photo and select "my story" to post');
      return;
    }
    if (group.stories.length === 0) return;
    // Translate the index into the populated-only viewer list. `idx` is the
    // tapped circle's position in the original `groups` array (which always
    // has "me" at index 0, even when empty), so a naive Math.min(idx, ...)
    // off-by-ones the start when "me" is empty and ≥2 friends have stories.
    const populated = groups.filter(g => g.stories.length > 0);
    const startIndex = populated.indexOf(group);
    nav.navigate('StoryViewer', { groups: populated, startIndex });
  };

  return (
    <View style={ss.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={ss.circleRow}
        contentContainerStyle={ss.circleRowContent}>
        {groups.map((g, i) => (
          <StoryCircle key={g.username} group={g} onPress={() => openViewer(i)} />
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────

const sc = StyleSheet.create({
  container: { alignItems: 'center', marginRight: 16, width: 72 },
  ring: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  ringEmpty: { borderColor: '#333', borderStyle: 'dashed' },
  avatar: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 22 },
  addBadge: { position: 'absolute', right: 2, bottom: 14, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  addBadgeText: { color: '#000', fontWeight: '700', fontSize: 14, marginTop: -1 },
  username: { color: '#ccc', fontSize: 11, marginTop: 4, textAlign: 'center' },
});

const sv = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  progressRow: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 48, gap: 4 },
  progressTrack: { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#fff', borderRadius: 1 },
  progressFillFull: { width: '100%' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 },
  headerAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  headerAvatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  headerName: { color: '#fff', fontWeight: '600', fontSize: 15, flex: 1 },
  headerTime: { color: '#999', fontSize: 13 },
  closeBtn: { padding: 8 },
  closeBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  contentText: { color: '#fff', fontSize: 24, fontWeight: '600', textAlign: 'center' },
  captionOverlay: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 12, position: 'absolute', bottom: 80 },
  tapZones: { ...StyleSheet.absoluteFill, flexDirection: 'row', top: 100 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 2 },
});

const ss = StyleSheet.create({
  container: {},
  circleRow: { paddingTop: 8, paddingBottom: 8 },
  circleRowContent: { paddingHorizontal: 16 },
});
