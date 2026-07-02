import Foundation
import UIKit
import ObscuraKit

/// Logger that forwards kit diagnostics to a sink (the RN `debugLog` event) and
/// surfaces hard auth failures. The bridge sets `onLog`. `@unchecked Sendable`
/// because the sink is only assigned once at bind time.
final class BridgeLogger: ObscuraLogger, @unchecked Sendable {
    var onLog: ((String) -> Void)?

    private let lock = NSLock()
    private var buffer: [String] = []
    private let maxLines = 200

    /// Snapshot of recent diagnostic lines (for the in-app Settings debug log).
    func recentLines() -> [String] {
        lock.lock(); defer { lock.unlock() }
        return buffer
    }

    func log(_ message: String) {
        NSLog("[ObscuraKit] %@", message)
        lock.lock()
        buffer.append(message)
        if buffer.count > maxLines { buffer.removeFirst(buffer.count - maxLines) }
        lock.unlock()
        onLog?(message)
    }
    func decryptFailed(sourceUserId: String, error: String) { log("decrypt failed from \(sourceUserId.prefix(8)): \(error)") }
    func ackFailed(envelopeId: String, error: String) { log("ack failed \(envelopeId): \(error)") }
    func frameParseFailed(byteCount: Int, error: String) { log("frame parse failed (\(byteCount)B): \(error)") }
    func sessionEstablishFailed(userId: String, error: String) { log("session establish failed \(userId.prefix(8)): \(error)") }
    func tokenRefreshFailed(attempt: Int, error: String) { log("token refresh failed (attempt \(attempt)): \(error)") }
    func identityChanged(address: String) { log("identity changed: \(address)") }
    func signatureVerificationFailed(sourceUserId: String, messageType: String) { log("sig verify failed from \(sourceUserId.prefix(8)) type=\(messageType)") }
    func unauthorizedSync(sourceUserId: String, messageType: String) { log("unauthorized sync from \(sourceUserId.prefix(8)) type=\(messageType)") }
    func databaseError(store: String, operation: String, error: String) { log("db error \(store).\(operation): \(error)") }
}

/// Process-scoped owner of the `ObscuraClient` — the iOS analog of Android's
/// `ObscuraSession`. Single source of truth for:
///
///   - Client lifecycle (placeholder → user-scoped encrypted DB on login/register)
///   - Keychain-backed session persistence (token/refresh/userId/deviceId/username)
///   - Restore-from-Keychain on cold start (sets `deviceId` before `authState`
///     flips to `.authenticated`, so the JS-driven `defineModels` stamps a correct
///     `authorDeviceId` — see docs/IOS_PARITY.md)
///   - App foreground/background tracking (reconnect on resume)
///
/// The RN bridge (`ObscuraBridge`) subscribes to `client.observeEvents()` and is
/// notified via `onClientReplaced` whenever the live client instance changes.
final class ObscuraSession {
    static let shared = ObscuraSession()

    static let apiURL = "https://obscura.barrelmaker.dev"

    private(set) var client: ObscuraClient
    private(set) var appInForeground = true

    let logger = BridgeLogger()

    /// Fired when the live client instance is replaced (login/register/restore),
    /// so the bridge can re-bind its `observeEvents()` subscription.
    var onClientReplaced: ((ObscuraClient) -> Void)?
    /// Fired on process foreground/background transitions (`appStateChanged`).
    var onAppStateChanged: ((Bool) -> Void)?

    private init() {
        if let saved = KeychainSession.load() {
            var restored: ObscuraClient?
            do {
                restored = try ObscuraClient(
                    apiURL: ObscuraSession.apiURL,
                    dataDirectory: ObscuraSession.userDir(saved.userId),
                    userId: saved.userId
                )
            } catch {
                // Pre-init (self not fully constructed): NSLog rather than self.logger.
                NSLog("[ObscuraSession] session restore: failed to open user client: %@", "\(error)")
                restored = nil
            }
            client = restored ?? (try! ObscuraClient(apiURL: ObscuraSession.apiURL))
            client.logger = logger
            Task { await restore(saved) }
        } else {
            client = try! ObscuraClient(apiURL: ObscuraSession.apiURL)
            client.logger = logger
        }
        observeAppLifecycle()
    }

    // MARK: - Per-user data directory (SQLCipher DB keyed by userId)

    private static var baseDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ObscuraData")
    }
    static func userDir(_ userId: String) -> String {
        baseDir.appendingPathComponent(userId).path
    }

    // MARK: - Client lifecycle

    /// Build a fresh user-scoped client (encrypted DB) for a known userId.
    /// `freshDirectory` wipes any prior data (register flow).
    func makeUserClient(userId: String, freshDirectory: Bool = false) throws -> ObscuraClient {
        let dir = ObscuraSession.userDir(userId)
        if freshDirectory { try? FileManager.default.removeItem(atPath: dir) }
        let c = try ObscuraClient(apiURL: ObscuraSession.apiURL, dataDirectory: dir, userId: userId)
        c.logger = logger
        return c
    }

    /// Swap in a new live client; disconnect the old one and notify the bridge.
    func replaceClient(_ newClient: ObscuraClient) {
        client.disconnect()
        newClient.logger = logger
        client = newClient
        onClientReplaced?(newClient)
    }

    // MARK: - Persistence

    func saveSession() {
        guard let token = client.token, let userId = client.userId else { return }
        KeychainSession.save(SessionData(
            token: token,
            refreshToken: client.refreshToken,
            userId: userId,
            deviceId: client.deviceId,
            username: client.username
        ))
    }

    func clearSession() { KeychainSession.clear() }

    // MARK: - Restore on launch

    private func restore(_ saved: SessionData) async {
        await client.restoreSession(
            token: saved.token,
            refreshToken: saved.refreshToken,
            userId: saved.userId,
            deviceId: saved.deviceId,
            username: saved.username
        )
        let fresh = await client.ensureFreshToken()
        guard fresh else { clearSession(); return }
        saveSession()
        do { try await client.connect() } catch { logger.log("restore connect failed: \(error)") }
    }

    // MARK: - App lifecycle

    private func observeAppLifecycle() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.appInForeground = true
            self.onAppStateChanged?(true)
            let c = self.client
            if c.authState == .authenticated && c.connectionState == .disconnected {
                Task { do { try await c.connect() } catch { self.logger.log("foreground reconnect failed: \(error)") } }
            }
        }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appInForeground = false
            self?.onAppStateChanged?(false)
        }
    }
}
