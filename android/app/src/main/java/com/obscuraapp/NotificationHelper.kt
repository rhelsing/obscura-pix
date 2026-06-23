package com.obscuraapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Single place that turns generic text into a local notification.
 *
 * Privacy invariant — enforced here, never relaxed: the text is ONLY ever
 * "New pix" / "New message". No sender, no content, no conversation/IDs.
 *
 * Used by BOTH delivery paths so the UX is identical regardless of transport:
 *   - [ObscuraMessagingService] (FCM silent-push drain, when the process was dead)
 *   - [ObscuraBridgeModule] (live envelope loop, when the process is alive in background)
 *
 * Fixed NOTIFICATION_ID means repeat posts replace rather than stack — no spam.
 */
object NotificationHelper {
    private const val TAG = "ObscuraBridge"
    private const val CHANNEL_ID = "obscura_default"
    private const val CHANNEL_NAME = "Obscura"
    private const val NOTIFICATION_ID = 1

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT)
                        .apply { description = "Notifications for new pix and messages" }
                )
            }
        }
    }

    /** Post the generic notification. [text] MUST be hardcoded generic text only. */
    fun postGeneric(context: Context, text: String) {
        ensureChannel(context)

        // Deep link just opens the app — NO conversationId, NO sender in extras.
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("screen", "chat")
        }
        val pendingIntent = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(text)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, notif)
        Log.d(TAG, "Posted notification: $text")
    }
}
