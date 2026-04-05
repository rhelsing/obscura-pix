import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Modal, StyleSheet,
  Dimensions, Animated, Image, Alert, ActivityIndicator,
} from 'react-native';
import { Obscura, type ModelEntry } from '../native/ObscuraModule';
import { ObscuraEvents } from '../events';
import { colors } from '../styles';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const STORY_DURATION = 5000; // 5 seconds per story

interface StoryGroup {
  username: string;
  stories: ModelEntry[];
  isMe: boolean;
}

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

// ─── Story Viewer (full-screen, auto-advance) ─────────────

function StoryViewer({ groups, startIndex, onClose }: {
  groups: StoryGroup[];
  startIndex: number;
  onClose: () => void;
}) {
  const [groupIdx, setGroupIdx] = useState(startIndex);
  const [storyIdx, setStoryIdx] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const group = groups[groupIdx];
  const story = group?.stories[storyIdx];

  const advance = useCallback(() => {
    if (!group) { onClose(); return; }
    if (storyIdx < group.stories.length - 1) {
      setStoryIdx(i => i + 1);
    } else if (groupIdx < groups.length - 1) {
      setGroupIdx(i => i + 1);
      setStoryIdx(0);
    } else {
      onClose();
    }
  }, [group, groupIdx, storyIdx, groups.length, onClose]);

  const goBack = useCallback(() => {
    if (storyIdx > 0) {
      setStoryIdx(i => i - 1);
    } else if (groupIdx > 0) {
      setGroupIdx(i => i - 1);
      setStoryIdx(0);
    }
  }, [storyIdx, groupIdx]);

  // Auto-advance timer
  useEffect(() => {
    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue: 1, duration: STORY_DURATION, useNativeDriver: false,
    });
    anim.start();
    timerRef.current = setTimeout(advance, STORY_DURATION);
    return () => {
      anim.stop();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [groupIdx, storyIdx]);

  if (!story) { onClose(); return null; }

  // Load media if story has an attachment
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);

  useEffect(() => {
    setMediaUri(null);
    // Resolve attachment — supports both story format (mediaUrl JSON) and pix format (separate fields)
    let attachmentId: string | undefined;
    let contentKey: string | undefined;
    let nonce: string | undefined;
    if (story.data.mediaUrl) {
      try {
        const ref = JSON.parse(story.data.mediaUrl);
        attachmentId = ref.attachmentId; contentKey = ref.contentKey; nonce = ref.nonce;
      } catch {}
    } else if (story.data.mediaRef) {
      attachmentId = story.data.mediaRef; contentKey = story.data.contentKey; nonce = story.data.nonce;
    }
    if (!attachmentId || !contentKey || !nonce) return;
    let cancelled = false;
    (async () => {
      try {
        setMediaLoading(true);
        const base64 = await Obscura.downloadAttachment(attachmentId!, contentKey!, nonce!);
        if (!cancelled) setMediaUri(`data:image/jpeg;base64,${base64}`);
      } catch (e) {
        console.warn('Media load failed:', e);
      } finally {
        if (!cancelled) setMediaLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [story.id]);

  const timeAgo = (() => {
    const mins = Math.floor((Date.now() - story.timestamp) / 60000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  })();

  return (
    <View style={sv.container}>
      {/* Background image (if media) */}
      {mediaUri && (
        <Image source={{ uri: mediaUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      )}

      {/* Progress bars */}
      <View style={sv.progressRow}>
        {group.stories.map((_, i) => (
          <View key={i} style={sv.progressTrack}>
            <Animated.View style={[
              sv.progressFill,
              i < storyIdx ? { flex: 1 } :
              i === storyIdx ? { flex: 0, width: progress.interpolate({
                inputRange: [0, 1], outputRange: ['0%', '100%'],
              }) } : { flex: 0 },
            ]} />
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
        <TouchableOpacity onPress={onClose} style={sv.closeBtn}>
          <Text style={sv.closeBtnText}>X</Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      <View style={sv.content}>
        {mediaLoading && <ActivityIndicator color="#fff" size="large" />}
        {story.data.content && !mediaUri ? (
          <Text style={sv.contentText}>{story.data.content}</Text>
        ) : null}
        {story.data.content && mediaUri ? (
          <Text style={sv.captionOverlay}>{story.data.content}</Text>
        ) : null}
      </View>

      {/* Tap zones: left = back, right = next */}
      <View style={sv.tapZones}>
        <TouchableOpacity style={sv.tapLeft} onPress={goBack} activeOpacity={1} />
        <TouchableOpacity style={sv.tapRight} onPress={advance} activeOpacity={1} />
      </View>
    </View>
  );
}

// ─── Stories Screen ──────────────────────────────────────

export function StoriesScreen({ myUsername }: { myUsername: string }) {
  const [stories, setStories] = useState<ModelEntry[]>([]);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerStartIdx, setViewerStartIdx] = useState(0);

  const load = useCallback(() => {
    Obscura.allEntries('story').then(s =>
      setStories([...s].sort((a, b) => b.timestamp - a.timestamp))
    );
  }, []);

  useEffect(() => {
    load();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') load();
    });
    return () => sub.remove();
  }, [load]);

  // Group stories by author, me first
  const groups: StoryGroup[] = (() => {
    const map = new Map<string, ModelEntry[]>();
    for (const s of stories) {
      const author = s.data.authorUsername || 'unknown';
      if (!map.has(author)) map.set(author, []);
      map.get(author)!.push(s);
    }
    const result: StoryGroup[] = [];
    // Me first (even if no stories — shows the "+" add button)
    const myStories = map.get(myUsername) || [];
    result.push({ username: myUsername, stories: myStories, isMe: true });
    map.delete(myUsername);
    // Then friends
    for (const [username, entries] of map) {
      result.push({ username, stories: entries, isMe: false });
    }
    return result;
  })();

  const openViewer = (idx: number) => {
    const group = groups[idx];
    if (group.isMe && group.stories.length === 0) {
      // No stories yet — could open camera, for now show hint
      Alert.alert('My Story', 'Take a photo and select "my story" to post');
      return;
    }
    if (group.stories.length === 0) return;
    setViewerStartIdx(idx);
    setViewerOpen(true);
  };

  return (
    <View style={ss.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={ss.circleRow}
        contentContainerStyle={ss.circleRowContent}>
        {groups.map((g, i) => (
          <StoryCircle key={g.username} group={g} onPress={() => openViewer(i)} />
        ))}
      </ScrollView>

      <Modal visible={viewerOpen} animationType="fade" statusBarTranslucent>
        <StoryViewer
          groups={groups.filter(g => g.stories.length > 0)}
          startIndex={Math.min(viewerStartIdx, groups.filter(g => g.stories.length > 0).length - 1)}
          onClose={() => setViewerOpen(false)}
        />
      </Modal>
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
  tapZones: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', top: 100 },
  tapLeft: { flex: 1 },
  tapRight: { flex: 2 },
});

const ss = StyleSheet.create({
  container: {},
  circleRow: { paddingTop: 8, paddingBottom: 8 },
  circleRowContent: { paddingHorizontal: 16 },
  empty: { color: '#444', textAlign: 'center', marginTop: 48, fontSize: 14 },
});
