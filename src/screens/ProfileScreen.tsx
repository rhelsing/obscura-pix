import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { logError, getJsLog } from '../utils/log';
import { toast } from '../components/Toast';
import { useSession, useModelEntries } from '../state/store';
import { s, colors } from '../styles';
import type { ConnectionState } from '../native/ObscuraModule';

// connState → colored dot + label. Same mapping on iOS and Android since it
// reads the shared `connState` store value fed by the `connectionChanged`
// bridge event (both platforms emit it).
const CONN_META: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: colors.connected, label: 'Connected' },
  connecting: { color: colors.connecting, label: 'Connecting…' },
  reconnecting: { color: colors.connecting, label: 'Reconnecting…' },
  disconnected: { color: colors.disconnected, label: 'Disconnected' },
};

export function ProfileScreen() {
  const { myUserId, myUsername, myDeviceId, connState, logout } = useSession();
  const profiles = useModelEntries('profile');
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  // The user's own saved profile entry (id is device-independent, unlike
  // authorDeviceId which changes when a different device last wrote it).
  const ownProfile = profiles.find(p => p.id === `profile_${myUserId}`);

  // Hydrate the editable fields from the saved profile once it's available,
  // falling back to the username for a brand-new profile. `hydrated` stops it
  // re-running (so clearing a field doesn't refill it); `edited` guards the
  // async gap so we never clobber input the user typed before entries loaded.
  const hydrated = useRef(false);
  const edited = useRef(false);
  useEffect(() => {
    if (hydrated.current || edited.current) return;
    if (ownProfile) {
      setDisplayName((ownProfile.data.displayName as string) || myUsername || '');
      setBio((ownProfile.data.bio as string) || '');
      hydrated.current = true;
    } else if (myUsername) {
      // No saved profile yet — seed the name from the handle, but keep
      // listening in case a saved profile arrives after entries load.
      setDisplayName(myUsername);
    }
  }, [ownProfile, myUsername]);

  const onChangeDisplayName = (t: string) => { edited.current = true; setDisplayName(t); };
  const onChangeBio = (t: string) => { edited.current = true; setBio(t); };

  // Poll the debug log only while it's visible.
  useEffect(() => {
    if (showLog) {
      // Merge the native (kit) debug log with the JS-side log so swallowed
      // errors routed through logError() are visible on-device too.
      const refresh = () =>
        Obscura.getDebugLog()
          .then((native) => setDebugLog([...native, ...getJsLog()]))
          .catch((e) => logError('debugLog.fetch', e));
      refresh();
      const interval = setInterval(refresh, 2000);
      return () => clearInterval(interval);
    }
  }, [showLog]);

  const save = async () => {
    try {
      await Obscura.upsertEntry('profile', `profile_${myUserId}`, { displayName, bio });
      toast.success('Profile updated');
    } catch (e: any) { toast.error(e.message); }
  };

  const confirmLogout = () => {
    Alert.alert(
      'Log out?',
      'You’ll need your username and password to sign back in.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log out', style: 'destructive', onPress: () => { logout(); } },
      ],
    );
  };

  // Filter on deviceId — `authorDeviceId` is the kit's per-device id, not
  // the per-user id. Comparing it to `myUserId` (different namespace!) used
  // to mean every entry passed the filter and your own profile showed up
  // under "friend profiles".
  const friendProfiles = profiles.filter(p => p.authorDeviceId !== myDeviceId);

  const conn = CONN_META[connState] ?? CONN_META.disconnected;

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={s.screen} keyboardShouldPersistTaps="handled">
        <Text style={s.sectionTitle}>edit profile</Text>
        <TextInput style={s.input} placeholder="Display name" placeholderTextColor="#666"
          value={displayName} onChangeText={onChangeDisplayName} />
        <TextInput style={s.input} placeholder="Bio" placeholderTextColor="#666"
          value={bio} onChangeText={onChangeBio} />
        <TouchableOpacity style={s.smallBtn} onPress={save}>
          <Text style={s.smallBtnText}>Save</Text>
        </TouchableOpacity>

        {friendProfiles.length > 0 && (<>
          <Text style={s.sectionTitle}>friend profiles</Text>
          {friendProfiles.map(p => (
            <View key={p.id} style={s.storyCard}>
              <Text style={s.storyAuthor}>{p.data.displayName}</Text>
              {p.data.bio ? <Text style={s.storyContent}>{p.data.bio}</Text> : null}
            </View>
          ))}
        </>)}

        <Text style={s.sectionTitle}>status</Text>
        <View style={s.statusRow}>
          <Text style={[s.statusDot, { color: conn.color }]}>●</Text>
          <Text style={s.statusText}>{conn.label}</Text>
        </View>

        <Text style={s.sectionTitle}>account</Text>
        <Text style={s.settingsLabel}>{myUsername}</Text>
        <Text style={s.hint}>{myUserId.slice(0, 16)}...</Text>

        <TouchableOpacity style={[s.codeBtn, { marginTop: 16 }]} onPress={() => setShowLog(!showLog)}>
          <Text style={s.codeBtnText}>{showLog ? 'Hide debug log' : 'Show debug log'}</Text>
        </TouchableOpacity>

        {showLog && debugLog.length > 0 && (
          <View style={{ marginTop: 8 }}>
            {debugLog.slice().reverse().map((line, i) => (
              <Text key={i} style={s.logLine}>{line}</Text>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={s.dangerBtn}
          onPress={confirmLogout}
        >
          <Text style={s.dangerBtnText}>Log out</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
