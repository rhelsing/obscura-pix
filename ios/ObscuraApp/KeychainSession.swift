import Foundation
import Security

/// Keychain-backed session storage — iOS equivalent of Android's
/// EncryptedSharedPreferences (`ObscuraSession` prefs). Holds the minimal
/// session needed to restore an `ObscuraClient` on cold start.
struct SessionData: Codable {
    let token: String
    let refreshToken: String?
    let userId: String
    let deviceId: String?
    let username: String?
}

/// - Note: **The session lives in the App Group keychain** (`SharedContainer`), not the app's
///   default group. A Notification Service Extension needs it: there is no REST message fetch, so
///   the NSE must mint a gateway ticket with this token before it can receive anything to decrypt.
///   See `obscura-proto/KIT_API.md` P2 — the drafted version names only the SQLCipher key, which is
///   necessary but not sufficient.
enum KeychainSession {
    private static let service = "com.obscuraapp.session"
    private static let account = "session_data"

    /// The item's identity. `accessGroup: nil` addresses the app's default group, which is where
    /// every item written before the App Group landed still lives — see `deleteEverywhere`.
    private static func query(accessGroup: String?) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    /// Delete the item from **both** the shared group and the default one.
    ///
    /// A keychain item cannot change access group in place, so the move leaves the pre-P2 item
    /// behind in the default group. `load()` would not see it — a query naming a group only matches
    /// that group — so it would linger indefinitely as an unreachable copy of a live bearer token.
    /// Deleting both on every write and on logout is what stops that, and in particular stops
    /// `clear()` from leaving a token behind at logout, which is the one place it would matter.
    private static func deleteEverywhere() {
        SecItemDelete(query(accessGroup: SharedContainer.keychainAccessGroup) as CFDictionary)
        if SharedContainer.keychainAccessGroup != nil {
            SecItemDelete(query(accessGroup: nil) as CFDictionary)
        }
    }

    static func save(_ session: SessionData) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        deleteEverywhere()
        var addQuery = query(accessGroup: SharedContainer.keychainAccessGroup)
        addQuery[kSecValueData as String] = data
        // afterFirstUnlock, not whenUnlocked: an NSE runs while the device is locked, and an item
        // it cannot read is an extension that cannot authenticate.
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    static func load() -> SessionData? {
        var q = query(accessGroup: SharedContainer.keychainAccessGroup)
        q[kSecReturnData as String] = true
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(SessionData.self, from: data)
    }

    static func clear() {
        deleteEverywhere()
    }
}
