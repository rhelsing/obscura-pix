import Foundation
import React
import ObscuraKit

/// Thin native module — all logic lives in ObscuraKit.
/// The bridge just relays calls and events between JS and the kit.
@objc(ObscuraBridge)
class ObscuraBridge: RCTEventEmitter {

  private var client: ObscuraClient?
  private var eventTask: Task<Void, Never>?
  private var typingTasks: [String: Task<Void, Never>] = [:]
  private var debugLog: [String] = []

  private static var baseDir: String {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ObscuraData")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.path
  }

  @objc override static func requiresMainQueueSetup() -> Bool { true }
  override func supportedEvents() -> [String]! { ["ObscuraEvent"] }

  override init() {
    super.init()
    tryRestore()
  }

  private func log(_ msg: String) {
    NSLog("[ObscuraBridge] %@", msg)
    debugLog.append("[\(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))] \(msg)")
    if debugLog.count > 200 { debugLog.removeFirst() }
  }

  private func emit(_ body: [String: Any]) {
    sendEvent(withName: "ObscuraEvent", body: body)
  }

  private func makeClient(userId: String) throws -> ObscuraClient {
    let dir = Self.baseDir + "/\(userId)"
    let c = try ObscuraClient(apiURL: "https://obscura.barrelmaker.dev",
                                dataDirectory: dir, userId: userId)
    c.sessionStorage = UserDefaultsSessionStorage()
    return c
  }

  private func requireClient() throws -> ObscuraClient {
    guard let c = client else { throw NSError(domain: "ObscuraBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "Not logged in"]) }
    return c
  }

  private func startEvents() {
    eventTask?.cancel()
    guard let c = client else { return }
    eventTask = Task {
      for await event in c.observeEvents() {
        switch event {
        case .friendsUpdated(let friends):
          self.emit(["type": "friendsUpdated", "friends": friends.map {
            ["userId": $0.userId, "username": $0.username, "status": $0.status.rawValue] as [String: Any]
          }])
        case .connectionChanged(let state):
          self.emit(["type": "connectionChanged", "state": state.rawValue])
        case .authChanged(let state):
          self.emit(["type": "authStateChanged", "state": state.rawValue])
          if state == .loggedOut { self.emit(["type": "authFailed"]) }
        case .messageReceived(let model, _):
          self.emit(["type": "messageReceived", "model": model])
        case .typingChanged(let convId, let typers):
          self.emit(["type": "typingChanged", "conversationId": convId, "typers": typers])
        case .debugLog(let msg):
          self.log(msg)
        }
      }
    }
  }

  private func cleanup() {
    eventTask?.cancel(); eventTask = nil
    typingTasks.values.forEach { $0.cancel() }; typingTasks.removeAll()
  }

  private func tryRestore() {
    guard let saved = UserDefaultsSessionStorage().load(),
          let userId = saved["userId"] as? String, !userId.isEmpty else {
      log("no saved session"); return
    }
    guard let c = try? makeClient(userId: userId) else { log("makeClient failed"); return }
    self.client = c
    Task {
      do { try await c.restorePersistedSession(); startEvents(); log("session restored") }
      catch { log("restore failed: \(error.localizedDescription)"); self.client = nil }
    }
  }

  // ─── Auth ──────────────────────────────────────────────

  @objc func registerUser(_ username: String, password: String,
                           resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        cleanup()
        let creds = try await ObscuraClient.registerAccount(username, password)
        let c = try makeClient(userId: creds.userId)
        await c.restoreSession(token: creds.token, refreshToken: creds.refreshToken,
                               userId: creds.userId, deviceId: nil, username: username)
        try await c.provisionCurrentDevice()
        self.client = c; startEvents(); log("registered \(username)"); resolve(nil)
      } catch { reject("E", error.localizedDescription, error) }
    }
  }

  @objc func loginSmart(_ username: String, password: String,
                          resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        cleanup()
        let creds = try await ObscuraClient.loginAccount(username, password)
        let c = try makeClient(userId: creds.userId)
        self.client = c
        let scenario = try await c.loginSmart(username, password)
        startEvents()
        switch scenario {
        case .existingDevice: resolve("existingDevice")
        case .newDevice: resolve("newDevice")
        case .onlyDevice: resolve("onlyDevice")
        case .deviceMismatch: resolve("deviceMismatch")
        case .invalidCredentials: resolve("invalidCredentials")
        case .userNotFound: resolve("userNotFound")
        }
      } catch { reject("E", error.localizedDescription, error) }
    }
  }

  @objc func loginAndProvision(_ username: String, password: String,
                                 resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        try await requireClient().loginAndProvision(username, password); resolve(nil)
      } catch { reject("E", error.localizedDescription, error) }
    }
  }

  @objc func connect(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do { try await try requireClient().connect(); resolve(nil) }
      catch { reject("E", error.localizedDescription, error) }
    }
  }

  @objc func disconnect(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    client?.disconnect(); resolve(nil)
  }

  @objc func logout(_ resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { cleanup(); await client?.fullLogout(); client = nil; resolve(nil) }
  }

  // ─── State ─────────────────────────────────────────────

  @objc func getConnectionState(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.connectionState.rawValue ?? "disconnected") }
  @objc func getAuthState(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.authState.rawValue ?? "loggedOut") }
  @objc func getUserId(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.userId) }
  @objc func getUsername(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.username) }
  @objc func getDeviceId(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.deviceId) }

  // ─── Friends ───────────────────────────────────────────

  @objc func befriend(_ userId: String, username: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { do { try await try requireClient().befriend(userId, username: username); resolve(nil) } catch { reject("E", error.localizedDescription, error) } }
  }
  @objc func acceptFriend(_ userId: String, username: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { do { try await try requireClient().acceptFriend(userId, username: username); resolve(nil) } catch { reject("E", error.localizedDescription, error) } }
  }
  @objc func getFriends(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { let all = await client?.friends.getAll() ?? []; r(all.map { ["userId": $0.userId, "username": $0.username, "status": $0.status.rawValue] }) }
  }
  @objc func getPendingRequests(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { let all = await client?.friends.getAll() ?? []; r(all.filter { $0.status != .accepted }.map { ["userId": $0.userId, "username": $0.username, "status": $0.status.rawValue] }) }
  }
  @objc func getFriendCode(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.friendCode() ?? "") }
  @objc func addFriendByCode(_ code: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { do { try await try requireClient().addFriendByCode(code); resolve(nil) } catch { reject("E", error.localizedDescription, error) } }
  }

  // ─── Device Linking ────────────────────────────────────

  @objc func generateLinkCode(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(client?.generateLinkCode() ?? "") }
  @objc func validateAndApproveLink(_ code: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { do { try await try requireClient().validateAndApproveLink(code); resolve(nil) } catch { reject("E", error.localizedDescription, error) } }
  }

  // ─── ORM ───────────────────────────────────────────────

  @objc func defineModels(_ schemaJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    do { try try requireClient().defineModelsFromJson(schemaJson); resolve(nil) } catch { reject("E", error.localizedDescription, error) }
  }
  @objc func createEntry(_ model: String, dataJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = pj(dataJson), let m = client?.model(model) else { reject("E", "invalid", nil); return }
        let e = try await m.create(data); resolve(["id": e.id, "data": e.data, "timestamp": e.timestamp, "authorDeviceId": e.authorDeviceId])
      } catch { reject("E", error.localizedDescription, error) }
    }
  }
  @objc func upsertEntry(_ model: String, id: String, dataJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = pj(dataJson), let m = client?.model(model) else { reject("E", "invalid", nil); return }
        let e = try await m.upsert(id, data); resolve(["id": e.id, "data": e.data, "timestamp": e.timestamp, "authorDeviceId": e.authorDeviceId])
      } catch { reject("E", error.localizedDescription, error) }
    }
  }
  @objc func queryEntries(_ model: String, conditionsJson: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      guard let c = pj(conditionsJson), let m = client?.model(model) else { reject("E", "invalid", nil); return }
      let entries = await m.where(c).exec()
      resolve(entries.map { ["id": $0.id, "data": $0.data, "timestamp": $0.timestamp, "authorDeviceId": $0.authorDeviceId] })
    }
  }
  @objc func allEntries(_ model: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      guard let m = client?.model(model) else { reject("E", "Model '\(model)' not defined", nil); return }
      resolve((await m.all()).map { ["id": $0.id, "data": $0.data, "timestamp": $0.timestamp, "authorDeviceId": $0.authorDeviceId] })
    }
  }
  @objc func deleteEntry(_ model: String, id: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { do { _ = try await client?.model(model)?.delete(id); resolve(nil) } catch { reject("E", error.localizedDescription, error) } }
  }

  // ─── Signals ───────────────────────────────────────────

  @objc func sendTyping(_ convId: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { if let m = client?.model("directMessage") { await TypedModel<DMModel>(model: m).typing(conversationId: convId) }; resolve(nil) }
  }
  @objc func stopTyping(_ convId: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task { if let m = client?.model("directMessage") { await TypedModel<DMModel>(model: m).stopTyping(conversationId: convId) }; resolve(nil) }
  }
  @objc func observeTyping(_ convId: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    guard typingTasks[convId] == nil, let m = client?.model("directMessage") else { resolve(nil); return }
    typingTasks[convId] = Task {
      for await typers in TypedModel<DMModel>(model: m).observeTyping(conversationId: convId).values {
        self.emit(["type": "typingChanged", "conversationId": convId, "typers": typers])
      }
    }
    resolve(nil)
  }
  @objc func stopObservingTyping(_ convId: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    typingTasks[convId]?.cancel(); typingTasks.removeValue(forKey: convId); resolve(nil)
  }

  // ─── Attachments ───────────────────────────────────────

  @objc func uploadAttachment(_ b64: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = Data(base64Encoded: b64) else { reject("E", "bad base64", nil); return }
        let enc = try AttachmentCrypto.encrypt(data)
        let r = try await try requireClient().api.uploadAttachment(enc.ciphertext)
        resolve(["id": r.id, "contentKey": enc.contentKey.base64EncodedString(), "nonce": enc.nonce.base64EncodedString()])
      } catch { reject("E", error.localizedDescription, error) }
    }
  }
  @objc func downloadAttachment(_ id: String, contentKey: String, nonce: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do { resolve(try await try requireClient().downloadDecryptedAttachment(id: id, contentKey: Data(base64Encoded: contentKey)!, nonce: Data(base64Encoded: nonce)!).base64EncodedString()) }
      catch { reject("E", error.localizedDescription, error) }
    }
  }
  @objc func sendPhoto(_ friendUserId: String, base64Data: String, resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = Data(base64Encoded: base64Data) else { reject("E", "bad base64", nil); return }
        try await try requireClient().sendEncryptedAttachment(to: friendUserId, plaintext: data); resolve(nil)
      } catch { reject("E", error.localizedDescription, error) }
    }
  }

  // ─── Debug ─────────────────────────────────────────────

  @objc func getDebugLog(_ r: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock) { r(debugLog) }

  private func pj(_ json: String) -> [String: Any]? {
    guard let d = json.data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
  }
}

struct DMModel: SyncModel {
  static let modelName = "directMessage"
  static let sync: SyncStrategy = .gset
  var conversationId: String; var content: String; var senderUsername: String
}
