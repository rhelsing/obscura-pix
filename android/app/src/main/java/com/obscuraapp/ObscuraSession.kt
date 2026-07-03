package com.obscuraapp

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import com.obscura.kit.AuthState
import com.obscura.kit.ConnectionState
import com.obscura.kit.ObscuraClient
import com.obscura.kit.ObscuraConfig
import com.obscura.kit.ObscuraLogger
import com.obscura.kit.ReceivedMessage
import com.obscura.kit.db.ObscuraDatabase
import com.obscura.kit.orm.ModelConfig
import com.obscura.kit.stores.FriendData
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * Process-scoped owner of the [ObscuraClient]. Single source of truth for:
 *
 *   - Client lifecycle (create / restore-from-prefs / destroy)
 *   - Session persistence (token, refreshToken, userId, deviceId, username,
 *     registrationId, cachedSchema) in the `obscura_session` SharedPreferences
 *   - Foreground/background tracking (ProcessLifecycleOwner)
 *   - The SINGLE consumer of [ObscuraClient.incomingMessages] — classifies
 *     each envelope, fans out to the bound [EventSink] (i.e. the RN bridge),
 *     and posts a generic local notification when the app is backgrounded.
 *
 * Initialized from [MainApplication.onCreate] so an FCM cold-start can
 * restore the session and start consuming messages before the RN bridge
 * is ever constructed.
 *
 * Threading: callable from any thread; internal coroutines run on
 * [Dispatchers.Default] / [Dispatchers.Main] as appropriate.
 */
object ObscuraSession {

    private const val TAG = "ObscuraSession"
    private const val PREFS_NAME = "obscura_session"
    private const val API_URL = "https://obscura.barrelmaker.dev"

    /** Listener registered by the RN bridge so kit events reach JS. */
    interface EventSink {
        fun onConnectionChanged(state: ConnectionState)
        fun onAuthStateChanged(state: AuthState)
        fun onFriendsUpdated(friends: List<FriendData>)
        fun onMessageReceived(msg: ReceivedMessage, modelName: String?)
        fun onDebugLog(message: String)
        fun onAuthFailed(reason: String)
        fun onPushToken(token: String)
        fun onAppStateChanged(state: AppState)
    }

    /** Process-wide app foreground/background. Matches the iOS-friendly minimal set. */
    enum class AppState { ACTIVE, BACKGROUND }

    private lateinit var appContext: Context
    private val prefs: SharedPreferences by lazy {
        appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val collectorJobs = mutableListOf<Job>()

    @Volatile var client: ObscuraClient? = null
        private set

    @Volatile var appInForeground: Boolean =
        ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        private set

    @Volatile private var sink: EventSink? = null

    /** Logger that forwards everything to logcat and surfaces auth failures via the sink. */
    val logger: ObscuraLogger = object : ObscuraLogger {
        override fun log(message: String) { Log.d(TAG, message) }
        override fun decryptFailed(sourceUserId: String, reason: String) { Log.w(TAG, "decrypt failed from ${sourceUserId.take(8)}: $reason") }
        override fun ackFailed(envelopeId: String, reason: String) { Log.w(TAG, "ack failed $envelopeId: $reason") }
        override fun tokenRefreshFailed(attempt: Int, reason: String) {
            Log.e(TAG, "token refresh failed (attempt $attempt): $reason")
            if (attempt >= 5) sink?.onAuthFailed("Token refresh failed after $attempt attempts")
        }
        override fun preKeyReplenishFailed(reason: String) { Log.w(TAG, "prekey replenish failed: $reason") }
        override fun identityChanged(address: String) { Log.w(TAG, "identity changed: $address") }
        override fun sessionEstablishFailed(userId: String, reason: String) { Log.e(TAG, "session establish failed $userId: $reason") }
        override fun signatureVerificationFailed(sourceUserId: String, messageType: String) { Log.w(TAG, "sig verify failed from $sourceUserId type=$messageType") }
        override fun databaseError(store: String, operation: String, reason: String) { Log.e(TAG, "db error $store.$operation: $reason") }
    }

    /**
     * Called once from [MainApplication.onCreate]. Wires up the lifecycle
     * observer and attempts to restore a persisted session.
     */
    fun init(app: Context) {
        appContext = app.applicationContext

        // Foreground/background tracking. ProcessLifecycleOwner requires main thread.
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) {
                    appInForeground = true
                    sink?.onAppStateChanged(AppState.ACTIVE)
                    val c = client ?: return
                    if (c.authState.value == AuthState.AUTHENTICATED &&
                        c.connectionState.value == ConnectionState.DISCONNECTED) {
                        Log.d(TAG, "App foregrounded — reconnecting")
                        scope.launch {
                            try { c.connect() } catch (e: Exception) {
                                Log.e(TAG, "Foreground reconnect failed: ${e.message}")
                            }
                        }
                    }
                }
                override fun onStop(owner: LifecycleOwner) {
                    appInForeground = false
                    sink?.onAppStateChanged(AppState.BACKGROUND)
                }
            })
        }

        // Try to restore persisted session (idempotent — no-op if not present).
        try {
            tryRestore()
        } catch (e: Exception) {
            Log.e(TAG, "init: restore failed: ${e.message}")
        }
    }

    // ─── EventSink registration (bridge) ────────────────────────────────────

    fun bindEventSink(s: EventSink) {
        sink = s
        // Replay current state so a freshly-bound bridge immediately sees correct UI.
        s.onAppStateChanged(if (appInForeground) AppState.ACTIVE else AppState.BACKGROUND)
        val c = client ?: return
        s.onAuthStateChanged(c.authState.value)
        s.onConnectionChanged(c.connectionState.value)
        s.onFriendsUpdated(c.friendList.value)
    }

    fun unbindEventSink(s: EventSink) {
        if (sink === s) sink = null
    }

    // ─── Session prefs ──────────────────────────────────────────────────────

    fun saveSession() {
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

    fun clearSession() {
        prefs.edit().clear().apply()
        Log.d(TAG, "Session cleared")
    }

    fun getCachedSchema(): String? = prefs.getString("cachedSchema", null)
    fun cacheSchema(schemaJson: String) {
        prefs.edit().putString("cachedSchema", schemaJson).apply()
    }

    // ─── Client lifecycle ───────────────────────────────────────────────────

    /** Build a fresh client for a username (per-user SQLite db). Replaces any existing one. */
    fun createClient(username: String): ObscuraClient {
        destroyClient()
        val dbName = "obscura_${username}.db"
        val driver = AndroidSqliteDriver(ObscuraDatabase.Schema, appContext, dbName)
        val c = ObscuraClient(ObscuraConfig(apiUrl = API_URL), externalDriver = driver)
        c.logger = logger
        client = c
        startCollectors(c)
        Log.d(TAG, "Client created (db=$dbName)")
        return c
    }

    /** Tear down the current client, cancel collectors. */
    fun destroyClient() {
        collectorJobs.forEach { it.cancel() }
        collectorJobs.clear()
        try { client?.disconnect() } catch (_: Exception) {}
        client = null
    }

    /**
     * Restore a client from persisted prefs. Returns the client (existing or
     * freshly built), or null if no session is persisted. Idempotent — calling
     * twice returns the same instance.
     */
    @Synchronized
    fun tryRestore(): ObscuraClient? {
        client?.let { return it }
        val token = prefs.getString("token", null) ?: return null
        val userId = prefs.getString("userId", null) ?: return null
        val username = prefs.getString("username", null) ?: return null
        val refreshToken = prefs.getString("refreshToken", null)
        val deviceId = prefs.getString("deviceId", null)
        val registrationId = prefs.getInt("registrationId", 0)

        Log.d(TAG, "Restoring session: user=$username device=${deviceId?.take(8)}")

        val dbName = "obscura_${username}.db"
        val driver = AndroidSqliteDriver(ObscuraDatabase.Schema, appContext, dbName)
        val c = ObscuraClient(ObscuraConfig(apiUrl = API_URL), externalDriver = driver)
        c.logger = logger
        c.restoreSession(token, refreshToken, userId, deviceId, username, registrationId)

        getCachedSchema()?.let { schemaJson ->
            runBlocking { defineModelsFromJson(c, schemaJson) }
        }

        client = c
        startCollectors(c)

        // Best-effort background reconnect.
        scope.launch {
            try {
                c.ensureFreshToken()
                c.connect()
                saveSession()
            } catch (e: Exception) {
                Log.e(TAG, "restore connect failed: ${e.message}")
            }
        }
        return c
    }

    suspend fun defineModelsFromJson(c: ObscuraClient, schemaJson: String) {
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
                ttl = if (model.has("ttl") && !model.isNull("ttl")) model.getString("ttl") else null,
                private = model.optBoolean("private", false),
                direct = model.optBoolean("direct", false),
            )
        }
        c.orm.define(models)
    }

    // ─── Collectors (single source of truth) ────────────────────────────────

    private fun startCollectors(c: ObscuraClient) {
        collectorJobs += scope.launch {
            c.connectionState.collectLatest { state ->
                Log.d(TAG, "Connection: $state")
                sink?.onConnectionChanged(state)
                if (state == ConnectionState.CONNECTED) saveSession()
            }
        }
        collectorJobs += scope.launch {
            c.authState.collectLatest { state ->
                Log.d(TAG, "AuthState: $state")
                sink?.onAuthStateChanged(state)
            }
        }
        collectorJobs += scope.launch {
            c.friendList.collectLatest { friends ->
                sink?.onFriendsUpdated(friends)
            }
        }
        // THE single consumer of incomingMessages. Fans out to sink + notification.
        collectorJobs += scope.launch {
            for (msg in c.incomingMessages) {
                Log.d(TAG, "Incoming: ${msg.type} from=${msg.sourceUserId.take(8)}")
                val modelName: String? = if (msg.type == "MODEL_SYNC") {
                    msg.raw?.modelSync?.model ?: "directMessage"
                } else null
                sink?.onMessageReceived(msg, modelName)
                sink?.onDebugLog("${msg.type}: ${msg.text.take(100)}")

                if (!appInForeground) {
                    val notifText = classifyForNotification(msg, modelName)
                    if (notifText != null) {
                        NotificationHelper.postGeneric(appContext, notifText)
                    }
                }
            }
        }
    }

    private fun classifyForNotification(msg: ReceivedMessage, modelName: String?): String? = when {
        msg.type == "MODEL_SYNC" && modelName == "pix" -> "New pix"
        msg.type == "MODEL_SYNC" && modelName == "directMessage" -> "New message"
        msg.type == "FRIEND_REQUEST" -> "New friend request"
        else -> null
    }

    // ─── FCM cold-start path ────────────────────────────────────────────────

    /**
     * Called by [ObscuraMessagingService.onMessageReceived]. Restores the
     * session if needed, ensures the client is connected, then waits briefly
     * for the incoming-message collector to drain whatever the server has
     * queued. The collector itself is the one posting notifications — this
     * just guarantees it gets a chance to run.
     */
    suspend fun onPushWake(timeoutMs: Long = 25_000L) {
        val c = tryRestore() ?: run {
            Log.w(TAG, "onPushWake: no persisted session, ignoring")
            return
        }
        try {
            // Ensure connected; processPendingMessages handles both cases.
            c.processPendingMessages(timeoutMs)
        } catch (e: Exception) {
            Log.e(TAG, "onPushWake drain failed: ${e.message}")
        }
        // We intentionally do NOT disconnect — if the user opens the app
        // moments later, the live WebSocket is already up.
    }

    /** Bridge surface: deliver a fresh FCM token to JS. */
    fun deliverPushToken(token: String) { sink?.onPushToken(token) }
}
