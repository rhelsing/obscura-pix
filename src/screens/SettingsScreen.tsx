import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { Obscura } from '../native/ObscuraModule';
import { s } from '../styles';

export function SettingsScreen({ myUsername, myUserId, onLogout }: {
  myUsername: string; myUserId: string; onLogout: () => void;
}) {
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (showLog) {
      Obscura.getDebugLog().then(setDebugLog);
      const interval = setInterval(() => Obscura.getDebugLog().then(setDebugLog), 2000);
      return () => clearInterval(interval);
    }
  }, [showLog]);

  return (
    <ScrollView style={s.screen}>
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
        style={[s.primaryBtn, { backgroundColor: '#333', marginTop: 24 }]}
        onPress={onLogout}
      >
        <Text style={s.primaryBtnText}>log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
