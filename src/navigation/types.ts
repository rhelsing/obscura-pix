import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { Friend, ModelEntry } from '../native/ObscuraModule';
import type { PhotoFile } from 'react-native-vision-camera';

export type MainTabParamList = {
  Camera: undefined;
  Chats: undefined;
};

export type RootStackParamList = {
  /** Black placeholder shown only while the cold-start auth check is in flight. */
  Splash: undefined;
  Auth: undefined;
  MainTabs: NavigatorScreenParams<MainTabParamList>;
  Chat: { friend: Friend };
  PhotoPreview: { photo: { path: string; width: number; height: number } };
  RecipientPicker: {
    photo: { path: string; width: number; height: number };
    caption: string;
    displayDuration: number;
  };
  StoryViewer: {
    /**
     * Stories grouped by author. Each group is rendered as one auto-advancing
     * sequence; the viewer can swipe between groups.
     */
    groups: StoryGroup[];
    startIndex: number;
    /**
     * Whether to fire `viewedAt` upserts as entries are shown. Used by the
     * pix viewer; story groups don't need it.
     */
    markViewed?: boolean;
  };
  Profile: undefined;
  Settings: undefined;
};

export interface StoryGroup {
  username: string;
  stories: ModelEntry[];
  isMe: boolean;
}

export type RootStackScreenProps<T extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, T>;

export type MainTabScreenProps<T extends keyof MainTabParamList> =
  CompositeScreenProps<
    BottomTabScreenProps<MainTabParamList, T>,
    NativeStackScreenProps<RootStackParamList>
  >;

// PhotoFile compatibility for camera capture path
export type CapturedPhoto = Pick<PhotoFile, 'path' | 'width' | 'height'>;
