import React, { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, conversationId } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { toast } from '../components/Toast';
import { CheckIcon } from '../components/icons';
import { useSession } from '../state/store';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

export function RecipientPicker({ route }: RootStackScreenProps<'RecipientPicker'>) {
  const { photo, mediaType = 'photo', caption, captionMeta, displayDuration } = route.params;
  const isVideo = mediaType === 'video';
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { friends, myUsername, myUserId } = useSession();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeStory, setIncludeStory] = useState(false);
  const [sending, setSending] = useState(false);

  const toggle = (userId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const send = async () => {
    const recipients = friends.filter(f => selected.has(f.userId));
    if (recipients.length === 0 && !includeStory) return;
    setSending(true);

    const originalPath = photo.path;
    let resizedPath: string | null = null;
    try {
      // Photos resize natively (bytes never round-trip through JS). Video is
      // uploaded as-is — resizeImage is image-only, and uploadAttachment is
      // byte-opaque so the mp4 rides through unchanged.
      const resized = isVideo
        ? null
        : await Obscura.resizeImage(originalPath, 1080, 80)
            .catch((e) => { logError('resize', e); return null; });
      const uploadPath = resized?.path ?? originalPath;
      if (resized) resizedPath = resized.path;

      const attachment = await Obscura.uploadAttachment(uploadPath);

      // Create Pix entry for each recipient.
      for (const friend of recipients) {
        await Obscura.createEntry('pix', {
          conversationId: conversationId(myUserId, friend.userId),
          recipientUsername: friend.username,
          senderUsername: myUsername,
          mediaRef: attachment.id,
          contentKey: attachment.contentKey,
          nonce: attachment.nonce,
          mediaType,
          caption,
          ...(captionMeta ? { captionMeta } : {}),
          displayDuration,
        });
      }

      // Post to story if selected — same shape as pix.
      if (includeStory) {
        await Obscura.createEntry('story', {
          content: caption || '',
          authorUsername: myUsername,
          mediaRef: attachment.id,
          contentKey: attachment.contentKey,
          nonce: attachment.nonce,
          mediaType,
          ...(captionMeta ? { captionMeta } : {}),
        });
      }

      // Only clean up on success. On failure we leave the temp files in
      // place so the user can retry without re-shooting the photo — the
      // back button + PhotoPreview retake flow will clean up if abandoned.
      Obscura.deleteFile(originalPath).catch((e) => logError('cleanup.original', e));
      if (resizedPath && resizedPath !== originalPath) {
        Obscura.deleteFile(resizedPath).catch((e) => logError('cleanup.resized', e));
      }

      // Pop the whole capture flow (PhotoPreview + RecipientPicker) off the
      // stack so it can't be swiped/back-navigated into after sending.
      nav.popToTop();
      toast.success(
        `Sent to ${recipients.length} friend${recipients.length !== 1 ? 's' : ''}${includeStory ? ' + story' : ''}`,
      );
    } catch (e: any) {
      toast.error(e.message ?? String(e));
      setSending(false);
    }
  };

  const count = selected.size + (includeStory ? 1 : 0);

  return (
    <View style={rp.container}>
      <View style={rp.header}>
        <TouchableOpacity onPress={() => nav.goBack()} disabled={sending}>
          <Text style={rp.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={rp.title}>Send to</Text>
        <View style={{ width: 50 }} />
      </View>

      {/* Story option */}
      <TouchableOpacity style={rp.row} onPress={() => setIncludeStory(!includeStory)} disabled={sending}>
        <View style={[rp.check, includeStory && rp.checkActive]}>
          {includeStory && <CheckIcon size={15} color={colors.onAccent} />}
        </View>
        <Text style={rp.rowText}>My story</Text>
        <Text style={rp.rowHint}>Visible to all friends</Text>
      </TouchableOpacity>

      <Text style={rp.sectionTitle}>friends</Text>

      <FlatList
        data={friends}
        keyExtractor={f => f.userId}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.userId);
          return (
            <TouchableOpacity style={rp.row} onPress={() => toggle(item.userId)} disabled={sending}>
              <View style={[rp.check, isSelected && rp.checkActive]}>
                {isSelected && <CheckIcon size={15} color={colors.onAccent} />}
              </View>
              <View style={rp.avatar}>
                <Text style={rp.avatarText}>{item.username[0]?.toUpperCase()}</Text>
              </View>
              <Text style={rp.rowText}>{item.username}</Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<Text style={rp.empty}>No friends yet</Text>}
      />

      <TouchableOpacity
        style={[rp.sendBtn, (count === 0 || sending) && rp.sendBtnDisabled]}
        onPress={send}
        disabled={count === 0 || sending}
      >
        <Text style={rp.sendBtnText}>
          {sending ? 'Sending…' : count === 0 ? 'Select recipients' : `Send to ${count}`}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const rp = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 48 },
  cancelText: { color: colors.accent, fontSize: 16 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  sectionTitle: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginLeft: 16, marginTop: 16, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.textMuted, justifyContent: 'center', alignItems: 'center' },
  checkActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceMuted, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  rowText: { color: '#fff', fontSize: 16, flex: 1 },
  rowHint: { color: colors.textDim, fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center', margin: 16, marginBottom: 40 },
  sendBtnDisabled: { backgroundColor: colors.surfaceMuted },
  sendBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
});
