import React, { useState } from 'react';
import { SafeAreaView, View, Text, TextInput, TouchableOpacity, Image } from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { obscuraSchema } from '../models/schema';
import { s } from '../styles';

export function AuthScreen({ onAuth }: { onAuth: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');

  const register = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Registering...');
    try {
      await Obscura.register(username, password);
      await Obscura.defineModels(obscuraSchema);
      await Obscura.connect();
      onAuth();
    } catch (e: any) { setStatus(e.message || 'Registration failed'); }
  };

  const login = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Logging in...');
    try {
      const scenario = await Obscura.loginSmart(username, password);
      switch (scenario) {
        case 'existingDevice': case 'onlyDevice':
          await Obscura.defineModels(obscuraSchema);
          await Obscura.connect();
          onAuth();
          break;
        case 'newDevice':
          await Obscura.loginAndProvision(username, password);
          await Obscura.defineModels(obscuraSchema);
          await Obscura.connect();
          onAuth();
          break;
        case 'invalidCredentials': setStatus('Wrong password'); break;
        case 'userNotFound': setStatus('User not found'); break;
        default: setStatus(`Login: ${scenario}`);
      }
    } catch (e: any) { setStatus(e.message || 'Login failed'); }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.authBox}>
        <Image source={require('../assets/logo.png')} style={s.logoImg} resizeMode="contain" />
        <Text style={s.subtitle}>encrypted everything</Text>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <TextInput style={s.input} placeholder="username" placeholderTextColor="#666"
          value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
        <TextInput style={s.input} placeholder="password (12+ chars)" placeholderTextColor="#666"
          value={password} onChangeText={setPassword} secureTextEntry />
        <View style={s.authButtons}>
          <TouchableOpacity style={s.primaryBtn} onPress={register}>
            <Text style={s.primaryBtnText}>sign up</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.secondaryBtn} onPress={login}>
            <Text style={s.secondaryBtnText}>log in</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}
