#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Registers the Swift `ObscuraBridge` (an RCTEventEmitter) with React Native.
// addListener/removeListeners are inherited from RCTEventEmitter and exposed
// automatically. RPC methods are declared here as they're implemented
// (tasks #5–#13); the single `ObscuraEvent` stream flows once JS subscribes.
@interface RCT_EXTERN_MODULE(ObscuraBridge, RCTEventEmitter)

// ── Auth + state-reads (task #5) ──────────────────────────────────────────
RCT_EXTERN_METHOD(registerUser:(NSString *)username password:(NSString *)password
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(loginSmart:(NSString *)username password:(NSString *)password
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(loginAndProvision:(NSString *)username password:(NSString *)password
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(connect:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(disconnect:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(logout:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getConnectionState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getAuthState:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getUserId:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getUsername:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getDeviceId:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Friends + device linking (task #6) ────────────────────────────────────
RCT_EXTERN_METHOD(befriend:(NSString *)userId username:(NSString *)username
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(acceptFriend:(NSString *)userId username:(NSString *)username
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getFriendCode:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(addFriendByCode:(NSString *)code
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getFriends:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getPendingRequests:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(generateLinkCode:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(validateAndApproveLink:(NSString *)code
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── ORM (task #7) ─────────────────────────────────────────────────────────

// ── Typing signals (task #8) ──────────────────────────────────────────────
RCT_EXTERN_METHOD(sendTyping:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopTyping:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(observeTyping:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(stopObservingTyping:(NSString *)conversationId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Attachments (task #9) ─────────────────────────────────────────────────
RCT_EXTERN_METHOD(uploadAttachment:(NSString *)filePath
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadAttachment:(NSString *)id contentKey:(NSString *)contentKey nonce:(NSString *)nonce
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Image processing (task #10) ───────────────────────────────────────────
RCT_EXTERN_METHOD(resizeImage:(NSString *)srcPath maxDim:(NSInteger)maxDim quality:(NSInteger)quality
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(writeTestImage:(NSInteger)width height:(NSInteger)height
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Misc (task #13) ───────────────────────────────────────────────────────
RCT_EXTERN_METHOD(setClipboard:(NSString *)text
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(deleteFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setSecureScreen:(BOOL)enabled
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(prewarmAudioSession:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Deep linking + debug log (task #12) ───────────────────────────────────
RCT_EXTERN_METHOD(getLaunchIntent:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getDebugLog:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── Push (task #11, partial — permission + token registration) ────────────
RCT_EXTERN_METHOD(requestPushPermission:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(registerPushToken:(NSString *)token
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

// ── The thin kit surface (obscura-proto/KIT_API.md §3, §5, §8.1) ──────────
//
// These MUST mirror the @objc selectors in ObscuraBridge.swift exactly. A Swift @objc method with
// no RCT_EXTERN_METHOD here is invisible to React Native — it compiles, ships, and the call
// silently does nothing at runtime.
RCT_EXTERN_METHOD(inboxPeek:(nonnull NSNumber *)limit
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(inboxConsume:(NSArray *)ids
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(inboxDiscard:(NSArray *)ids reason:(NSString *)reason
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(inboxDepth:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(entryPut:(NSString *)model id:(NSString *)id dataJson:(NSString *)dataJson
                  sentAt:(nonnull NSNumber *)sentAt authorDeviceId:(NSString *)authorDeviceId
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(entryAll:(NSString *)model
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(entryDelete:(NSString *)model id:(NSString *)id
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(sendEntry:(NSArray *)recipientUserIds modelKey:(NSString *)modelKey
                  entryId:(NSString *)entryId op:(NSString *)op sentAt:(nonnull NSNumber *)sentAt
                  payloadJson:(NSString *)payloadJson
                  resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
