import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider
import FirebaseCore
import FirebaseMessaging
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate, MessagingDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    FirebaseApp.configure()
    Messaging.messaging().delegate = self
    UNUserNotificationCenter.current().delegate = self

    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "ObscuraApp",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  // MARK: - APNS Registration

  /// APNS token → hand to Firebase Messaging. Firebase emits FCM token via
  /// `MessagingDelegate.messaging(_:didReceiveRegistrationToken:)` which forwards to the bridge.
  func application(_ application: UIApplication,
                   didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Messaging.messaging().apnsToken = deviceToken
  }

  func application(_ application: UIApplication,
                   didFailToRegisterForRemoteNotificationsWithError error: Error) {
    NSLog("[AppDelegate] APNS registration failed: %@", error.localizedDescription)
  }

  // MARK: - MessagingDelegate — FCM token lifecycle

  func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
    guard let token = fcmToken else { return }
    NSLog("[AppDelegate] FCM token received (len=%d)", token.count)
    // Broadcast to the bridge; it emits an event to JS which calls Obscura.registerPushToken.
    NotificationCenter.default.post(
      name: Notification.Name("ObscuraFCMTokenReceived"),
      object: nil,
      userInfo: ["token": token]
    )
  }

  // MARK: - Silent Push Reception

  /// Silent push wake (`content-available: 1` from FCM). Hand off to the bridge,
  /// which runs the kit's `processPendingMessages` and posts a generic local notification.
  func application(_ application: UIApplication,
                   didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                   fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
    guard let action = userInfo["action"] as? String, action == "check" else {
      completionHandler(.noData)
      return
    }
    NSLog("[AppDelegate] silent push arrived — forwarding to bridge")
    let handled = ObscuraBridge.handleSilentPush(completion: completionHandler)
    if !handled { completionHandler(.noData) }
  }

  // MARK: - UNUserNotificationCenterDelegate — foreground presentation

  /// Show local notifications posted while the app is foregrounded.
  func userNotificationCenter(_ center: UNUserNotificationCenter,
                              willPresent notification: UNNotification,
                              withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .sound, .badge])
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }

}
