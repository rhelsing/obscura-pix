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
///   default group. This is dormant preparation for a possible extension; the
///   current background APNs payload does not launch one.
enum KeychainSession {
    private static let service = "com.obscuraapp.session"
    private static let account = "session_data"

    /// The item's identity. `accessGroup: nil` addresses the app's default group.
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
    /// A keychain item cannot change access group in place, and a query naming
    /// one group cannot see copies in another. Delete both locations on writes
    /// and logout so no unreachable bearer token remains.
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
        // Background processing may run while the device is locked.
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
