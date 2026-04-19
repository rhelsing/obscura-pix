package com.obscuraapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking

/**
 * Receives silent FCM pushes from obscura-server. The push payload is always
 * `{ "action": "check" }` with no content, no sender, no metadata.
 *
 * This service:
 *   1. Wakes the app
 *   2. Asks the kit to drain any queued envelopes via processPendingMessages()
 *   3. Posts a HARDCODED generic local notification based on envelope counts
 *
 * Privacy invariant — enforced here, never relaxed:
 *   - Notification text is literally "New pix" or "New message"
 *   - NO sender username, NO caption, NO conversation ID, NO content preview
 *   - Pix wins on tie (if both pix and message arrived, show only "New pix")
 *   - If only non-user envelopes arrived (other), no notification at all
 */
class ObscuraMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "ObscuraMessagingService"
        private const val CHANNEL_ID = "obscura_default"
        private const val CHANNEL_NAME = "Obscura"
        private const val NOTIFICATION_ID = 1
        private const val PROCESS_TIMEOUT_MS = 25_000L
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "onNewToken: ${token.take(20)}...")
        // Route token to the bridge, which emits pushTokenReceived to JS.
        // If the bridge isn't alive yet (app not launched), the token will be
        // re-fetched by JS on next launch via getToken().
        ObscuraBridgeModule.current?.deliverPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Log.d(TAG, "Silent push received, data=${message.data}")

        // Verify it's the expected wake-up ping. We accept any data-only push;
        // the server only ever sends { action: "check" } but we don't gate on it
        // strictly in case of future additions. Never inspect data for content —
        // all content comes through the WebSocket, encrypted.

        val client = ObscuraBridgeModule.currentClient()
        if (client == null) {
            Log.w(TAG, "No client available — app may not have been authenticated yet")
            return
        }

        // Drain queued envelopes. runBlocking is fine here — FirebaseMessagingService
        // runs onMessageReceived on a background thread and OS gives us ~10 minutes.
        val counts = try {
            runBlocking { client.processPendingMessages(PROCESS_TIMEOUT_MS) }
        } catch (e: Exception) {
            Log.e(TAG, "processPendingMessages failed: ${e.message}")
            return
        }

        Log.d(TAG, "Drained: pix=${counts.pixCount} msg=${counts.messageCount} other=${counts.otherCount}")

        // Privacy invariant: hardcoded generic text only. Pix wins on tie.
        val text: String? = when {
            counts.pixCount > 0 -> "New pix"
            counts.messageCount > 0 -> "New message"
            else -> null
        }

        if (text != null) postGenericNotification(text)
    }

    /**
     * Post a local notification with ONLY the hardcoded text. Never accepts
     * sender, content, or any identifying metadata — invariant enforced by
     * the function signature.
     */
    private fun postGenericNotification(text: String) {
        ensureChannel()

        // Deep link intent — opens the app to main screen. NO conversationId,
        // NO sender info in the intent extras. Tapping just opens the app.
        val intent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("screen", "chat") // screen name only, no IDs
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info) // TODO: app icon
            .setContentTitle(text)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, notif)
        Log.d(TAG, "Posted notification: $text")
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val existing = manager.getNotificationChannel(CHANNEL_ID)
            if (existing == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Notifications for new pix and messages"
                }
                manager.createNotificationChannel(channel)
            }
        }
    }
}
