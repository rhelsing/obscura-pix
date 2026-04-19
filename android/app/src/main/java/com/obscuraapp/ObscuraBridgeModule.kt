package com.obscuraapp

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.obscura.kit.ObscuraClient
import com.obscura.kit.ObscuraConfig
import com.obscura.kit.ObscuraLogger
import com.obscura.kit.ConnectionState
import com.obscura.kit.AuthState
import com.obscura.kit.ReceivedMessage
import com.obscura.kit.network.LoginScenario
import com.obscura.kit.orm.ModelConfig
import com.obscura.kit.orm.OrmEntry
import com.obscura.kit.stores.FriendData
import com.obscura.kit.stores.FriendStatus
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import org.json.JSONObject

private const val TAG = "ObscuraBridge"
private const val PREFS_NAME = "obscura_session"

class ObscuraBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ObscuraBridge"

    companion object {
        /**
         * Weak reference to the live bridge instance so platform components
         * (FirebaseMessagingService) can reach it without going through the
         * React bridge. Mirrors iOS's `static weak var current` pattern.
         */
        @Volatile
        var current: ObscuraBridgeModule? = null
            private set

        /** Convenience for FCM service — current client or null if not authed. */
        fun currentClient(): ObscuraClient? = current?.client
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var client: ObscuraClient? = null
    private var eventJobs = mutableListOf<Job>()
    private val typingJobs = mutableMapOf<String, Job>()
    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // Logcat logger — all ObscuraKit events visible via `adb logcat -s ObscuraBridge`
    private val logcatLogger = object : ObscuraLogger {
        override fun log(message: String) { Log.d(TAG, message) }
        override fun decryptFailed(sourceUserId: String, reason: String) { Log.w(TAG, "decrypt failed from ${sourceUserId.take(8)}: $reason") }
        override fun ackFailed(envelopeId: String, reason: String) { Log.w(TAG, "ack failed $envelopeId: $reason") }
        override fun tokenRefreshFailed(attempt: Int, reason: String) {
            Log.e(TAG, "token refresh failed (attempt $attempt): $reason")
            // After 5 failures, surface auth failure to JS so it can show login screen
            if (attempt >= 5) {
                sendEvent("ObscuraEvent", Arguments.createMap().apply {
                    putString("type", "authFailed")
                    putString("reason", "Token refresh failed after $attempt attempts")
                })
            }
        }
        override fun preKeyReplenishFailed(reason: String) { Log.w(TAG, "prekey replenish failed: $reason") }
        override fun identityChanged(address: String) { Log.w(TAG, "identity changed: $address") }
        override fun sessionEstablishFailed(userId: String, reason: String) { Log.e(TAG, "session establish failed $userId: $reason") }
        override fun signatureVerificationFailed(sourceUserId: String, messageType: String) { Log.w(TAG, "sig verify failed from $sourceUserId type=$messageType") }
        override fun databaseError(store: String, operation: String, reason: String) { Log.e(TAG, "db error $store.$operation: $reason") }
    }

    init {
        // Make this instance reachable from FirebaseMessagingService
        current = this

        // Try to restore session on module init
        tryRestoreSession()

        // Foreground reconnect
        UiThreadUtil.runOnUiThread {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    val c = client ?: return
                    if (c.authState.value == AuthState.AUTHENTICATED &&
                        c.connectionState.value == ConnectionState.DISCONNECTED) {
                        Log.d(TAG, "App foregrounded — reconnecting")
                        scope.launch {
                            try {
                                c.connect()
                            } catch (e: Exception) {
                                Log.e(TAG, "Foreground reconnect failed: ${e.message}")
                            }
                        }
                    }
                }
            })
        }
    }

    // ─── Session Persistence ────────────────────────────────

    private fun saveSession() {
        val c = client ?: return
        prefs.edit().apply {
            putString("token", c.token)
            putString("refreshToken", c.refreshToken)
            putString("userId", c.userId)
            putString("deviceId", c.deviceId)
            putString("username", c.username)
            putInt("registrationId", c.registrationId)
            apply()
        }
        Log.d(TAG, "Session saved: user=${c.username} device=${c.deviceId?.take(8)}")
    }

    private fun clearSession() {
        prefs.edit().clear().apply()
        Log.d(TAG, "Session cleared")
    }

    private fun tryRestoreSession() {
        val token = prefs.getString("token", null) ?: return
        val userId = prefs.getString("userId", null) ?: return
        val refreshToken = prefs.getString("refreshToken", null)
        val deviceId = prefs.getString("deviceId", null)
        val username = prefs.getString("username", null) ?: return
        val registrationId = prefs.getInt("registrationId", 0)

        Log.d(TAG, "Restoring session: user=$username device=${deviceId?.take(8)}")

        // Create client with the correct per-user database
        val c = createClient(username)
        c.restoreSession(token, refreshToken, userId, deviceId, username, registrationId)

        // Define models from cache + connect in background
        scope.launch {
            try {
                val cached = getCachedSchema()
                if (cached != null) {
                    defineModelsFromJson(c, cached)
                    Log.d(TAG, "Models defined from cache")
                } else {
                    Log.w(TAG, "No cached schema — waiting for JS defineModels()")
                }
                c.ensureFreshToken()
                c.connect()
                saveSession()
                Log.d(TAG, "Session restored and connected")
            } catch (e: Exception) {
                Log.e(TAG, "Session restore connect failed: ${e.message}")
            }
        }
    }

    private suspend fun defineModelsFromJson(c: ObscuraClient, schemaJson: String) {
        val schema = JSONObject(schemaJson)
        val models = mutableMapOf<String, ModelConfig>()
        for (name in schema.keys()) {
            val model = schema.getJSONObject(name)
            val fieldsObj = model.getJSONObject("fields")
            val fields = mutableMapOf<String, String>()
            for (key in fieldsObj.keys()) fields[key] = fieldsObj.getString(key)
            models[name] = ModelConfig(
                fields = fields,
                sync = model.optString("sync", "gset"),
                ttl = model.optString("ttl", null),
                private = model.optBoolean("private", false)
            )
        }
        c.orm.define(models)
    }

    private fun getCachedSchema(): String? =
        prefs.getString("cachedSchema", null)

    private fun cacheSchema(schemaJson: String) {
        prefs.edit().putString("cachedSchema", schemaJson).apply()
    }

    // ─── Client Init ────────────────────────────────────────

    private fun requireClient(): ObscuraClient =
        client ?: throw IllegalStateException("ObscuraClient not initialized — call register or login first")

    /** Tear down current client: cancel observers, disconnect, null out */
    private fun destroyClient() {
        eventJobs.forEach { it.cancel() }
        eventJobs.clear()
        typingJobs.values.forEach { it.cancel() }
        typingJobs.clear()
        try { client?.disconnect() } catch (_: Exception) {}
        client = null
        Log.d(TAG, "Client destroyed")
    }

    /** Create a fresh client with per-user database */
    private fun createClient(username: String): ObscuraClient {
        // Per-user database: obscura_$username.db — isolates data between accounts
        val dbName = "obscura_${username}.db"
        val driver = app.cash.sqldelight.driver.android.AndroidSqliteDriver(
            com.obscura.kit.db.ObscuraDatabase.Schema,
            reactApplicationContext,
            dbName
        )
        val c = ObscuraClient(
            ObscuraConfig(apiUrl = "https://obscura.barrelmaker.dev"),
            externalDriver = driver
        )
        c.logger = logcatLogger
        client = c
        startEventObservation()
        Log.d(TAG, "Client initialized (db=$dbName)")
        return c
    }

    private fun ensureClient(): ObscuraClient {
        return client ?: throw IllegalStateException("No active client — register or login first")
    }

    private fun sendEvent(eventName: String, params: WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(eventName, params)
        } catch (e: Exception) {
            Log.w(TAG, "sendEvent failed (JS not ready?): ${e.message}")
        }
    }

    private fun startEventObservation() {
        val c = client ?: return

        // Friends list changes — send ALL friends with real status
        eventJobs += scope.launch {
            c.friendList.collectLatest { friends ->
                val arr = Arguments.createArray()
                for (f in friends) arr.pushMap(friendToMap(f, f.status.value))
                val params = Arguments.createMap().apply {
                    putString("type", "friendsUpdated")
                    putArray("friends", arr)
                }
                sendEvent("ObscuraEvent", params)
            }
        }

        // Connection state changes
        eventJobs += scope.launch {
            c.connectionState.collectLatest { state ->
                Log.d(TAG, "Connection: $state")
                val params = Arguments.createMap().apply {
                    putString("type", "connectionChanged")
                    putString("state", when (state) {
                        ConnectionState.DISCONNECTED -> "disconnected"
                        ConnectionState.CONNECTING -> "connecting"
                        ConnectionState.CONNECTED -> "connected"
                    })
                }
                sendEvent("ObscuraEvent", params)
                // Re-save session when connected — tokens may have been refreshed
                if (state == ConnectionState.CONNECTED) saveSession()
            }
        }

        // Auth state changes — surface to JS so it can show login screen on auth failure
        eventJobs += scope.launch {
            c.authState.collectLatest { authState ->
                Log.d(TAG, "AuthState: $authState")
                val params = Arguments.createMap().apply {
                    putString("type", "authStateChanged")
                    putString("state", when (authState) {
                        AuthState.LOGGED_OUT -> "loggedOut"
                        AuthState.PENDING_APPROVAL -> "pendingApproval"
                        AuthState.AUTHENTICATED -> "authenticated"
                    })
                }
                sendEvent("ObscuraEvent", params)
            }
        }

        // Incoming messages → RN events
        eventJobs += scope.launch {
            for (msg in c.incomingMessages) {
                Log.d(TAG, "Incoming: ${msg.type} from=${msg.sourceUserId.take(8)}")
                when (msg.type) {
                    "MODEL_SYNC" -> {
                        val params = Arguments.createMap().apply {
                            putString("type", "messageReceived")
                            putString("model", "directMessage")
                            putMap("entry", Arguments.createMap().apply {
                                putString("id", java.util.UUID.randomUUID().toString())
                                putDouble("timestamp", System.currentTimeMillis().toDouble())
                                putString("authorDeviceId", msg.senderDeviceId ?: "")
                                putMap("data", Arguments.createMap().apply {
                                    putString("text", msg.text)
                                    putString("sourceUserId", msg.sourceUserId)
                                })
                            })
                        }
                        sendEvent("ObscuraEvent", params)
                    }
                    // MODEL_SIGNAL typing handled by observeTyping() via SignalManager
                    "MODEL_SIGNAL" -> {}
                    "FRIEND_REQUEST", "FRIEND_RESPONSE" -> {
                        Log.d(TAG, "Friend event: ${msg.type} accepted=${msg.accepted}")
                    }
                }

                // Debug log event
                sendEvent("ObscuraEvent", Arguments.createMap().apply {
                    putString("type", "debugLog")
                    putString("message", "${msg.type}: ${msg.text.take(100)}")
                })
            }
        }
    }

    // ─── Auth ───────────────────────────────────────────────

    @ReactMethod
    fun registerUser(username: String, password: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "register: $username")
                destroyClient()
                val c = createClient(username)
                c.register(username, password)
                saveSession()
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "register failed: ${e.message}")
                promise.reject("REGISTER_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun loginSmart(username: String, password: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "loginSmart: $username")
                destroyClient()
                val c = createClient(username)
                val result = c.login(username, password)
                val scenario = when (result.scenario) {
                    LoginScenario.EXISTING_DEVICE -> "existingDevice"
                    LoginScenario.NEW_DEVICE -> "newDevice"
                    LoginScenario.DEVICE_MISMATCH -> "deviceMismatch"
                    LoginScenario.INVALID_CREDENTIALS -> "invalidCredentials"
                    LoginScenario.USER_NOT_FOUND -> "userNotFound"
                }
                Log.d(TAG, "loginSmart result: $scenario")
                if (result.scenario == LoginScenario.EXISTING_DEVICE) {
                    saveSession()
                }
                promise.resolve(scenario)
            } catch (e: Exception) {
                Log.e(TAG, "loginSmart failed: ${e.message}")
                promise.reject("LOGIN_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun loginAndProvision(username: String, password: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "loginAndProvision: $username")
                destroyClient()
                val c = createClient(username)
                c.loginAndProvision(username, password)
                saveSession()
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "loginAndProvision failed: ${e.message}")
                promise.reject("PROVISION_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun connect(promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "connect")
                val c = requireClient()
                c.ensureFreshToken()
                c.connect()
                saveSession() // persist any refreshed tokens
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "connect failed: ${e.message}")
                promise.reject("CONNECT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun disconnect(promise: Promise) {
        scope.launch {
            try {
                requireClient().disconnect()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("DISCONNECT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun logout(promise: Promise) {
        scope.launch {
            try {
                try { requireClient().logout() } catch (_: Exception) {}
                destroyClient()
                clearSession()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("LOGOUT_ERROR", e.message, e)
            }
        }
    }

    // ─── State ──────────────────────────────────────────────

    @ReactMethod
    fun getConnectionState(promise: Promise) {
        val state = client?.connectionState?.value ?: ConnectionState.DISCONNECTED
        promise.resolve(when (state) {
            ConnectionState.DISCONNECTED -> "disconnected"
            ConnectionState.CONNECTING -> "connecting"
            ConnectionState.CONNECTED -> "connected"
        })
    }

    @ReactMethod
    fun getFriends(promise: Promise) {
        val c = client
        if (c == null) { promise.resolve(Arguments.createArray()); return }
        val arr = Arguments.createArray()
        for (f in c.friendList.value) arr.pushMap(friendToMap(f, f.status.value))
        promise.resolve(arr)
    }

    @ReactMethod
    fun getPendingRequests(promise: Promise) {
        val c = client
        if (c == null) { promise.resolve(Arguments.createArray()); return }
        val arr = Arguments.createArray()
        for (f in c.pendingRequests.value) arr.pushMap(friendToMap(f, "pending_received"))
        promise.resolve(arr)
    }

    @ReactMethod
    fun getAuthState(promise: Promise) {
        val state = client?.authState?.value ?: AuthState.LOGGED_OUT
        promise.resolve(when (state) {
            AuthState.LOGGED_OUT -> "loggedOut"
            AuthState.PENDING_APPROVAL -> "pendingApproval"
            AuthState.AUTHENTICATED -> "authenticated"
        })
    }

    @ReactMethod
    fun getUserId(promise: Promise) {
        promise.resolve(client?.userId)
    }

    @ReactMethod
    fun getUsername(promise: Promise) {
        promise.resolve(client?.username)
    }

    @ReactMethod
    fun getDeviceId(promise: Promise) {
        promise.resolve(client?.deviceId)
    }

    // ─── Friends ────────────────────────────────────────────

    @ReactMethod
    fun befriend(userId: String, username: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "befriend: $username ($userId)")
                requireClient().befriend(userId, username)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "befriend failed: ${e.message}")
                promise.reject("BEFRIEND_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun acceptFriend(userId: String, username: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "acceptFriend: $username ($userId)")
                requireClient().acceptFriend(userId, username)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "acceptFriend failed: ${e.message}")
                promise.reject("ACCEPT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun getFriendCode(promise: Promise) {
        val uid = client?.userId
        val uname = client?.username
        if (uid != null && uname != null) {
            // Format: Base64({"n":"<username>","u":"<userId>"}) — matches iOS FriendCode.swift
            val json = JSONObject().apply { put("n", uname); put("u", uid) }
            val encoded = Base64.encodeToString(json.toString().toByteArray(), Base64.NO_WRAP)
            Log.d(TAG, "getFriendCode: ${encoded.take(20)}...")
            promise.resolve(encoded)
        } else {
            promise.reject("NOT_AUTHED", "Not logged in")
        }
    }

    @ReactMethod
    fun addFriendByCode(code: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "addFriendByCode: ${code.take(20)}...")
                // Strip soft hyphens (U+00AD) that iOS Alert inserts for line wrapping
                val cleaned = code.trim()
                    .replace("\u00AD", "")
                    .replace("\\s".toRegex(), "")

                val bytes = Base64.decode(cleaned, Base64.DEFAULT)
                val decoded = String(bytes)
                Log.d(TAG, "addFriendByCode decoded: $decoded")
                val json = JSONObject(decoded)
                val userId = json.getString("u")
                val username = json.getString("n")
                Log.d(TAG, "addFriendByCode calling befriend($userId, $username)")
                requireClient().befriend(userId, username)
                Log.d(TAG, "addFriendByCode befriend() completed, friendList size=${client?.friendList?.value?.size}")
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "addFriendByCode failed: ${e.message}")
                promise.reject("ADD_FRIEND_ERROR", e.message, e)
            }
        }
    }

    // ─── Device Linking ─────────────────────────────────────

    @ReactMethod
    fun generateLinkCode(promise: Promise) {
        try {
            val code = requireClient().generateLinkCode()
            promise.resolve(code)
        } catch (e: Exception) {
            promise.reject("LINK_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun validateAndApproveLink(code: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().validateAndApproveLink(code)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("APPROVE_ERROR", e.message, e)
            }
        }
    }

    // ─── ORM ────────────────────────────────────────────────

    @ReactMethod
    fun defineModels(schemaJson: String, promise: Promise) {
        scope.launch {
            try {
                val c = requireClient()
                defineModelsFromJson(c, schemaJson)
                cacheSchema(schemaJson)
                Log.d(TAG, "Models defined + cached")
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "defineModels failed: ${e.message}")
                promise.reject("DEFINE_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun createEntry(model: String, dataJson: String, promise: Promise) {
        scope.launch {
            try {
                val data = jsonStringToMap(dataJson)
                val entry = requireClient().orm.model(model).create(data)
                promise.resolve(entryToMap(entry))
            } catch (e: Exception) {
                Log.e(TAG, "createEntry($model) failed: ${e.message}")
                promise.reject("CREATE_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun upsertEntry(model: String, id: String, dataJson: String, promise: Promise) {
        scope.launch {
            try {
                val data = jsonStringToMap(dataJson)
                val entry = requireClient().orm.model(model).upsert(id, data)
                promise.resolve(entryToMap(entry))
            } catch (e: Exception) {
                promise.reject("UPSERT_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun queryEntries(model: String, conditionsJson: String, promise: Promise) {
        scope.launch {
            try {
                val conditions = jsonStringToMap(conditionsJson)
                val entries = requireClient().orm.model(model).where(conditions).exec()
                val arr = Arguments.createArray()
                for (e in entries) arr.pushMap(entryToMap(e))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("QUERY_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun allEntries(model: String, promise: Promise) {
        scope.launch {
            try {
                val entries = requireClient().orm.model(model).all()
                val arr = Arguments.createArray()
                for (e in entries) arr.pushMap(entryToMap(e))
                promise.resolve(arr)
            } catch (e: Exception) {
                promise.reject("ALL_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun deleteEntry(model: String, id: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().orm.model(model).delete(id)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("DELETE_ERROR", e.message, e)
            }
        }
    }

    // ─── Signals ────────────────────────────────────────────

    @ReactMethod
    fun sendTyping(conversationId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().orm.modelOrNull("directMessage")?.typing(conversationId)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("TYPING_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stopTyping(conversationId: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().orm.modelOrNull("directMessage")?.stopTyping(conversationId)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("STOP_TYPING_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun observeTyping(conversationId: String, promise: Promise) {
        if (typingJobs.containsKey(conversationId)) { promise.resolve(null); return }
        val model = client?.orm?.modelOrNull("directMessage")
        if (model == null) { promise.resolve(null); return }

        typingJobs[conversationId] = scope.launch {
            model.observeTyping(conversationId).collectLatest { typers ->
                val arr = Arguments.createArray()
                for (t in typers) arr.pushString(t)
                sendEvent("ObscuraEvent", Arguments.createMap().apply {
                    putString("type", "typingChanged")
                    putString("conversationId", conversationId)
                    putArray("typers", arr)
                })
            }
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopObservingTyping(conversationId: String, promise: Promise) {
        typingJobs.remove(conversationId)?.cancel()
        promise.resolve(null)
    }

    // ─── Attachments ────────────────────────────────────────

    @ReactMethod
    fun uploadAttachment(base64Data: String, promise: Promise) {
        scope.launch {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                // Encrypt locally, upload ciphertext, return ref with key+nonce
                val encrypted = com.obscura.kit.crypto.AttachmentCrypto.encrypt(bytes)
                val (id, _) = requireClient().uploadAttachment(encrypted.ciphertext)
                promise.resolve(Arguments.createMap().apply {
                    putString("id", id)
                    putString("contentKey", Base64.encodeToString(encrypted.contentKey, Base64.NO_WRAP))
                    putString("nonce", Base64.encodeToString(encrypted.nonce, Base64.NO_WRAP))
                })
            } catch (e: Exception) {
                promise.reject("UPLOAD_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun downloadAttachment(id: String, contentKey: String, nonce: String, promise: Promise) {
        scope.launch {
            try {
                val keyBytes = Base64.decode(contentKey, Base64.DEFAULT)
                val nonceBytes = Base64.decode(nonce, Base64.DEFAULT)
                val data = requireClient().downloadDecryptedAttachment(id, keyBytes, nonceBytes)
                promise.resolve(Base64.encodeToString(data, Base64.NO_WRAP))
            } catch (e: Exception) {
                promise.reject("DOWNLOAD_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun sendPhoto(friendUserId: String, base64Data: String, promise: Promise) {
        scope.launch {
            try {
                val c = requireClient()
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val friend = c.friendList.value.find { it.userId == friendUserId }
                if (friend != null) {
                    c.sendEncryptedAttachment(friend.username, bytes, "image/jpeg")
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SEND_PHOTO_ERROR", e.message, e)
            }
        }
    }

    // ─── Debug ──────────────────────────────────────────────

    @ReactMethod
    fun getDebugLog(promise: Promise) {
        val log = client?.debugLog ?: java.util.concurrent.ConcurrentLinkedDeque()
        val arr = Arguments.createArray()
        for (line in log) arr.pushString(line)
        promise.resolve(arr)
    }

    // ─── Helpers ────────────────────────────────────────────

    private fun friendToMap(f: FriendData, status: String): WritableMap =
        Arguments.createMap().apply {
            putString("userId", f.userId)
            putString("username", f.username)
            putString("status", status)
        }

    private fun entryToMap(entry: OrmEntry): WritableMap =
        Arguments.createMap().apply {
            putString("id", entry.id)
            putDouble("timestamp", entry.timestamp.toDouble())
            putString("authorDeviceId", entry.authorDeviceId)
            putMap("data", Arguments.createMap().apply {
                for ((k, v) in entry.data) {
                    when (v) {
                        is String -> putString(k, v)
                        is Number -> putDouble(k, v.toDouble())
                        is Boolean -> putBoolean(k, v)
                        null -> putNull(k)
                        else -> putString(k, v.toString())
                    }
                }
            })
        }

    private fun jsonStringToMap(jsonStr: String): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        try {
            val json = JSONObject(jsonStr)
            for (key in json.keys()) {
                map[key] = when {
                    json.isNull(key) -> null
                    else -> {
                        val v = json.get(key)
                        when (v) {
                            is String -> v
                            is Number -> if (v.toDouble() == v.toLong().toDouble()) v.toLong() else v.toDouble()
                            is Boolean -> v
                            else -> v.toString()
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return map
    }

    // ─── Screen Security ───────────────────────────────────

    @ReactMethod
    fun setSecureScreen(enabled: Boolean, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val window = reactApplicationContext.currentActivity?.window ?: run { promise.resolve(null); return@runOnUiThread }
                if (enabled) {
                    window.setFlags(
                        android.view.WindowManager.LayoutParams.FLAG_SECURE,
                        android.view.WindowManager.LayoutParams.FLAG_SECURE
                    )
                } else {
                    window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE)
                }
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SECURE_ERROR", e.message, e)
            }
        }
    }

    // Required for NativeEventEmitter
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        eventJobs.forEach { it.cancel() }
        scope.cancel()
        if (current === this) current = null
    }

    // ─── Push Notifications ─────────────────────────────────

    /**
     * Request runtime notification permission. Android 13+ (API 33) needs
     * POST_NOTIFICATIONS; earlier versions auto-grant via manifest.
     *
     * Also fetches the FCM token and emits pushTokenReceived to JS when ready.
     */
    @ReactMethod
    fun requestPushPermission(promise: Promise) {
        // Android 13+ runtime permission
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                    activity, android.Manifest.permission.POST_NOTIFICATIONS
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    androidx.core.app.ActivityCompat.requestPermissions(
                        activity,
                        arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                        42
                    )
                    // We don't wait for the dialog result here — the permission state
                    // is observable via the system. JS just needs to know we asked.
                }
            }
        }

        // Fetch FCM token and emit to JS once available.
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnCompleteListener { task ->
                    if (task.isSuccessful) {
                        val token = task.result
                        Log.d(TAG, "FCM token: ${token.take(20)}...")
                        deliverPushToken(token)
                        promise.resolve(true)
                    } else {
                        Log.e(TAG, "FCM token fetch failed: ${task.exception?.message}")
                        promise.reject("TOKEN_ERROR", task.exception?.message ?: "Token fetch failed")
                    }
                }
        } catch (e: Exception) {
            promise.reject("FCM_INIT_ERROR", e.message, e)
        }
    }

    /**
     * Called by JS after receiving pushTokenReceived. Registers the token
     * with the Obscura server so it can send silent pushes to this device.
     */
    @ReactMethod
    fun registerPushToken(token: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().registerPushToken(token)
                Log.d(TAG, "registerPushToken OK")
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "registerPushToken failed: ${e.message}")
                promise.reject("REGISTER_TOKEN_ERROR", e.message, e)
            }
        }
    }

    /**
     * Called by FirebaseMessagingService.onNewToken and by our token fetch.
     * Emits pushTokenReceived event to JS so JS can call registerPushToken().
     */
    fun deliverPushToken(token: String) {
        sendEvent("ObscuraEvent", Arguments.createMap().apply {
            putString("type", "pushTokenReceived")
            putString("token", token)
        })
    }
}
