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

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var client: ObscuraClient? = null
    private var eventJobs = mutableListOf<Job>()
    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)


    // Logcat logger — all ObscuraKit events visible via `adb logcat -s ObscuraBridge`
    private val logcatLogger = object : ObscuraLogger {
        override fun log(message: String) { Log.d(TAG, message) }
        override fun decryptFailed(sourceUserId: String, reason: String) { Log.w(TAG, "decrypt failed from ${sourceUserId.take(8)}: $reason") }
        override fun ackFailed(envelopeId: String, reason: String) { Log.w(TAG, "ack failed $envelopeId: $reason") }
        override fun tokenRefreshFailed(attempt: Int, reason: String) { Log.e(TAG, "token refresh failed (attempt $attempt): $reason") }
        override fun preKeyReplenishFailed(reason: String) { Log.w(TAG, "prekey replenish failed: $reason") }
        override fun identityChanged(address: String) { Log.w(TAG, "identity changed: $address") }
        override fun sessionEstablishFailed(userId: String, reason: String) { Log.e(TAG, "session establish failed $userId: $reason") }
        override fun signatureVerificationFailed(sourceUserId: String, messageType: String) { Log.w(TAG, "sig verify failed from $sourceUserId type=$messageType") }
        override fun databaseError(store: String, operation: String, reason: String) { Log.e(TAG, "db error $store.$operation: $reason") }
    }

    init {
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
        val username = prefs.getString("username", null)
        val registrationId = prefs.getInt("registrationId", 0)

        Log.d(TAG, "Restoring session: user=$username device=${deviceId?.take(8)}")

        val c = ensureClient()
        c.restoreSession(token, refreshToken, userId, deviceId, username, registrationId)

        // Define models + connect in background
        scope.launch {
            try {
                defineModelsInternal(c)
                c.connect()
                Log.d(TAG, "Session restored and connected")
            } catch (e: Exception) {
                Log.e(TAG, "Session restore connect failed: ${e.message}")
            }
        }
    }

    private suspend fun defineModelsInternal(c: ObscuraClient) {
        c.orm.define(mapOf(
            "directMessage" to ModelConfig(
                fields = mapOf(
                    "conversationId" to "string",
                    "content" to "string",
                    "senderUsername" to "string"
                ),
                sync = "gset"
            ),
            "story" to ModelConfig(
                fields = mapOf(
                    "content" to "string",
                    "authorUsername" to "string"
                ),
                sync = "gset",
                ttl = "24h"
            ),
            "profile" to ModelConfig(
                fields = mapOf(
                    "displayName" to "string",
                    "avatarUrl" to "string",
                    "bio" to "string"
                ),
                sync = "lww"
            ),
            "settings" to ModelConfig(
                fields = mapOf(
                    "theme" to "string",
                    "notificationsEnabled" to "boolean"
                ),
                sync = "lww",
                private = true
            )
        ))
    }

    // ─── Client Init ────────────────────────────────────────

    private fun requireClient(): ObscuraClient =
        client ?: throw IllegalStateException("ObscuraClient not initialized — call register or login first")

    private fun ensureClient(): ObscuraClient {
        if (client == null) {
            val driver = app.cash.sqldelight.driver.android.AndroidSqliteDriver(
                com.obscura.kit.db.ObscuraDatabase.Schema,
                reactApplicationContext,
                "obscura.db"
            )
            val c = ObscuraClient(
                ObscuraConfig(apiUrl = "https://obscura.barrelmaker.dev"),
                externalDriver = driver
            )
            c.logger = logcatLogger
            client = c
            startEventObservation()
            Log.d(TAG, "Client initialized")
        }
        return client!!
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

        // Pending requests changes
        eventJobs += scope.launch {
            c.pendingRequests.collectLatest { pending ->
                val arr = Arguments.createArray()
                for (f in pending) arr.pushMap(friendToMap(f, "pending_received"))
                val params = Arguments.createMap().apply {
                    putString("type", "pendingUpdated")
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
                                putString("id", msg.sourceUserId)
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
                    "MODEL_SIGNAL" -> {
                        if (msg.text.isNotBlank()) {
                            try {
                                val json = JSONObject(msg.text)
                                val signal = json.optString("signal", "")
                                val data = json.optJSONObject("data")
                                val convId = data?.optString("conversationId", "") ?: ""
                                val authorDevice = json.optString("authorDeviceId", "")
                                if (signal == "typing") {
                                    sendEvent("ObscuraEvent", Arguments.createMap().apply {
                                        putString("type", "typingStarted")
                                        putString("conversationId", convId)
                                        putString("authorDeviceId", authorDevice)
                                    })
                                } else if (signal == "stoppedTyping") {
                                    sendEvent("ObscuraEvent", Arguments.createMap().apply {
                                        putString("type", "typingStopped")
                                        putString("conversationId", convId)
                                    })
                                }
                            } catch (_: Exception) {}
                        }
                    }
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
                val c = ensureClient()
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
                val c = ensureClient()
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
                val c = ensureClient()
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
                requireClient().connect()
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
                requireClient().logout()
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
    fun defineModels(promise: Promise) {
        scope.launch {
            try {
                val c = ensureClient()
                defineModelsInternal(c)
                Log.d(TAG, "Models defined")
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

    // ─── Attachments ────────────────────────────────────────

    @ReactMethod
    fun uploadAttachment(base64Data: String, promise: Promise) {
        scope.launch {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
                val (id, _) = requireClient().uploadAttachment(bytes)
                promise.resolve(Arguments.createMap().apply { putString("id", id) })
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
    }
}
