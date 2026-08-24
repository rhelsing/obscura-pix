import React, { useEffect, useState } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createMaterialTopTabNavigator, type MaterialTopTabBarProps } from '@react-navigation/material-top-tabs';
import { View, TouchableOpacity, StyleSheet, AppState } from 'react-native';
import { useNavigation, useIsFocused } from '@react-navigation/native';
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
import { CameraIcon, ChatIcon } from '../components/icons';

import type { RootStackParamList, MainTabParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTab = createMaterialTopTabNavigator<MainTabParamList>();

// Bottom tab bar for the swipe pager. Floats absolutely over the pager so the
// full-bleed camera preview extends underneath it; background is solid on the
// Chats tab and transparent on the Camera tab (matching the full-bleed look).
function BottomTabBar({ state, navigation }: MaterialTopTabBarProps) {
  const insets = useSafeAreaInsets();
  const onCamera = state.routes[state.index]?.name === 'Camera';
  const barDynamic = {
    paddingBottom: insets.bottom + 10,
    backgroundColor: onCamera ? 'transparent' : colors.bg,
    borderTopColor: onCamera ? 'transparent' : colors.border,
  };
  return (
    <View style={[tabStyles.bar, barDynamic]}>
      {state.routes.map((route, i) => {
        const focused = state.index === i;
        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
        };
        const tint = focused ? colors.accent : colors.textDim;
        const Icon = route.name === 'Camera' ? CameraIcon : ChatIcon;
        return (
          <TouchableOpacity key={route.key} style={tabStyles.tab} onPress={onPress} accessibilityLabel={route.name}>
            <Icon size={27} color={tint} strokeWidth={focused ? 2.4 : 2} />
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

// ─── Splash (during initial auth check) ──────────────────

function SplashScreen() {
  return <View style={headerStyles.splash} />;
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
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
    flexDirection: 'row',
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, alignItems: 'center' },
});

const headerStyles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg },
});
