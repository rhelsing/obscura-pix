package com.obscuraapp

import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.obscura.kit.AuthState
import com.obscura.kit.ConnectionState
import com.obscura.kit.ObscuraClient
import com.obscura.kit.ReceivedMessage
import com.obscura.kit.network.LoginScenario
import com.obscura.kit.orm.OrmEntry
import com.obscura.kit.stores.FriendData
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import org.json.JSONObject

private const val TAG = "ObscuraBridge"

/**
 * Thin React Native bridge. Owns NO Obscura state — all client lifecycle,
 * message dispatch, foreground tracking and notification posting lives in
 * [ObscuraSession]. This class:
 *
 *   - Registers itself as the session's [ObscuraSession.EventSink] so events
 *     reach JS
 *   - Translates @ReactMethod RPCs into kit calls on `ObscuraSession.client`
 *   - Marshals between RN [WritableMap]/Promise and Kotlin types
 *
 * If you need to mutate session state (create/destroy client, save prefs),
 * call into [ObscuraSession] — do NOT keep a local copy of anything.
 */
class ObscuraBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ObscuraBridge"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val typingJobs = mutableMapOf<String, Job>()

    private val client: ObscuraClient?
        get() = ObscuraSession.client

    private fun requireClient(): ObscuraClient =
        client ?: throw IllegalStateException("ObscuraClient not initialized — call register or login first")

    // ─── EventSink: kit events → JS ─────────────────────────────────────────

    private val eventSink = object : ObscuraSession.EventSink {
        override fun onConnectionChanged(state: ConnectionState) {
            emit("connectionChanged", "state" to when (state) {
                ConnectionState.DISCONNECTED -> "disconnected"
                ConnectionState.CONNECTING -> "connecting"
                ConnectionState.CONNECTED -> "connected"
            })
        }
        override fun onAuthStateChanged(state: AuthState) {
            emit("authStateChanged", "state" to when (state) {
                AuthState.LOGGED_OUT -> "loggedOut"
                AuthState.PENDING_APPROVAL -> "pendingApproval"
                AuthState.AUTHENTICATED -> "authenticated"
            })
        }
        override fun onFriendsUpdated(friends: List<FriendData>) {
            val arr = Arguments.createArray()
            for (f in friends) arr.pushMap(friendToMap(f, f.status.value))
            sendEvent("ObscuraEvent", Arguments.createMap().apply {
                putString("type", "friendsUpdated")
                putArray("friends", arr)
            })
        }
        override fun onMessageReceived(msg: ReceivedMessage, modelName: String?) {
            if (msg.type == "MODEL_SYNC") {
                sendEvent("ObscuraEvent", Arguments.createMap().apply {
                    putString("type", "messageReceived")
                    putString("model", modelName ?: "directMessage")
                    putMap("entry", Arguments.createMap().apply {
                        putString("id", java.util.UUID.randomUUID().toString())
                        putDouble("timestamp", System.currentTimeMillis().toDouble())
                        putString("authorDeviceId", msg.senderDeviceId ?: "")
                        putMap("data", Arguments.createMap().apply {
                            putString("text", msg.text)
                            putString("sourceUserId", msg.sourceUserId)
                        })
                    })
                })
            } else if (msg.type == "FRIEND_REQUEST" || msg.type == "FRIEND_RESPONSE") {
                Log.d(TAG, "Friend event: ${msg.type} accepted=${msg.accepted}")
            }
        }
        override fun onDebugLog(message: String) {
            sendEvent("ObscuraEvent", Arguments.createMap().apply {
                putString("type", "debugLog")
                putString("message", message)
            })
        }
        override fun onAuthFailed(reason: String) {
            sendEvent("ObscuraEvent", Arguments.createMap().apply {
                putString("type", "authFailed")
                putString("reason", reason)
            })
        }
        override fun onPushToken(token: String) {
            sendEvent("ObscuraEvent", Arguments.createMap().apply {
                putString("type", "pushTokenReceived")
                putString("token", token)
            })
        }
    }

    init {
        ObscuraSession.bindEventSink(eventSink)
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

    private fun emit(type: String, vararg fields: Pair<String, String>) {
        sendEvent("ObscuraEvent", Arguments.createMap().apply {
            putString("type", type)
            for ((k, v) in fields) putString(k, v)
        })
    }

    // ─── Auth ───────────────────────────────────────────────────────────────

    @ReactMethod
    fun registerUser(username: String, password: String, promise: Promise) {
        scope.launch {
            try {
                Log.d(TAG, "register: $username")
                val c = ObscuraSession.createClient(username)
                c.register(username, password)
                ObscuraSession.saveSession()
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
                val c = ObscuraSession.createClient(username)
                val result = c.login(username, password)
                val scenario = when (result.scenario) {
                    LoginScenario.EXISTING_DEVICE -> "existingDevice"
                    LoginScenario.NEW_DEVICE -> "newDevice"
                    LoginScenario.DEVICE_MISMATCH -> "deviceMismatch"
                    LoginScenario.INVALID_CREDENTIALS -> "invalidCredentials"
                    LoginScenario.USER_NOT_FOUND -> "userNotFound"
                }
                Log.d(TAG, "loginSmart result: $scenario")
                if (result.scenario == LoginScenario.EXISTING_DEVICE) ObscuraSession.saveSession()
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
                val c = ObscuraSession.createClient(username)
                c.loginAndProvision(username, password)
                ObscuraSession.saveSession()
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
                ObscuraSession.saveSession()
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
                ObscuraSession.destroyClient()
                ObscuraSession.clearSession()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("LOGOUT_ERROR", e.message, e)
            }
        }
    }

    // ─── State ──────────────────────────────────────────────────────────────

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

    @ReactMethod fun getUserId(promise: Promise) { promise.resolve(client?.userId) }
    @ReactMethod fun getUsername(promise: Promise) { promise.resolve(client?.username) }
    @ReactMethod fun getDeviceId(promise: Promise) { promise.resolve(client?.deviceId) }

    // ─── Friends ────────────────────────────────────────────────────────────

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
                val cleaned = code.trim().replace("\u00AD", "").replace("\\s".toRegex(), "")
                val bytes = Base64.decode(cleaned, Base64.DEFAULT)
                val decoded = String(bytes)
                val json = JSONObject(decoded)
                val userId = json.getString("u")
                val username = json.getString("n")
                requireClient().befriend(userId, username)
                promise.resolve(null)
            } catch (e: Exception) {
                Log.e(TAG, "addFriendByCode failed: ${e.message}")
                promise.reject("ADD_FRIEND_ERROR", e.message, e)
            }
        }
    }

    // ─── Device linking ─────────────────────────────────────────────────────

    @ReactMethod
    fun generateLinkCode(promise: Promise) {
        scope.launch {
            try {
                val code = requireClient().generateLinkCode()
                promise.resolve(code)
            } catch (e: Exception) {
                promise.reject("LINK_ERROR", e.message, e)
            }
        }
    }

    @ReactMethod
    fun validateAndApproveLink(code: String, promise: Promise) {
        scope.launch {
            try {
                requireClient().validateAndApproveLink(code)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("LINK_APPROVE_ERROR", e.message, e)
            }
        }
    }

    // ─── ORM ────────────────────────────────────────────────────────────────

    @ReactMethod
    fun defineModels(schemaJson: String, promise: Promise) {
        scope.launch {
            try {
                val c = requireClient()
                ObscuraSession.defineModelsFromJson(c, schemaJson)
                ObscuraSession.cacheSchema(schemaJson)
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
                val entry = requireClient().orm.model(model).create(jsonStringToMap(dataJson))
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
                val entry = requireClient().orm.model(model).upsert(id, jsonStringToMap(dataJson))
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
                val entries = requireClient().orm.model(model).where(jsonStringToMap(conditionsJson)).exec()
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

    // ─── Signals ────────────────────────────────────────────────────────────

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

    // ─── Attachments ────────────────────────────────────────────────────────

    @ReactMethod
    fun uploadAttachment(base64Data: String, promise: Promise) {
        scope.launch {
            try {
                val bytes = Base64.decode(base64Data, Base64.DEFAULT)
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
                if (friend != null) c.sendEncryptedAttachment(friend.username, bytes, "image/jpeg")
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("SEND_PHOTO_ERROR", e.message, e)
            }
        }
    }

    // ─── Debug ──────────────────────────────────────────────────────────────

    @ReactMethod
    fun getDebugLog(promise: Promise) {
        val log = client?.debugLog ?: java.util.concurrent.ConcurrentLinkedDeque()
        val arr = Arguments.createArray()
        for (line in log) arr.pushString(line)
        promise.resolve(arr)
    }

    // ─── Screen Security ────────────────────────────────────────────────────

    @ReactMethod
    fun setSecureScreen(enabled: Boolean, promise: Promise) {
        UiThreadUtil.runOnUiThread {
            try {
                val window = reactApplicationContext.currentActivity?.window
                    ?: run { promise.resolve(null); return@runOnUiThread }
                if (enabled) {
                    window.setFlags(
                        android.view.WindowManager.LayoutParams.FLAG_SECURE,
                        android.view.WindowManager.LayoutParams.FLAG_SECURE,
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

    // ─── Push Notifications ─────────────────────────────────────────────────

    @ReactMethod
    fun requestPushPermission(promise: Promise) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            val activity = reactApplicationContext.currentActivity
            if (activity != null) {
                val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                    activity, android.Manifest.permission.POST_NOTIFICATIONS,
                ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                if (!granted) {
                    androidx.core.app.ActivityCompat.requestPermissions(
                        activity, arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 42,
                    )
                }
            }
        }
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token
                .addOnCompleteListener { task ->
                    if (task.isSuccessful) {
                        val token = task.result
                        Log.d(TAG, "FCM token: ${token.take(20)}...")
                        ObscuraSession.deliverPushToken(token)
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

    // ─── RN plumbing ────────────────────────────────────────────────────────

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        ObscuraSession.unbindEventSink(eventSink)
        typingJobs.values.forEach { it.cancel() }
        typingJobs.clear()
        scope.cancel()
    }

    // ─── Marshallers ────────────────────────────────────────────────────────

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
}
