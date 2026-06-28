import React, { useEffect } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useSession } from '../state/SessionContext';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { colors } from '../styles';

import { AuthScreen } from '../screens/AuthScreen';
import { CameraScreen } from '../screens/CameraScreen';
import { ChatListScreen } from '../screens/ChatListScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { PhotoPreviewScreen } from '../screens/PhotoPreviewScreen';
import { RecipientPicker } from '../screens/RecipientPicker';
import { StoryViewer } from '../screens/StoriesScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

import type { RootStackParamList, MainTabParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTab = createBottomTabNavigator<MainTabParamList>();

// ─── Tab Bar ─────────────────────────────────────────────

function TabBarLabel({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={[tabStyles.label, focused && tabStyles.labelActive]}>{label}</Text>;
}

function CameraTabIcon() {
  return (
    <View style={tabStyles.cameraIcon}>
      <Text style={tabStyles.cameraIconText}>O</Text>
    </View>
  );
}

// ─── Main Tabs ───────────────────────────────────────────

function MainTabs() {
  const { myUsername, connState } = useSession();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <MainTab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { color: colors.text, fontWeight: '700' },
        headerLeft: () => (
          <TouchableOpacity onPress={() => nav.navigate('Profile')} style={headerStyles.btn}>
            <View style={headerStyles.avatar}>
              <Text style={headerStyles.avatarText}>{myUsername[0]?.toUpperCase() || '?'}</Text>
            </View>
          </TouchableOpacity>
        ),
        headerRight: () => (
          <TouchableOpacity onPress={() => nav.navigate('Settings')} style={headerStyles.btn}>
            <Text style={[
              headerStyles.connDot,
              { color: connState === 'connected' ? colors.connected : colors.disconnected },
            ]}>...</Text>
          </TouchableOpacity>
        ),
        headerTitle: 'obscura',
        headerTitleAlign: 'center',
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        tabBarShowLabel: true,
      }}
      initialRouteName="Camera"
    >
      <MainTab.Screen
        name="Chats"
        component={ChatListScreen}
        options={{
          tabBarIcon: () => null,
          tabBarLabel: ({ focused }) => <TabBarLabel label="chat" focused={focused} />,
        }}
      />
      <MainTab.Screen
        name="Camera"
        component={CameraScreen}
        options={{
          tabBarLabel: () => null,
          tabBarIcon: () => <CameraTabIcon />,
        }}
      />
    </MainTab.Navigator>
  );
}

// ─── Root Navigator ──────────────────────────────────────

export function RootNavigator() {
  const { authed } = useSession();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Deep-link routing: cold-start pull AND warm-start event.
  // Both deliver { screen } and we hop to the matching tab.
  useEffect(() => {
    if (!authed) return;
    const route = (screen: string) => {
      if (screen === 'chat') nav.navigate('MainTabs', { screen: 'Chats' });
    };
    Obscura.getLaunchIntent().then(intent => {
      if (intent?.screen) route(intent.screen);
    }).catch(() => {});
    return onObscuraEvent((event) => {
      if (event.type === 'launchedFrom' && event.screen) route(event.screen);
    });
  }, [authed, nav]);

  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      {!authed ? (
        <RootStack.Screen name="Auth" component={AuthScreen} />
      ) : (
        <>
          <RootStack.Screen name="MainTabs" component={MainTabs} />
          <RootStack.Screen
            name="Chat"
            component={ChatScreen}
            options={({ route }) => ({
              headerShown: true,
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { color: colors.text, fontWeight: '700' },
              title: route.params.friend.username,
            })}
          />
          <RootStack.Screen
            name="PhotoPreview"
            component={PhotoPreviewScreen}
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
          />
          <RootStack.Screen
            name="RecipientPicker"
            component={RecipientPicker}
            options={{ presentation: 'fullScreenModal' }}
          />
          <RootStack.Screen
            name="StoryViewer"
            component={StoryViewer}
            options={{ presentation: 'fullScreenModal', animation: 'fade' }}
          />
          <RootStack.Screen
            name="Profile"
            component={ProfileScreen}
            options={{
              headerShown: true,
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { color: colors.text, fontWeight: '700' },
              title: 'profile',
            }}
          />
          <RootStack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{
              headerShown: true,
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { color: colors.text, fontWeight: '700' },
              title: 'settings',
            }}
          />
        </>
      )}
    </RootStack.Navigator>
  );
}

// ─── Styles ──────────────────────────────────────────────

const tabStyles = StyleSheet.create({
  label: { color: colors.textDim, fontSize: 13, fontWeight: '600' },
  labelActive: { color: colors.accent },
  cameraIcon: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent,
    justifyContent: 'center', alignItems: 'center', marginTop: -8,
  },
  cameraIconText: { color: '#000', fontSize: 24, fontWeight: '700' },
});

const headerStyles = StyleSheet.create({
  btn: { paddingHorizontal: 16 },
  avatar: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { color: '#000', fontWeight: '700', fontSize: 14 },
  connDot: { fontSize: 16 },
});
