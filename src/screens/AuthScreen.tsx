import React, { useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, Image } from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { useSession } from '../state/store';
import { KeyboardScreen } from '../components/KeyboardScreen';
import { s } from '../styles';

export function AuthScreen() {
  const { setAuthed } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');

  const register = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Registering...');
    try {
      await Obscura.register(username, password);
      await Obscura.connect();
      setAuthed(true);
    } catch (e: any) { setStatus(e.message || 'Registration failed'); }
  };

  const login = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Logging in...');
    try {
      const scenario = await Obscura.loginSmart(username, password);
      switch (scenario) {
        case 'existingDevice':
          await Obscura.connect();
          setAuthed(true);
          break;
        case 'newDevice':
          await Obscura.loginAndProvision(username, password);
          await Obscura.connect();
          setAuthed(true);
          break;
        case 'invalidCredentials': setStatus('Wrong password'); break;
        case 'userNotFound': setStatus('User not found'); break;
        default: setStatus(`Login: ${scenario}`);
      }
    } catch (e: any) { setStatus(e.message || 'Login failed'); }
  };

  return (
    <SafeAreaView style={s.container}>
      <KeyboardScreen>
      <View style={s.authBox}>
        <Image source={require('../assets/logo.png')} style={s.logoImg} resizeMode="contain" />
        <Text style={s.subtitle}>Encrypted everything</Text>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <TextInput style={s.input} placeholder="Username" placeholderTextColor="#666"
          value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
        <TextInput style={s.input} placeholder="Password (12+ chars)" placeholderTextColor="#666"
          value={password} onChangeText={setPassword} secureTextEntry />
        <View style={s.authButtons}>
          <TouchableOpacity style={s.primaryBtn} onPress={login}>
            <Text style={s.primaryBtnText}>Log in</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.secondaryBtn} onPress={register}>
            <Text style={s.secondaryBtnText}>Sign up</Text>
          </TouchableOpacity>
        </View>
      </View>
      </KeyboardScreen>
    </SafeAreaView>
  );
}
