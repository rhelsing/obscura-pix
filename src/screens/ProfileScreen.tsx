import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { Obscura, onObscuraEvent, type ModelEntry } from '../native/ObscuraModule';
import { useSession } from '../state/SessionContext';
import { s } from '../styles';

export function ProfileScreen() {
  const { myUserId, myUsername } = useSession();
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [profiles, setProfiles] = useState<ModelEntry[]>([]);

  // Keep the display-name field in sync if myUsername arrives after mount.
  useEffect(() => { if (myUsername && !displayName) setDisplayName(myUsername); }, [myUsername, displayName]);

  useEffect(() => {
    Obscura.allEntries('profile').then(setProfiles);
    return onObscuraEvent((event) => {
      if ((event.type === 'messageReceived' || event.type === 'entriesChanged') && event.model === 'profile') {
        Obscura.allEntries('profile').then(setProfiles);
      }
    });
  }, []);

  const save = async () => {
    try {
      await Obscura.upsertEntry('profile', `profile_${myUserId}`, { displayName, bio });
      Alert.alert('Saved', 'Profile updated');
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const friendProfiles = profiles.filter(p => p.authorDeviceId !== myUserId);

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
