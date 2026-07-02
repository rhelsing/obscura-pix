import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  KeyboardAvoidingView, Platform,
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
  connected: { color: colors.connected, label: 'connected' },
  connecting: { color: colors.connecting, label: 'connecting…' },
  disconnected: { color: colors.disconnected, label: 'disconnected' },
};

export function ProfileScreen() {
  const { myUserId, myUsername, myDeviceId, connState, logout } = useSession();
  const profiles = useModelEntries('profile');
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  // Keep the display-name field in sync if myUsername arrives after mount.
  useEffect(() => { if (myUsername && !displayName) setDisplayName(myUsername); }, [myUsername, displayName]);

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
        <TextInput style={s.input} placeholder="display name" placeholderTextColor="#666"
          value={displayName} onChangeText={setDisplayName} />
        <TextInput style={s.input} placeholder="bio" placeholderTextColor="#666"
          value={bio} onChangeText={setBio} />
        <TouchableOpacity style={s.smallBtn} onPress={save}>
          <Text style={s.smallBtnText}>save</Text>
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
          <Text style={s.codeBtnText}>{showLog ? 'hide debug log' : 'show debug log'}</Text>
        </TouchableOpacity>

        {showLog && debugLog.length > 0 && (
          <View style={{ marginTop: 8 }}>
            {debugLog.slice().reverse().map((line, i) => (
              <Text key={i} style={s.logLine}>{line}</Text>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={[s.primaryBtn, { backgroundColor: '#333', marginTop: 24, marginBottom: 32 }]}
          onPress={logout}
        >
          <Text style={s.primaryBtnText}>log out</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
