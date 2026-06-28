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
        override fun onConnectionChanged(state: ConnectionState) = emit("connectionChanged") {
            putString("state", when (state) {
                ConnectionState.DISCONNECTED -> "disconnected"
                ConnectionState.CONNECTING -> "connecting"
                ConnectionState.CONNECTED -> "connected"
            })
        }
        override fun onAuthStateChanged(state: AuthState) = emit("authStateChanged") {
            putString("state", when (state) {
                AuthState.LOGGED_OUT -> "loggedOut"
                AuthState.PENDING_APPROVAL -> "pendingApproval"
                AuthState.AUTHENTICATED -> "authenticated"
            })
        }
        override fun onFriendsUpdated(friends: List<FriendData>) = emit("friendsUpdated") {
            val arr = Arguments.createArray()
            for (f in friends) arr.pushMap(friendToMap(f, f.status.value))
            putArray("friends", arr)
        }
        override fun onMessageReceived(msg: ReceivedMessage, modelName: String?) {
            if (msg.type == "MODEL_SYNC") {
                // Payload is intentionally minimal — consumers re-query the ORM for the
                // authoritative entries. Don't synthesize a fake id here.
                emit("messageReceived") { putString("model", modelName ?: "directMessage") }
            } else if (msg.type == "FRIEND_REQUEST" || msg.type == "FRIEND_RESPONSE") {
                Log.d(TAG, "Friend event: ${msg.type} accepted=${msg.accepted}")
            }
        }
        override fun onDebugLog(message: String) = emit("debugLog") { putString("message", message) }
        override fun onAuthFailed(reason: String) = emit("authFailed") { putString("reason", reason) }
        override fun onPushToken(token: String) = emit("pushTokenReceived") { putString("token", token) }
        override fun onAppStateChanged(state: ObscuraSession.AppState) = emit("appStateChanged") {
            putString("state", when (state) {
                ObscuraSession.AppState.ACTIVE -> "active"
                ObscuraSession.AppState.BACKGROUND -> "background"
            })
        }
    }

    init {
        instance = this
        ObscuraSession.bindEventSink(eventSink)
    }

    companion object {
        @Volatile private var instance: ObscuraBridgeModule? = null
        /**
         * Called from [MainActivity.onNewIntent] when a deep-link intent arrives
         * while the app is already running. Cold-start deep-links go through
         * [getLaunchIntent] instead (the bridge isn't built yet at that point).
         */
        fun deliverLaunchedFrom(screen: String) {
            instance?.emit("launchedFrom") { putString("screen", screen) }
        }
    }

    /**
     * Single event emitter. All `ObscuraEvent` payloads go through here.
     *
     * The wire shape is always: `{ type: <eventType>, ...fields }`.
     * `build` populates the extra fields on top of `type`. Keeping every emission
     * routed through this one helper means the Swift bridge has exactly one
     * pattern to match.
     */
    private fun emit(type: String, build: WritableMap.() -> Unit = {}) {
        val params = Arguments.createMap().apply {
            putString("type", type)
            build()
        }
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit("ObscuraEvent", params)
        } catch (e: Exception) {
            Log.w(TAG, "emit($type) failed (JS not ready?): ${e.message}")
        }
    }

    /** Fired after a successful local CRUD on a model. Lets screens re-query reactively. */
    private fun emitEntriesChanged(model: String) = emit("entriesChanged") { putString("model", model) }

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
                emitEntriesChanged(model)
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
                emitEntriesChanged(model)
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
                emitEntriesChanged(model)
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
                emit("typingChanged") {
                    putString("conversationId", conversationId)
                    val arr = Arguments.createArray()
                    for (t in typers) arr.pushString(t)
                    putArray("typers", arr)
                }
            }
        }
        promise.resolve(null)
    }

    @ReactMethod
    fun stopObservingTyping(conversationId: String, promise: Promise) {
        typingJobs.remove(conversationId)?.cancel()
        promise.resolve(null)
    }

    // ─── Attachments (path-based) ───────────────────────────────────────────
    // Bytes never cross the bridge. JS hands us a file path; we read, encrypt,
    // upload. On download, we decrypt to a deterministic cache path and return
    // that path so JS can use it directly as a `file://` URI.

    @ReactMethod
    fun uploadAttachment(filePath: String, promise: Promise) {
        scope.launch {
            try {
                val bytes = java.io.File(filePath).readBytes()
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
                val dir = java.io.File(reactApplicationContext.cacheDir, "attachments").apply { mkdirs() }
                // Sanitize the id to a safe filename — attachment ids are server-generated
                // (UUIDs in practice) but we don't want any path traversal surprises.
                val safe = id.replace(Regex("[^A-Za-z0-9_-]"), "_")
                val dest = java.io.File(dir, "$safe.jpg")
                if (!dest.exists() || dest.length() == 0L) {
                    val keyBytes = Base64.decode(contentKey, Base64.DEFAULT)
                    val nonceBytes = Base64.decode(nonce, Base64.DEFAULT)
                    val data = requireClient().downloadDecryptedAttachment(id, keyBytes, nonceBytes)
                    // Atomic publish: write to a tmp file then rename into place so a
                    // concurrent reader never sees a partially-written file.
                    val tmp = java.io.File(dir, "$safe.jpg.tmp")
                    try {
                        tmp.writeBytes(data)
                        if (!tmp.renameTo(dest)) {
                            // Fallback for the (unlikely) cross-mount rename failure.
                            tmp.copyTo(dest, overwrite = true)
                        }
                    } finally {
                        tmp.delete()
                    }
                }
                promise.resolve(dest.absolutePath)
            } catch (t: Throwable) {
                promise.reject("DOWNLOAD_ERROR", t.message, t)
            }
        }
    }

    // ─── Image processing (native, path-in/path-out) ────────────────────────

    /**
     * Resize the image at [srcPath] so its largest side is at most [maxDim] px,
     * re-encoded as JPEG at [quality] (1-100). Honors the JPEG's EXIF
     * `Orientation` tag — the output pixels are already in display orientation
     * (front-camera selfies don't render rotated). Returns the new file path
     * plus its post-rotation dimensions. The original file is left untouched.
     *
     * Memory: uses `inSampleSize` two-pass decoding so a 12 MP source doesn't
     * allocate a 48 MB intermediate bitmap on low-memory devices.
     */
    @ReactMethod
    fun resizeImage(srcPath: String, maxDim: Int, quality: Int, promise: Promise) {
        scope.launch {
            try {
                require(maxDim > 0) { "maxDim must be positive (got $maxDim)" }

                // Pass 1: read bounds only.
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeFile(srcPath, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                    throw IllegalArgumentException("Could not decode image at $srcPath")
                }

                // Pass 2: sub-sampled decode keeps peak memory bounded.
                val srcLargest = maxOf(bounds.outWidth, bounds.outHeight)
                var sample = 1
                while (sample * 2 <= srcLargest / maxDim) sample *= 2
                val decoded = android.graphics.BitmapFactory.decodeFile(
                    srcPath,
                    android.graphics.BitmapFactory.Options().apply { inSampleSize = sample },
                ) ?: throw IllegalArgumentException("Could not decode image at $srcPath")

                // EXIF orientation — both the rotation and the flip variants used by
                // Android front cameras. We bake the transform into the bitmap so the
                // output JPEG has display-orientation pixels and no orientation tag.
                val orientation = try {
                    android.media.ExifInterface(srcPath).getAttributeInt(
                        android.media.ExifInterface.TAG_ORIENTATION,
                        android.media.ExifInterface.ORIENTATION_NORMAL,
                    )
                } catch (_: Throwable) { android.media.ExifInterface.ORIENTATION_NORMAL }

                val matrix = android.graphics.Matrix()
                when (orientation) {
                    android.media.ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
                    android.media.ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
                    android.media.ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
                    android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
                    android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
                    android.media.ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
                    android.media.ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(-90f); matrix.postScale(-1f, 1f) }
                }

                // 90°/270° orientations swap apparent width/height for the scale check.
                val swap = orientation == android.media.ExifInterface.ORIENTATION_ROTATE_90 ||
                           orientation == android.media.ExifInterface.ORIENTATION_ROTATE_270 ||
                           orientation == android.media.ExifInterface.ORIENTATION_TRANSPOSE ||
                           orientation == android.media.ExifInterface.ORIENTATION_TRANSVERSE
                val rotW = if (swap) decoded.height else decoded.width
                val rotH = if (swap) decoded.width else decoded.height
                val rotLargest = maxOf(rotW, rotH)
                val scale = if (rotLargest <= maxDim) 1.0 else maxDim.toDouble() / rotLargest
                if (scale != 1.0) matrix.postScale(scale.toFloat(), scale.toFloat())

                val output = android.graphics.Bitmap.createBitmap(
                    decoded, 0, 0, decoded.width, decoded.height, matrix, true,
                )
                if (output !== decoded) decoded.recycle()

                val dir = java.io.File(reactApplicationContext.cacheDir, "resized").apply { mkdirs() }
                val dest = java.io.File(dir, "img_${System.currentTimeMillis()}.jpg")
                java.io.FileOutputStream(dest).use { out ->
                    output.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), out)
                }
                val outW = output.width
                val outH = output.height
                output.recycle()

                promise.resolve(Arguments.createMap().apply {
                    putString("path", dest.absolutePath)
                    putInt("width", outW)
                    putInt("height", outH)
                })
            } catch (t: Throwable) {
                // Catch Throwable, not Exception — Bitmap allocations can throw OOM
                // (an Error, not an Exception); silently dropping that would leave
                // the JS promise hanging forever.
                Log.e(TAG, "resizeImage failed: ${t.message}")
                promise.reject("RESIZE_ERROR", t.message, t)
            }
        }
    }

    /**
     * Write a solid-color JPEG of the requested size to the cache and return
     * the path. Replaces the JS-side BMP/base64 dance used by CameraScreen on
     * emulators with no camera.
     */
    @ReactMethod
    fun writeTestImage(width: Int, height: Int, promise: Promise) {
        scope.launch {
            try {
                require(width in 1..8192 && height in 1..8192) {
                    "dimensions out of range (got ${width}x${height})"
                }
                val color = android.graphics.Color.argb(
                    255,
                    (Math.random() * 256).toInt(),
                    (Math.random() * 256).toInt(),
                    (Math.random() * 256).toInt(),
                )
                val bmp = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
                bmp.eraseColor(color)
                val dest = java.io.File(reactApplicationContext.cacheDir, "test_${System.currentTimeMillis()}.jpg")
                java.io.FileOutputStream(dest).use { out ->
                    bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 85, out)
                }
                bmp.recycle()
                promise.resolve(Arguments.createMap().apply {
                    putString("path", dest.absolutePath)
                    putInt("width", width)
                    putInt("height", height)
                })
            } catch (t: Throwable) {
                promise.reject("TEST_IMAGE_ERROR", t.message, t)
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

    // ─── Deep linking ───────────────────────────────────────────────────────

    /**
     * Returns the cold-start deep-link target (currently just a "screen"
     * extra set by [NotificationHelper]) and consumes the extra so subsequent
     * calls return null. JS should call this once on app mount; warm-start
     * deep-links arrive via the `launchedFrom` event instead.
     */
    @ReactMethod
    fun getLaunchIntent(promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        val intent = activity?.intent
        val screen = intent?.getStringExtra("screen")
        // Consume the extra so a config change / re-call doesn't re-trigger.
        intent?.removeExtra("screen")
        if (screen == null) {
            promise.resolve(null)
        } else {
            promise.resolve(Arguments.createMap().apply { putString("screen", screen) })
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

    // ─── File helpers ───────────────────────────────────────────────────────
    // Just enough to let JS clean up temp files (e.g. vision-camera's capture path).
    // Everything else that used to live here moved into the typed contract above
    // (uploadAttachment, downloadAttachment, resizeImage, writeTestImage) so bytes
    // never round-trip through the JS bridge as base64.

    @ReactMethod
    fun deleteFile(path: String, promise: Promise) {
        try {
            java.io.File(path).delete()
            promise.resolve(null)
        } catch (e: Throwable) {
            promise.reject("DELETE_FAILED", e)
        }
    }

    @Suppress("DEPRECATION")
    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        ObscuraSession.unbindEventSink(eventSink)
        typingJobs.values.forEach { it.cancel() }
        typingJobs.clear()
        scope.cancel()
        instance = null
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
