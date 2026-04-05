import Foundation
import React
import ObscuraKit

/// Native module bridging ObscuraKit to React Native.
/// All methods are async and return via RCTPromise.
@objc(ObscuraBridge)
class ObscuraBridge: RCTEventEmitter {

  private var client: ObscuraClient?
  private var observationTasks: [Task<Void, Never>] = []
  private var typingTasks: [String: Task<Void, Never>] = [:]
  private var debugLog: [String] = []

  private static var dataDir: String {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ObscuraData")
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base.path
  }

  @objc override static func requiresMainQueueSetup() -> Bool { true }

  override func supportedEvents() -> [String]! {
    ["ObscuraEvent"]
  }

  override init() {
    super.init()
    NSLog("[ObscuraBridge] init — attempting session restore")
    tryRestoreSession()
  }

  private func log(_ msg: String) {
    NSLog("[ObscuraBridge] %@", msg)
    debugLog.append("[\(DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium))] \(msg)")
    if debugLog.count > 200 { debugLog.removeFirst() }
  }

  private func emitEvent(_ event: [String: Any]) {
    sendEvent(withName: "ObscuraEvent", body: event)
  }

  // ─── Session Persistence ─────────────────────────────

  private static let sessionKey = "ObscuraBridgeSession"

  private func saveSession() {
    guard let c = client, let token = c.token, let userId = c.userId else { return }
    let data: [String: Any] = [
      "token": token,
      "refreshToken": c.refreshToken ?? "",
      "userId": userId,
      "deviceId": c.deviceId ?? "",
      "username": c.username ?? "",
      "registrationId": c.registrationId ?? 0,
    ]
    UserDefaults.standard.set(data, forKey: Self.sessionKey)
    log("session saved for \(data["username"] ?? "?")")
  }

  private func clearSession() {
    UserDefaults.standard.removeObject(forKey: Self.sessionKey)
    log("session cleared")
  }

  private func tryRestoreSession() {
    guard let saved = UserDefaults.standard.dictionary(forKey: Self.sessionKey),
          let token = saved["token"] as? String, !token.isEmpty,
          let userId = saved["userId"] as? String, !userId.isEmpty else {
      log("no saved session")
      return
    }

    let userDir = Self.dataDir + "/\(userId)"
    guard let c = try? ObscuraClient(apiURL: "https://obscura.barrelmaker.dev",
                                      dataDirectory: userDir, userId: userId) else {
      log("failed to create client for restore")
      return
    }
    self.client = c

    Task {
      let regId = (saved["registrationId"] as? UInt32) ?? UInt32(saved["registrationId"] as? Int ?? 0)
      await c.restoreSession(
        token: token, refreshToken: saved["refreshToken"] as? String,
        userId: userId, deviceId: saved["deviceId"] as? String,
        username: saved["username"] as? String,
        registrationId: regId
      )
      let fresh = await c.ensureFreshToken()
      guard fresh else {
        log("token refresh failed on restore — need re-login")
        self.clearSession()
        self.client = nil
        return
      }
      self.saveSession()
      self.defineModelsFromCache(c)
      do {
        try await c.connect()
        self.setupObservers()
        self.log("session restored and connected")
      } catch {
        self.log("restore connect failed: \(error.localizedDescription)")
      }
    }
  }

  // ─── Schema (JS-driven, cached for cold start) ───────

  private static let schemaKey = "cachedSchema"

  /// Parse schema JSON from JS and define models on the client.
  private func defineModelsFromJson(_ c: ObscuraClient, _ schemaJson: String) throws {
    guard let data = schemaJson.data(using: .utf8),
          let schema = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else {
      throw NSError(domain: "ObscuraBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid schema JSON"])
    }

    var definitions: [ModelDefinition] = []
    for (name, config) in schema {
      let syncStr = config["sync"] as? String ?? "gset"
      let sync: SyncStrategy = syncStr == "lww" ? .lwwMap : .gset
      let isPrivate = config["private"] as? Bool ?? false
      let scope: SyncScope = isPrivate ? .ownDevices : .friends

      var ttl: TTL? = nil
      if let ttlStr = config["ttl"] as? String {
        ttl = parseTTL(ttlStr)
      }

      var fields: [String: FieldType] = [:]
      if let fieldMap = config["fields"] as? [String: String] {
        for (fieldName, fieldType) in fieldMap {
          switch fieldType {
          case "string": fields[fieldName] = .string
          case "number": fields[fieldName] = .number
          case "boolean": fields[fieldName] = .boolean
          case "string?": fields[fieldName] = .optionalString
          case "number?": fields[fieldName] = .optionalNumber
          case "boolean?": fields[fieldName] = .optionalBoolean
          default: fields[fieldName] = .string
          }
        }
      }

      definitions.append(ModelDefinition(name: name, sync: sync, syncScope: scope, ttl: ttl, fields: fields, isPrivate: isPrivate))
    }

    c.schema(definitions)
  }

  private func parseTTL(_ str: String) -> TTL? {
    guard str.count >= 2 else { return nil }
    let unit = str.last!
    guard let value = Int(str.dropLast()) else { return nil }
    switch unit {
    case "s": return .seconds(value)
    case "m": return .minutes(value)
    case "h": return .hours(value)
    case "d": return .days(value)
    default: return nil
    }
  }

  private func cacheSchema(_ schemaJson: String) {
    UserDefaults.standard.set(schemaJson, forKey: Self.schemaKey)
  }

  private func getCachedSchema() -> String? {
    UserDefaults.standard.string(forKey: Self.schemaKey)
  }

  /// Define models from cache for cold-start session restore.
  private func defineModelsFromCache(_ c: ObscuraClient) {
    guard let cached = getCachedSchema() else {
      log("No cached schema — waiting for JS defineModels()")
      return
    }
    do {
      try defineModelsFromJson(c, cached)
      log("models defined from cache")
    } catch {
      log("cached schema invalid: \(error.localizedDescription)")
    }
  }

  // ─── Event Polling (JS calls this to get queued events) ──

  // pollEvents removed — all events are push via RCTEventEmitter.sendEvent

  // ─── Auth ────────────────────────────────────────────

  @objc func registerUser(_ username: String, password: String,
                       resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        // Clean up any existing session first
        if self.client != nil {
          self.log("register: cleaning up previous session")
          self.teardownObservers()
          self.client?.disconnect()
          self.client = nil
        }

        // Phase 1: API-only register to get userId
        let creds = try await ObscuraClient.registerAccount(username, password)
        guard !creds.userId.isEmpty else { reject("E", "no userId", nil); return }

        // Phase 2: Create file-backed client with encrypted DB
        let userDir = Self.dataDir + "/\(creds.userId)"
        let c = try ObscuraClient(apiURL: "https://obscura.barrelmaker.dev",
                                   dataDirectory: userDir, userId: creds.userId)
        await c.restoreSession(token: creds.token, refreshToken: creds.refreshToken,
                               userId: creds.userId, deviceId: nil, username: username)
        try await c.provisionCurrentDevice()
        self.client = c
        // Models defined by JS calling defineModels(schema) after register
        self.saveSession()
        self.setupObservers()
        self.log("registered \(username)")
        resolve(nil)
      } catch {
        self.log("register error: \(error.localizedDescription)")
        reject("register_error", error.localizedDescription, error)
      }
    }
  }

  @objc func loginSmart(_ username: String, password: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        // Clean up any existing session first
        if self.client != nil {
          self.log("loginSmart: cleaning up previous session")
          self.teardownObservers()
          self.client?.disconnect()
          self.client = nil
        }

        let shellCreds = try await ObscuraClient.loginAccount(username, password)
        guard !shellCreds.userId.isEmpty else { reject("E", "no userId", nil); return }

        let userDir = Self.dataDir + "/\(shellCreds.userId)"
        let c = try ObscuraClient(apiURL: "https://obscura.barrelmaker.dev",
                                   dataDirectory: userDir, userId: shellCreds.userId)
        self.client = c
        let scenario = try await c.loginSmart(username, password)
        // Models defined by JS calling defineModels(schema) after login
        self.saveSession()
        self.setupObservers()
        self.log("login: \(scenario)")

        switch scenario {
        case .existingDevice: resolve("existingDevice")
        case .newDevice: resolve("newDevice")
        case .onlyDevice: resolve("onlyDevice")
        case .deviceMismatch: resolve("deviceMismatch")
        case .invalidCredentials: resolve("invalidCredentials")
        case .userNotFound: resolve("userNotFound")
        }
      } catch {
        reject("login_error", error.localizedDescription, error)
      }
    }
  }

  @objc func loginAndProvision(_ username: String, password: String,
                                 resolve: @escaping RCTPromiseResolveBlock,
                                 reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        log("loginAndProvision \(username)")
        try await client!.loginAndProvision(username, password)
        self.saveSession()
        log("provisioned OK")
        resolve(nil)
      } catch {
        log("provision error: \(error.localizedDescription)")
        reject("provision_error", error.localizedDescription, error)
      }
    }
  }

  @objc func connect(_ resolve: @escaping RCTPromiseResolveBlock,
                      reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        log("connecting...")
        let fresh = await client!.ensureFreshToken()
        log("token fresh: \(fresh)")
        guard fresh else {
          log("connect aborted — token refresh failed")
          reject("connect_error", "Token refresh failed — re-login required", nil)
          self.emitEvent(["type": "authFailed", "reason": "token refresh failed"])
          return
        }
        try await client!.connect()
        log("connected")
        self.emitEvent(["type": "connectionChanged", "state": "connected"])
        self.emitEvent(["type": "authStateChanged", "state": "authenticated"])
        self.saveSession()
        resolve(nil)
      } catch {
        log("connect error: \(error.localizedDescription)")
        self.emitEvent(["type": "connectionChanged", "state": "disconnected"])
        reject("connect_error", error.localizedDescription, error)
      }
    }
  }

  @objc func disconnect(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    log("disconnecting")
    client?.disconnect()
    emitEvent(["type": "connectionChanged", "state": "disconnected"])
    resolve(nil)
  }

  @objc func logout(_ resolve: @escaping RCTPromiseResolveBlock,
                     reject: @escaping RCTPromiseRejectBlock) {
    Task {
      log("logout — full cleanup")
      teardownObservers()
      typingTasks.values.forEach { $0.cancel() }
      typingTasks.removeAll()
      client?.disconnect()
      try? await client?.logout()
      client = nil
      clearSession()
      debugLog.removeAll()
      self.emitEvent(["type": "connectionChanged", "state": "disconnected"])
      self.emitEvent(["type": "authStateChanged", "state": "loggedOut"])
      log("logged out")
      resolve(nil)
    }
  }

  // ─── State ───────────────────────────────────────────

  @objc func getConnectionState(_ resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    resolve(client?.connectionState.rawValue ?? "disconnected")
  }

  @objc func getAuthState(_ resolve: @escaping RCTPromiseResolveBlock,
                            reject: @escaping RCTPromiseRejectBlock) {
    resolve(client?.authState.rawValue ?? "loggedOut")
  }

  @objc func getUserId(_ resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    resolve(client?.userId)
  }

  @objc func getUsername(_ resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    resolve(client?.username)
  }

  @objc func getDeviceId(_ resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    resolve(client?.deviceId)
  }

  // ─── Friends ─────────────────────────────────────────

  @objc func befriend(_ userId: String, username: String,
                       resolve: @escaping RCTPromiseResolveBlock,
                       reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        log("befriend \(username) (\(userId.prefix(8))...)")
        try await client!.befriend(userId, username: username)
        log("befriend OK")
        resolve(nil)
      } catch {
        log("befriend error: \(error.localizedDescription)")
        reject("befriend_error", error.localizedDescription, error)
      }
    }
  }

  @objc func acceptFriend(_ userId: String, username: String,
                            resolve: @escaping RCTPromiseResolveBlock,
                            reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        log("acceptFriend \(username)")
        try await client!.acceptFriend(userId, username: username)
        log("acceptFriend OK")
        resolve(nil)
      } catch {
        log("acceptFriend error: \(error.localizedDescription)")
        reject("accept_error", error.localizedDescription, error)
      }
    }
  }

  @objc func getFriends(_ resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    Task {
      guard let c = client else { resolve([]); return }
      // Return ALL friends with real status — JS filters by status
      let all = await c.friends.getAll()
      resolve(all.map { f -> [String: Any] in
        ["userId": f.userId, "username": f.username, "status": f.status.rawValue]
      })
    }
  }

  @objc func getPendingRequests(_ resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    Task {
      guard let c = client else { resolve([]); return }
      // Return all non-accepted for backwards compat
      let all = await c.friends.getAll()
      let pending = all.filter { $0.status != .accepted }
      resolve(pending.map { f -> [String: Any] in
        ["userId": f.userId, "username": f.username, "status": f.status.rawValue]
      })
    }
  }

  @objc func getFriendCode(_ resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {
    guard let userId = client?.userId, let username = client?.username else {
      resolve("")
      return
    }
    resolve(FriendCode.encode(userId: userId, username: username))
  }

  @objc func addFriendByCode(_ code: String,
                               resolve: @escaping RCTPromiseResolveBlock,
                               reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        // Strip soft hyphens iOS might insert
        let cleaned = code.replacingOccurrences(of: "\u{00AD}", with: "")
        log("addFriendByCode: \(cleaned.prefix(20))...")
        let decoded = try FriendCode.decode(cleaned)
        log("decoded: \(decoded.username) (\(decoded.userId.prefix(8))...)")
        try await client!.befriend(decoded.userId, username: decoded.username)
        log("addFriendByCode OK")
        resolve(nil)
      } catch {
        log("addFriendByCode error: \(error.localizedDescription)")
        reject("add_friend_error", error.localizedDescription, error)
      }
    }
  }

  // ─── Device Linking ──────────────────────────────────

  @objc func generateLinkCode(_ resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    resolve(client?.generateLinkCode() ?? "")
  }

  @objc func validateAndApproveLink(_ code: String,
                                      resolve: @escaping RCTPromiseResolveBlock,
                                      reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        try await client!.validateAndApproveLink(code)
        resolve(nil)
      } catch {
        reject("link_error", error.localizedDescription, error)
      }
    }
  }

  // ─── ORM ─────────────────────────────────────────────

  @objc func defineModels(_ schemaJson: String,
                            resolve: @escaping RCTPromiseResolveBlock,
                            reject: @escaping RCTPromiseRejectBlock) {
    guard let c = client else { reject("E", "no client", nil); return }
    do {
      try defineModelsFromJson(c, schemaJson)
      cacheSchema(schemaJson)
      log("models defined from JS schema")
      resolve(nil)
    } catch {
      log("defineModels error: \(error.localizedDescription)")
      reject("define_error", error.localizedDescription, error)
    }
  }

  @objc func createEntry(_ model: String, dataJson: String,
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = parseJson(dataJson), let m = client?.model(model) else {
          log("createEntry FAIL: invalid model '\(model)' or bad json")
          reject("E", "invalid model or data", nil); return
        }
        log("createEntry \(model)")
        let entry = try await m.create(data)
        log("createEntry OK: \(entry.id.prefix(20))")
        resolve(entryToDict(entry))
      } catch {
        log("createEntry error: \(error.localizedDescription)")
        reject("create_error", error.localizedDescription, error)
      }
    }
  }

  @objc func upsertEntry(_ model: String, id: String, dataJson: String,
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = parseJson(dataJson), let m = client?.model(model) else {
          log("upsertEntry FAIL: invalid model '\(model)'")
          reject("E", "invalid model or data", nil); return
        }
        log("upsertEntry \(model)/\(id.prefix(16))")
        let entry = try await m.upsert(id, data)
        log("upsertEntry OK")
        resolve(entryToDict(entry))
      } catch {
        log("upsertEntry error: \(error.localizedDescription)")
        reject("upsert_error", error.localizedDescription, error)
      }
    }
  }

  @objc func queryEntries(_ model: String, conditionsJson: String,
                            resolve: @escaping RCTPromiseResolveBlock,
                            reject: @escaping RCTPromiseRejectBlock) {
    Task {
      guard let conditions = parseJson(conditionsJson), let m = client?.model(model) else {
        resolve([]); return
      }
      let entries = await m.where(conditions).exec()
      resolve(entries.map { entryToDict($0) })
    }
  }

  @objc func allEntries(_ model: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    Task {
      guard let m = client?.model(model) else { resolve([]); return }
      let entries = await m.all()
      resolve(entries.map { entryToDict($0) })
    }
  }

  @objc func deleteEntry(_ model: String, id: String,
                           resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        _ = try await client?.model(model)?.delete(id)
        resolve(nil)
      } catch {
        reject("delete_error", error.localizedDescription, error)
      }
    }
  }

  // ─── Signals ─────────────────────────────────────────

  @objc func sendTyping(_ conversationId: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    Task {
      if let m = client?.model("directMessage") {
        let typed = TypedModel<DirectMessageModel>(model: m)
        await typed.typing(conversationId: conversationId)
      }
      resolve(nil)
    }
  }

  @objc func stopTyping(_ conversationId: String,
                          resolve: @escaping RCTPromiseResolveBlock,
                          reject: @escaping RCTPromiseRejectBlock) {
    Task {
      if let m = client?.model("directMessage") {
        let typed = TypedModel<DirectMessageModel>(model: m)
        await typed.stopTyping(conversationId: conversationId)
      }
      resolve(nil)
    }
  }

  @objc func observeTyping(_ conversationId: String,
                             resolve: @escaping RCTPromiseResolveBlock,
                             reject: @escaping RCTPromiseRejectBlock) {
    // Don't double-subscribe
    guard typingTasks[conversationId] == nil else { resolve(nil); return }
    guard let m = client?.model("directMessage") else { resolve(nil); return }

    let typed = TypedModel<DirectMessageModel>(model: m)
    typingTasks[conversationId] = Task {
      for await typers in typed.observeTyping(conversationId: conversationId).values {
        self.emitEvent([
          "type": "typingChanged",
          "conversationId": conversationId,
          "typers": typers
        ])
      }
    }
    resolve(nil)
  }

  @objc func stopObservingTyping(_ conversationId: String,
                                   resolve: @escaping RCTPromiseResolveBlock,
                                   reject: @escaping RCTPromiseRejectBlock) {
    typingTasks[conversationId]?.cancel()
    typingTasks.removeValue(forKey: conversationId)
    resolve(nil)
  }

  // ─── Attachments ─────────────────────────────────────

  @objc func uploadAttachment(_ base64Data: String,
                                resolve: @escaping RCTPromiseResolveBlock,
                                reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = Data(base64Encoded: base64Data) else {
          reject("E", "invalid base64", nil); return
        }
        let encrypted = try AttachmentCrypto.encrypt(data)
        let result = try await client!.api.uploadAttachment(encrypted.ciphertext)
        await rateLimitDelay()
        resolve([
          "id": result.id,
          "contentKey": encrypted.contentKey.base64EncodedString(),
          "nonce": encrypted.nonce.base64EncodedString(),
        ])
      } catch {
        reject("upload_error", error.localizedDescription, error)
      }
    }
  }

  @objc func downloadAttachment(_ id: String, contentKey: String, nonce: String,
                                  resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        let plaintext = try await client!.downloadDecryptedAttachment(
          id: id,
          contentKey: Data(base64Encoded: contentKey)!,
          nonce: Data(base64Encoded: nonce)!
        )
        resolve(plaintext.base64EncodedString())
      } catch {
        reject("download_error", error.localizedDescription, error)
      }
    }
  }

  @objc func sendPhoto(_ friendUserId: String, base64Data: String,
                         resolve: @escaping RCTPromiseResolveBlock,
                         reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        guard let data = Data(base64Encoded: base64Data) else {
          reject("E", "invalid base64", nil); return
        }
        try await client!.sendEncryptedAttachment(to: friendUserId, plaintext: data)
        resolve(nil)
      } catch {
        reject("send_photo_error", error.localizedDescription, error)
      }
    }
  }

  // ─── Debug ───────────────────────────────────────────

  @objc func getDebugLog(_ resolve: @escaping RCTPromiseResolveBlock,
                           reject: @escaping RCTPromiseRejectBlock) {
    resolve(debugLog)
  }

  // ─── Observation (queue events for JS polling) ───────

  private func setupObservers() {
    teardownObservers()
    guard let c = client else { return }

    // Friends — emit ALL friends with real status. JS splits by status.
    observationTasks.append(Task {
      for await allFriends in c.friends.observeAll().values {
        let list = allFriends.map { f -> [String: Any] in
          ["userId": f.userId, "username": f.username, "status": f.status.rawValue]
        }
        self.emitEvent(["type": "friendsUpdated", "friends": list])
        self.log("friendsUpdated: \(allFriends.count) total")
      }
    })

    // ORM model changes (via events stream)
    observationTasks.append(Task {
      for await event in c.events() {
        if event.type == 30 { // MODEL_SYNC
          self.emitEvent(["type": "messageReceived", "model": "unknown"])
        } else if event.type == 31 { // MODEL_SIGNAL
          self.emitEvent(["type": "signalReceived"])
        }
      }
    })

    // Connection state — push via ObscuraKit's observeConnectionState()
    observationTasks.append(Task {
      for await state in c.observeConnectionState() {
        self.emitEvent(["type": "connectionChanged", "state": state.rawValue])
        self.log("connection: \(state.rawValue)")
        if state == .connected { self.saveSession() }
      }
    })

    // Auth state — push via ObscuraKit's observeAuthState()
    observationTasks.append(Task {
      for await state in c.observeAuthState() {
        self.emitEvent(["type": "authStateChanged", "state": state.rawValue])
        self.log("auth: \(state.rawValue)")
        if state == .loggedOut {
          self.emitEvent(["type": "authFailed"])
        }
      }
    })
  }

  private func teardownObservers() {
    observationTasks.forEach { $0.cancel() }
    observationTasks.removeAll()
  }

  // ─── Helpers ─────────────────────────────────────────

  private func parseJson(_ json: String) -> [String: Any]? {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return obj
  }

  private func entryToDict(_ entry: ModelEntry) -> [String: Any] {
    ["id": entry.id, "data": entry.data, "timestamp": entry.timestamp, "authorDeviceId": entry.authorDeviceId]
  }
}

// Minimal SyncModel for typing signals
struct DirectMessageModel: SyncModel {
  static let modelName = "directMessage"
  static let sync: SyncStrategy = .gset
  var conversationId: String
  var content: String
  var senderUsername: String
}
