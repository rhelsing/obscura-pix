import React, { useEffect, useState } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createMaterialTopTabNavigator, type MaterialTopTabBarProps } from '@react-navigation/material-top-tabs';
import { View, Text, TouchableOpacity, StyleSheet, AppState } from 'react-native';
import { useNavigation, useIsFocused, getFocusedRouteNameFromRoute, type RouteProp } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { useSession, useStore } from '../state/store';
import { Obscura, onObscuraEvent } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import { colors } from '../styles';
import { CameraActiveContext } from './CameraActiveContext';

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
const MainTab = createMaterialTopTabNavigator<MainTabParamList>();

// ─── Tab Bar ─────────────────────────────────────────────

// Profile avatar — top-left header button on both tabs.
function ProfileAvatarButton() {
  const { myUsername } = useSession();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  return (
    <TouchableOpacity onPress={() => nav.navigate('Profile')} style={headerStyles.btn}>
      <View style={headerStyles.avatar}>
        <Text style={headerStyles.avatarText}>{myUsername[0]?.toUpperCase() || '?'}</Text>
      </View>
    </TouchableOpacity>
  );
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

// Bottom tab bar for the swipe pager. Floats absolutely over the pager so the
// full-bleed camera preview extends underneath it; background is solid on the
// Chats tab and transparent on the Camera tab (matching the full-bleed look).
function BottomTabBar({ state, navigation }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const onCamera = state.routes[state.index]?.name === 'Camera';
  return (
    <View
      style={[
        tabStyles.bar,
        {
          paddingBottom: insets.bottom + 10,
          backgroundColor: onCamera ? 'transparent' : colors.bg,
          borderTopColor: onCamera ? 'transparent' : colors.border,
        },
      ]}
    >
      {state.routes.map((route, i) => {
        const focused = state.index === i;
        const label = route.name === 'Camera' ? 'Camera' : 'Chat';
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        return (
          <TouchableOpacity key={route.key} style={tabStyles.tab} onPress={onPress}>
            <Text style={[tabStyles.label, focused && tabStyles.labelActive]}>{label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Main Tabs ───────────────────────────────────────────

function MainTabs() {
  // Keep the record-camera live while MainTabs is the foreground screen — true
  // across a tab swipe (so the preview slides in live), false when a modal
  // (ScanFriend's own camera, PhotoPreview) covers it or the app backgrounds.
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  return (
    <CameraActiveContext.Provider value={focused && appActive}>
      <MainTab.Navigator
        initialRouteName="Camera"
        tabBarPosition="bottom"
        tabBar={BottomTabBar}
        // Both screens stay mounted so the camera preview is live as it slides
        // in under the finger; the pager provides the finger-tracking swipe.
        screenOptions={{ lazy: false, swipeEnabled: true }}
      >
        <MainTab.Screen name="Chats" component={ChatListScreen} />
        <MainTab.Screen name="Camera" component={CameraScreen} />
      </MainTab.Navigator>
    </CameraActiveContext.Provider>
  );
}

// Header options for MainTabs, driven by which tab is focused. Header is always
// transparent (so the pager keeps a constant full-screen height — no layout
// jump mid-swipe); only its background + right button change per tab.
function mainTabsHeaderOptions({ route }: { route: RouteProp<RootStackParamList, 'MainTabs'> }) {
  const tab = getFocusedRouteNameFromRoute(route) ?? 'Camera';
  const isCamera = tab === 'Camera';
  return {
    headerShown: true,
    headerTransparent: true,
    headerStyle: { backgroundColor: isCamera ? 'transparent' : colors.bg },
    headerShadowVisible: false,
    headerTitle: 'obscura',
    headerTitleAlign: 'center' as const,
    headerTintColor: colors.text,
    headerTitleStyle: { color: colors.text, fontWeight: '700' as const },
    headerLeft: () => <ProfileAvatarButton />,
    headerRight: () => (isCamera ? null : <AddFriendHeaderButton />),
  };
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
          <RootStack.Screen name="MainTabs" component={MainTabs} options={mainTabsHeaderOptions} />
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
              title: 'Profile',
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
              title: 'Add friend',
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
  bar: {
    flexDirection: 'row',
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, alignItems: 'center' },
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
