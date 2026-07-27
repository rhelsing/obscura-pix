import Foundation

/// The App Group that the app and its future Notification Service Extension share.
///
/// **Why this exists** (`obscura-proto/KIT_API.md` P2). The NSE is a separate process with a
/// separate bundle id, so it does not share the app's container or its default keychain group.
/// Three things have to move before it can work, and this type owns all three decisions:
///
/// | Thing | Was | Now |
/// |---|---|---|
/// | The SQLCipher database | `.applicationSupportDirectory` (app-private) | App Group container |
/// | The database key | Keychain, default access group | Keychain, App Group |
/// | The session token | Keychain, default access group | Keychain, App Group |
///
/// The third row is not in P2 as drafted. It matters just as much: there is no REST message fetch,
/// so an NSE must mint a gateway ticket to receive anything, and that needs the auth token from
/// `KeychainSession`. An NSE that can decrypt but cannot authenticate does nothing.
///
/// **Why now, with no NSE in sight.** Today this is a path and two keychain attributes over a
/// database holding nothing anyone would miss. Later it is a migration of the only copy of the
/// user's messages — and a keychain item cannot be moved between access groups in place, it must be
/// deleted and re-created. The item holds the only key that can read the message store. That
/// asymmetry is the whole argument for doing it before there is data.
enum SharedContainer {

    /// The App Group identifier. Must match the entitlement in `ObscuraApp.entitlements` **and** a
    /// group registered against the team in the Apple Developer portal — an unregistered group
    /// silently yields a `nil` container rather than a build error, which is what `isAvailable`
    /// below is for.
    static let appGroupId = "group.com.obscuraapp.ios"

    /// The shared container, or `nil` when the entitlement is absent or unprovisioned.
    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }

    /// Whether the App Group is actually usable in this build.
    ///
    /// This is a *runtime* question, not a compile-time one: the entitlement can be present in the
    /// file and still not provisioned by the profile the app was signed with. Everything below
    /// degrades to the previous behaviour when this is `false`, so an unprovisioned build runs
    /// exactly as it did before rather than crashing on launch.
    static var isAvailable: Bool { containerURL != nil }

    /// The keychain access group for items the NSE must read.
    ///
    /// On iOS an App Group identifier is itself a valid keychain access group when the app carries
    /// the app-groups entitlement, so no team-id prefix is hardcoded here. If a build ever fails to
    /// find its items with this set, the alternative is a `keychain-access-groups` entitlement
    /// holding `$(AppIdentifierPrefix)com.obscuraapp.shared` and that literal string here — note
    /// that adding that entitlement also makes its **first** entry the default access group for
    /// items that do not name one, so the app's own identifier must be listed first or existing
    /// items move out from under the code that wrote them.
    ///
    /// `nil` when the group is unavailable, which is exactly what both the kit and `KeychainSession`
    /// treat as "use the default group" — i.e. today's behaviour.
    static var keychainAccessGroup: String? { isAvailable ? appGroupId : nil }

    /// Log once at startup so a silently-unprovisioned group is visible rather than inferred from an
    /// NSE that mysteriously reads nothing.
    static func logStatus(_ log: (String) -> Void) {
        if let containerURL {
            log("[SharedContainer] App Group \(appGroupId) available at \(containerURL.path)")
        } else {
            log("[SharedContainer] App Group \(appGroupId) UNAVAILABLE — falling back to the "
                + "app-private container and the default keychain group. This is the pre-P2 "
                + "behaviour and it works, but a Notification Service Extension will not be able "
                + "to read this device's database or session. Check the entitlement and that the "
                + "group is registered in the Apple Developer portal.")
        }
    }
}
