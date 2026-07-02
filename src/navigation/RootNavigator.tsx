import React, { useEffect } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useSession, useStore } from '../state/store';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { colors } from '../styles';

import { AuthScreen } from '../screens/AuthScreen';
import { CameraScreen } from '../screens/CameraScreen';
import { ChatListScreen } from '../screens/ChatListScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { PhotoPreviewScreen } from '../screens/PhotoPreviewScreen';
import { RecipientPicker } from '../screens/RecipientPicker';
import { StoryViewer } from '../screens/StoriesScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { AddFriendScreen } from '../screens/AddFriendScreen';
import { ScanFriendScreen } from '../screens/ScanFriendScreen';
import { AddFriendIcon } from '../components/AddFriendIcon';

import type { RootStackParamList, MainTabParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTab = createBottomTabNavigator<MainTabParamList>();

// ─── Tab Bar ─────────────────────────────────────────────

function TabBarLabel({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={[tabStyles.label, focused && tabStyles.labelActive]}>{label}</Text>;
}

// Add-friend button — top-right on the Chats tab. Opens the AddFriend modal.
function AddFriendHeaderButton() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <TouchableOpacity onPress={() => nav.navigate('AddFriend')} style={headerStyles.btn}>
      <AddFriendIcon size={24} color={colors.accent} />
    </TouchableOpacity>
  );
}

// ─── Main Tabs ───────────────────────────────────────────

function MainTabs() {
  const { myUsername } = useSession();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <MainTab.Navigator
      screenOptions={{
        // Slide-across transition when switching tabs (tap or swipe).
        animation: 'shift',
        headerStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { color: colors.text, fontWeight: '700' },
        headerLeft: () => (
          <TouchableOpacity onPress={() => nav.navigate('Profile')} style={headerStyles.btn}>
            <View style={headerStyles.avatar}>
              <Text style={headerStyles.avatarText}>{myUsername[0]?.toUpperCase() || '?'}</Text>
            </View>
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
          headerRight: () => <AddFriendHeaderButton />,
        }}
      />
      <MainTab.Screen
        name="Camera"
        component={CameraScreen}
        options={{
          tabBarIcon: () => null,
          tabBarLabel: ({ focused }) => <TabBarLabel label="camera" focused={focused} />,
          // Full-bleed camera: float both bars transparently over the preview so
          // it fills the screen edge-to-edge like the photo preview does.
          headerTransparent: true,
          headerStyle: { backgroundColor: 'transparent' },
          headerShadowVisible: false,
          tabBarStyle: {
            position: 'absolute', backgroundColor: 'transparent',
            borderTopColor: 'transparent', elevation: 0,
          },
        }}
      />
    </MainTab.Navigator>
  );
}

// ─── Splash (during initial auth check) ──────────────────

function SplashScreen() {
  return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
}

// ─── Root Navigator ──────────────────────────────────────

export function RootNavigator() {
  const { authed } = useSession();
  const bootstrapped = useStore((s) => s.bootstrapped);
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
    }).catch((e) => logError('launchIntent', e));
    return onObscuraEvent((event) => {
      if (event.type === 'launchedFrom' && event.screen) route(event.screen);
    });
  }, [authed, nav]);

  return (
    <RootStack.Navigator screenOptions={{ headerShown: false, headerBackButtonDisplayMode: 'minimal' }}>
      {!bootstrapped ? (
        // Plain black screen while the cold-start auth check is in flight.
        // Avoids flashing the AuthScreen for users who are already logged in.
        <RootStack.Screen name="Splash" component={SplashScreen} />
      ) : !authed ? (
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
            // Instant swap — no slide/fade so the captured frame feels like it
            // freezes in place rather than popping in as a new screen.
            options={{ presentation: 'fullScreenModal', animation: 'none' }}
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
            name="AddFriend"
            component={AddFriendScreen}
            options={{
              headerShown: true,
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.accent,
              headerTitleStyle: { color: colors.text, fontWeight: '700' },
              title: 'add friend',
            }}
          />
          <RootStack.Screen
            name="ScanFriend"
            component={ScanFriendScreen}
            options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
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
});

const headerStyles = StyleSheet.create({
  btn: { paddingHorizontal: 16 },
  avatar: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarText: { color: '#000', fontWeight: '700', fontSize: 14 },
});
