import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { useSession, useModelEntries } from '../state/store';
import { s } from '../styles';

export function ProfileScreen() {
  const { myUserId, myUsername, myDeviceId } = useSession();
  const profiles = useModelEntries('profile');
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');

  // Keep the display-name field in sync if myUsername arrives after mount.
  useEffect(() => { if (myUsername && !displayName) setDisplayName(myUsername); }, [myUsername, displayName]);

  const save = async () => {
    try {
      await Obscura.upsertEntry('profile', `profile_${myUserId}`, { displayName, bio });
      Alert.alert('Saved', 'Profile updated');
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  // Filter on deviceId — `authorDeviceId` is the kit's per-device id, not
  // the per-user id. Comparing it to `myUserId` (different namespace!) used
  // to mean every entry passed the filter and your own profile showed up
  // under "friend profiles".
  const friendProfiles = profiles.filter(p => p.authorDeviceId !== myDeviceId);

  return (
    <ScrollView style={s.screen}>
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
    </ScrollView>
  );
}
