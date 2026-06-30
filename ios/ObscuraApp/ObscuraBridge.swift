import Foundation
import React
import ObscuraKit

/// Thin React Native bridge — the iOS analog of `ObscuraBridgeModule.kt`.
/// Owns NO Obscura state: client lifecycle / persistence / app-state live in
/// `ObscuraSession`. This class:
///
///   - Relays the kit's unified `observeEvents()` stream to JS as the single
///     `ObscuraEvent` stream (discriminated by `type`, per docs/BRIDGE.md).
///   - (later tasks) translates `@objc` RPC methods into `ObscuraSession.client`
///     calls and marshals between JS and Swift types.
///
/// Registered with React via `ObscuraBridge.m` (`RCT_EXTERN_MODULE`).
@objc(ObscuraBridge)
final class ObscuraBridge: RCTEventEmitter {

    private var hasListeners = false
    private var eventTask: Task<Void, Never>?

    override init() {
        super.init()
        // Kit diagnostics -> debugLog event.
        ObscuraSession.shared.logger.onLog = { [weak self] msg in
            self?.emit("debugLog", ["message": msg])
        }
        // Process foreground/background -> appStateChanged event.
        ObscuraSession.shared.onAppStateChanged = { [weak self] active in
            self?.emit("appStateChanged", ["state": active ? "active" : "background"])
        }
        // Re-subscribe when the live client is swapped (login/register/restore).
        ObscuraSession.shared.onClientReplaced = { [weak self] client in
            self?.bindEvents(client)
        }
        bindEvents(ObscuraSession.shared.client)
    }

    deinit { eventTask?.cancel() }

    @objc override static func requiresMainQueueSetup() -> Bool { false }

    /// Single named stream; payloads are discriminated by `type`.
    override func supportedEvents() -> [String]! { ["ObscuraEvent"] }

    override func startObserving() { hasListeners = true }
    override func stopObserving() { hasListeners = false }

    // MARK: - Emission

    /// Emit one `ObscuraEvent`. Folds `type` into the payload, matching Android's
    /// `emit(type) { … }` helper. No-ops until JS has a listener attached.
    func emit(_ type: String, _ fields: [String: Any] = [:]) {
        guard hasListeners else { return }
        var body = fields
        body["type"] = type
        sendEvent(withName: "ObscuraEvent", body: body)
    }

    // MARK: - Kit event stream -> JS

    private func bindEvents(_ client: ObscuraClient) {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await event in client.observeEvents() {
                guard let self = self else { return }
                switch event {
                case .connectionChanged(let state):
                    self.emit("connectionChanged", ["state": state.rawValue])
                case .authChanged(let state):
                    self.emit("authStateChanged", ["state": state.rawValue])
                case .authFailed(let reason):
                    self.emit("authFailed", ["reason": reason])
                case .friendsUpdated(let friends):
                    self.emit("friendsUpdated", ["friends": friends.map { ObscuraBridge.friendDict($0) }])
                case .messageReceived(let model, _):
                    // Minimal payload — JS re-queries the ORM. Don't synthesize an id.
                    self.emit("messageReceived", ["model": model])
                case .typingChanged(let conversationId, let typers):
                    self.emit("typingChanged", ["conversationId": conversationId, "typers": typers])
                case .debugLog(let message):
                    self.emit("debugLog", ["message": message])
                }
            }
        }
    }

    /// `Friend` -> the `{ userId, username, status }` shape JS expects.
    static func friendDict(_ f: Friend) -> [String: Any] {
        ["userId": f.userId, "username": f.username, "status": f.status.rawValue]
    }
}
