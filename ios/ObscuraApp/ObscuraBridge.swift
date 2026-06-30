import Foundation
import React
import ObscuraKit
import UIKit
import ImageIO
import UniformTypeIdentifiers
import UserNotifications

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
    /// Active typing observations, keyed by conversationId (task #8).
    private var typingTasks: [String: Task<Void, Never>] = [:]

    /// Weak ref so AppDelegate hooks (deep links) can reach the live bridge.
    static weak var shared: ObscuraBridge?
    /// Cold-start deep-link target, set by AppDelegate before the bridge exists;
    /// consumed once by `getLaunchIntent`.
    static var pendingLaunchScreen: String?

    override init() {
        super.init()
        ObscuraBridge.shared = self
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

    // Convenience: the live client (always non-nil — placeholder until login).
    var client: ObscuraClient { ObscuraSession.shared.client }
}

// MARK: - Auth + state-reads (task #5)

extension ObscuraBridge {

    @objc(registerUser:password:resolver:rejecter:)
    func registerUser(_ username: String, password: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                // Get userId, build a user-scoped encrypted DB, provision this device.
                let creds = try await ObscuraClient.registerAccount(username, password)
                let c = try ObscuraSession.shared.makeUserClient(userId: creds.userId, freshDirectory: true)
                await c.restoreSession(token: creds.token, refreshToken: creds.refreshToken,
                                       userId: creds.userId, deviceId: nil, username: username)
                try await c.provisionCurrentDevice()
                ObscuraSession.shared.replaceClient(c)
                ObscuraSession.shared.saveSession()
                resolve(nil)
            } catch {
                reject("REGISTER_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc(loginSmart:password:resolver:rejecter:)
    func loginSmart(_ username: String, password: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                // Step 1: user-scoped login to learn userId, build the encrypted DB.
                let shell = try await ObscuraClient.loginAccount(username, password)
                let c = try ObscuraSession.shared.makeUserClient(userId: shell.userId)
                ObscuraSession.shared.replaceClient(c)
                // Step 2: smart login decides what JS should do next.
                let scenario = try await c.loginSmart(username, password)
                let mapped: String
                switch scenario {
                case .existingDevice:    mapped = "existingDevice"
                case .newDevice:         mapped = "newDevice"
                // onlyDevice isn't in the JS union; both it and deviceMismatch want a
                // re-provision, which JS triggers via loginAndProvision.
                case .onlyDevice, .deviceMismatch: mapped = "deviceMismatch"
                case .invalidCredentials: mapped = "invalidCredentials"
                case .userNotFound:      mapped = "userNotFound"
                }
                if scenario == .existingDevice { ObscuraSession.shared.saveSession() }
                resolve(mapped)
            } catch {
                reject("LOGIN_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc(loginAndProvision:password:resolver:rejecter:)
    func loginAndProvision(_ username: String, password: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                try await ObscuraSession.shared.client.loginAndProvision(username, password)
                ObscuraSession.shared.saveSession()
                resolve(nil)
            } catch {
                reject("PROVISION_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc(connect:rejecter:)
    func connect(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let c = ObscuraSession.shared.client
                _ = await c.ensureFreshToken()
                try await c.connect()
                ObscuraSession.shared.saveSession()
                resolve(nil)
            } catch {
                reject("CONNECT_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc(disconnect:rejecter:)
    func disconnect(_ resolve: RCTPromiseResolveBlock,
                    rejecter reject: RCTPromiseRejectBlock) {
        ObscuraSession.shared.client.disconnect()
        resolve(nil)
    }

    @objc(logout:rejecter:)
    func logout(_ resolve: @escaping RCTPromiseResolveBlock,
                rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            try? await ObscuraSession.shared.client.logout()
            ObscuraSession.shared.clearSession()
            resolve(nil)
        }
    }

    @objc(getConnectionState:rejecter:)
    func getConnectionState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.connectionState.rawValue)
    }

    @objc(getAuthState:rejecter:)
    func getAuthState(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.authState.rawValue)
    }

    @objc(getUserId:rejecter:)
    func getUserId(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.userId)
    }

    @objc(getUsername:rejecter:)
    func getUsername(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.username)
    }

    @objc(getDeviceId:rejecter:)
    func getDeviceId(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(client.deviceId)
    }
}

// MARK: - Friends + device linking (task #6)

extension ObscuraBridge {

    @objc(befriend:username:resolver:rejecter:)
    func befriend(_ userId: String, username: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.befriend(userId, username: username); resolve(nil) }
            catch { reject("BEFRIEND_ERROR", error.localizedDescription, error) }
        }
    }

    @objc(acceptFriend:username:resolver:rejecter:)
    func acceptFriend(_ userId: String, username: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.acceptFriend(userId, username: username); resolve(nil) }
            catch { reject("ACCEPT_ERROR", error.localizedDescription, error) }
        }
    }

    @objc(getFriendCode:rejecter:)
    func getFriendCode(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        guard let code = client.friendCode() else {
            reject("FRIEND_CODE_ERROR", "no friend code available (not authenticated?)", nil); return
        }
        resolve(code)
    }

    @objc(addFriendByCode:resolver:rejecter:)
    func addFriendByCode(_ code: String,
                         resolver resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.addFriendByCode(code); resolve(nil) }
            catch { reject("ADD_FRIEND_ERROR", error.localizedDescription, error) }
        }
    }

    @objc(getFriends:rejecter:)
    func getFriends(_ resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            let all = await client.friends.getAll()
            resolve(all.map { ObscuraBridge.friendDict($0) })
        }
    }

    @objc(getPendingRequests:rejecter:)
    func getPendingRequests(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            let pending = await client.friends.getPending()
            resolve(pending.map { ObscuraBridge.friendDict($0) })
        }
    }

    @objc(generateLinkCode:rejecter:)
    func generateLinkCode(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        guard let code = client.generateLinkCode() else {
            reject("LINK_CODE_ERROR", "could not generate link code", nil); return
        }
        resolve(code)
    }

    @objc(validateAndApproveLink:resolver:rejecter:)
    func validateAndApproveLink(_ code: String,
                                resolver resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.validateAndApproveLink(code); resolve(nil) }
            catch { reject("LINK_APPROVE_ERROR", error.localizedDescription, error) }
        }
    }
}

// MARK: - ORM (task #7)

extension ObscuraBridge {

    /// Parse a JSON object string from JS into `[String: Any]`.
    private func parseJSONObject(_ s: String) -> [String: Any] {
        guard let d = s.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        else { return [:] }
        return obj
    }

    /// `ModelEntry` -> the `{ id, data, timestamp, authorDeviceId }` shape JS expects.
    /// (signature is intentionally omitted — matches Android + BRIDGE.md.)
    static func entryDict(_ e: ModelEntry) -> [String: Any] {
        ["id": e.id, "data": e.data, "timestamp": Double(e.timestamp), "authorDeviceId": e.authorDeviceId]
    }

    private func requireModel(_ name: String, _ reject: RCTPromiseRejectBlock) -> Model? {
        guard let m = client.model(name) else {
            reject("NO_MODEL", "model '\(name)' not defined — call defineModels first", nil)
            return nil
        }
        return m
    }

    @objc(defineModels:resolver:rejecter:)
    func defineModels(_ schemaJson: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        do { try client.defineModelsFromJson(schemaJson); resolve(nil) }
        catch { reject("DEFINE_MODELS_ERROR", error.localizedDescription, error) }
    }

    @objc(createEntry:dataJson:resolver:rejecter:)
    func createEntry(_ model: String, dataJson: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let m = requireModel(model, reject) else { return }
        Task {
            do {
                let entry = try await m.create(parseJSONObject(dataJson))
                emit("entriesChanged", ["model": model])
                resolve(ObscuraBridge.entryDict(entry))
            } catch { reject("CREATE_ERROR", error.localizedDescription, error) }
        }
    }

    @objc(upsertEntry:id:dataJson:resolver:rejecter:)
    func upsertEntry(_ model: String, id: String, dataJson: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let m = requireModel(model, reject) else { return }
        Task {
            do {
                let entry = try await m.upsert(id, parseJSONObject(dataJson))
                emit("entriesChanged", ["model": model])
                resolve(ObscuraBridge.entryDict(entry))
            } catch { reject("UPSERT_ERROR", error.localizedDescription, error) }
        }
    }

    @objc(queryEntries:conditionsJson:resolver:rejecter:)
    func queryEntries(_ model: String, conditionsJson: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let m = requireModel(model, reject) else { return }
        Task {
            let entries = await m.where(parseJSONObject(conditionsJson)).exec()
            resolve(entries.map { ObscuraBridge.entryDict($0) })
        }
    }

    @objc(allEntries:resolver:rejecter:)
    func allEntries(_ model: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let m = requireModel(model, reject) else { return }
        Task {
            let entries = await m.all()
            resolve(entries.map { ObscuraBridge.entryDict($0) })
        }
    }

    @objc(deleteEntry:id:resolver:rejecter:)
    func deleteEntry(_ model: String, id: String,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let m = requireModel(model, reject) else { return }
        Task {
            do {
                _ = try await m.delete(id)
                emit("entriesChanged", ["model": model])
                resolve(nil)
            } catch { reject("DELETE_ERROR", error.localizedDescription, error) }
        }
    }
}

// MARK: - Typing signals (task #8)
//
// Typing rides on the "directMessage" model (chat), matching Android. The
// untyped Model typing API is provided by the kit (obscura-client-ios task #19).

extension ObscuraBridge {

    private static let typingModel = "directMessage"

    @objc(sendTyping:resolver:rejecter:)
    func sendTyping(_ conversationId: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await client.model(ObscuraBridge.typingModel)?.typing(conversationId: conversationId)
            resolve(nil)
        }
    }

    @objc(stopTyping:resolver:rejecter:)
    func stopTyping(_ conversationId: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            await client.model(ObscuraBridge.typingModel)?.stopTyping(conversationId: conversationId)
            resolve(nil)
        }
    }

    @objc(observeTyping:resolver:rejecter:)
    func observeTyping(_ conversationId: String,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard let m = client.model(ObscuraBridge.typingModel) else { resolve(nil); return }
        typingTasks[conversationId]?.cancel()
        typingTasks[conversationId] = Task { [weak self] in
            for await typers in m.observeTyping(conversationId: conversationId).values {
                self?.emit("typingChanged", ["conversationId": conversationId, "typers": typers])
            }
        }
        resolve(nil)
    }

    @objc(stopObservingTyping:resolver:rejecter:)
    func stopObservingTyping(_ conversationId: String,
                             resolver resolve: RCTPromiseResolveBlock,
                             rejecter reject: RCTPromiseRejectBlock) {
        typingTasks[conversationId]?.cancel()
        typingTasks[conversationId] = nil
        resolve(nil)
    }
}

// MARK: - Attachments (task #9)
//
// Bytes never cross the bridge: upload reads a file path, download decrypts to
// a cache file and returns its path. Mirrors ObscuraBridgeModule.kt.

extension ObscuraBridge {

    private static let safeIdChars = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")

    @objc(uploadAttachment:resolver:rejecter:)
    func uploadAttachment(_ filePath: String,
                          resolver resolve: @escaping RCTPromiseResolveBlock,
                          rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
                // The kit encrypts + uploads and returns the reference triple.
                let result = try await client.uploadAttachment(data)
                resolve([
                    "id": result.id,
                    "contentKey": result.contentKey.base64EncodedString(),
                    "nonce": result.nonce.base64EncodedString(),
                ])
            } catch {
                reject("UPLOAD_ERROR", error.localizedDescription, error)
            }
        }
    }

    @objc(downloadAttachment:contentKey:nonce:resolver:rejecter:)
    func downloadAttachment(_ id: String, contentKey: String, nonce: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do {
                let fm = FileManager.default
                let dir = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("attachments")
                try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

                // Sanitize the (server-generated) id to a safe filename — no traversal.
                let safe = String(String.UnicodeScalarView(
                    id.unicodeScalars.map { ObscuraBridge.safeIdChars.contains($0) ? $0 : "_" }))
                let dest = dir.appendingPathComponent("\(safe).jpg")

                // Cache hit — return immediately.
                let size = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? Int) ?? 0
                if fm.fileExists(atPath: dest.path) && (size ?? 0) > 0 {
                    resolve(dest.path); return
                }

                guard let keyData = Data(base64Encoded: contentKey),
                      let nonceData = Data(base64Encoded: nonce) else {
                    reject("DOWNLOAD_ERROR", "invalid base64 key/nonce", nil); return
                }
                let data = try await client.downloadDecryptedAttachment(
                    id: id, contentKey: keyData, nonce: nonceData)

                // Atomic publish: write a sibling temp, then rename into place.
                let tmp = dir.appendingPathComponent("\(safe).jpg.tmp")
                try data.write(to: tmp, options: .atomic)
                if fm.fileExists(atPath: dest.path) { try? fm.removeItem(at: dest) }
                try fm.moveItem(at: tmp, to: dest)
                resolve(dest.path)
            } catch {
                reject("DOWNLOAD_ERROR", error.localizedDescription, error)
            }
        }
    }
}

// MARK: - Image processing (task #10) — pure native, path-in/path-out

extension ObscuraBridge {

    private static func outputImageURL() -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("processed")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("\(UUID().uuidString).jpg")
    }

    /// Re-encode the image at `srcPath` as JPEG so its largest side is ≤ `maxDim`.
    /// EXIF orientation is baked into the output (ThumbnailWithTransform); peak
    /// memory is bounded by ImageIO's thumbnail decode. Source is untouched.
    @objc(resizeImage:maxDim:quality:resolver:rejecter:)
    func resizeImage(_ srcPath: String, maxDim: NSInteger, quality: NSInteger,
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard maxDim > 0 else { reject("RESIZE_ERROR", "maxDim must be > 0", nil); return }
        let q = max(1, min(100, quality))
        Task.detached {
            let srcURL = URL(fileURLWithPath: srcPath)
            guard let src = CGImageSourceCreateWithURL(srcURL as CFURL, nil) else {
                reject("RESIZE_ERROR", "cannot read image at \(srcPath)", nil); return
            }
            let opts: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: maxDim,
                kCGImageSourceCreateThumbnailWithTransform: true, // bake EXIF orientation
            ]
            guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
                reject("RESIZE_ERROR", "resize failed (corrupt or out of memory)", nil); return
            }
            let outURL = ObscuraBridge.outputImageURL()
            guard let dest = CGImageDestinationCreateWithURL(
                outURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
                reject("RESIZE_ERROR", "cannot create JPEG destination", nil); return
            }
            CGImageDestinationAddImage(dest, thumb, [
                kCGImageDestinationLossyCompressionQuality: Double(q) / 100.0
            ] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else {
                reject("RESIZE_ERROR", "failed to encode JPEG", nil); return
            }
            resolve(["path": outURL.path, "width": thumb.width, "height": thumb.height])
        }
    }

    /// Generate a simple test image (emulator / no-camera fallback in CameraScreen).
    @objc(writeTestImage:height:resolver:rejecter:)
    func writeTestImage(_ width: NSInteger, height: NSInteger,
                        resolver resolve: @escaping RCTPromiseResolveBlock,
                        rejecter reject: @escaping RCTPromiseRejectBlock) {
        guard width > 0, height > 0, width <= 8192, height <= 8192 else {
            reject("TEST_IMAGE_ERROR", "invalid dimensions", nil); return
        }
        let size = CGSize(width: width, height: height)
        let img = UIGraphicsImageRenderer(size: size).image { ctx in
            UIColor.systemIndigo.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            UIColor.white.setStroke()
            let path = UIBezierPath()
            path.move(to: .zero)
            path.addLine(to: CGPoint(x: size.width, y: size.height))
            path.lineWidth = 4
            path.stroke()
        }
        guard let data = img.jpegData(compressionQuality: 0.9) else {
            reject("TEST_IMAGE_ERROR", "failed to encode test image", nil); return
        }
        let outURL = ObscuraBridge.outputImageURL()
        do {
            try data.write(to: outURL, options: .atomic)
            resolve(["path": outURL.path, "width": width, "height": height])
        } catch {
            reject("TEST_IMAGE_ERROR", error.localizedDescription, error)
        }
    }
}

// MARK: - Misc (task #13)

extension ObscuraBridge {

    @objc(setClipboard:resolver:rejecter:)
    func setClipboard(_ text: String,
                      resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        UIPasteboard.general.string = text
        resolve(nil)
    }

    /// Best-effort delete — a missing file resolves (does not reject), per BRIDGE.md.
    @objc(deleteFile:resolver:rejecter:)
    func deleteFile(_ path: String,
                    resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        try? FileManager.default.removeItem(atPath: path)
        resolve(nil)
    }

    /// Android sets FLAG_SECURE; on iOS this is an accepted no-op (a future
    /// implementation could blur the app when backgrounded).
    @objc(setSecureScreen:resolver:rejecter:)
    func setSecureScreen(_ enabled: Bool,
                         resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(nil)
    }
}

// MARK: - Push (task #11, partial)
//
// Permission + token-registration are implemented (JS calls requestPushPermission
// unconditionally at bootstrap, so these MUST exist). FCM/APNs token *delivery*
// via pushTokenReceived still needs the Firebase SDK + AppDelegate wiring — see
// docs/IOS_PARITY.md "Push (#11)". So no token is delivered yet; requestPush
// only reports the permission result honestly.

extension ObscuraBridge {

    @objc(requestPushPermission:rejecter:)
    func requestPushPermission(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                reject("PUSH_PERMISSION_ERROR", error.localizedDescription, error); return
            }
            // Only-on-grant: register for remote notifications so APNs/FCM can
            // later deliver a token (token plumbing lands with #11/Firebase).
            if granted {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
            resolve(granted)
        }
    }

    @objc(registerPushToken:resolver:rejecter:)
    func registerPushToken(_ token: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
        Task {
            do { try await client.registerPushToken(token); resolve(nil) }
            catch { reject("REGISTER_TOKEN_ERROR", error.localizedDescription, error) }
        }
    }
}

// MARK: - Deep linking + debug log (task #12)
//
// appStateChanged is already wired in init() via ObscuraSession.onAppStateChanged.
// Cold-start deep links arrive via getLaunchIntent (consume-once); warm-start taps
// via the launchedFrom event. The deep-link *source* (notification userInfo) is
// wired when push lands (task #11); until then getLaunchIntent returns null.

extension ObscuraBridge {

    /// Returns the cold-start deep-link target once, then nil. Called once on mount.
    @objc(getLaunchIntent:rejecter:)
    func getLaunchIntent(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        if let screen = ObscuraBridge.pendingLaunchScreen {
            ObscuraBridge.pendingLaunchScreen = nil
            resolve(["screen": screen])
        } else {
            resolve(nil)
        }
    }

    @objc(getDebugLog:rejecter:)
    func getDebugLog(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
        resolve(ObscuraSession.shared.logger.recentLines())
    }

    /// Called from AppDelegate when a warm-start deep link arrives (notification
    /// tapped while running). Cold starts use `getLaunchIntent` instead.
    static func deliverLaunchedFrom(_ screen: String) {
        shared?.emit("launchedFrom", ["screen": screen])
    }
}
