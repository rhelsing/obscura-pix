#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Registers the Swift `ObscuraBridge` (an RCTEventEmitter) with React Native.
// addListener/removeListeners are inherited from RCTEventEmitter and exposed
// automatically. RPC methods are declared here as they're implemented
// (tasks #5–#13); the single `ObscuraEvent` stream flows once JS subscribes.
@interface RCT_EXTERN_MODULE(ObscuraBridge, RCTEventEmitter)

@end
