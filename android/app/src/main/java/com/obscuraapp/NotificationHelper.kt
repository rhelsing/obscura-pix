package com.obscuraapp

import android.app.Notification
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
 * Privacy invariant — enforced here, never relaxed: the title and body are
 * ONLY ever generic ("Obscura" / "New pix" / "New message"). No sender,
 * no content, no conversation/IDs in the visible notification or its extras.
 *
 * Used by BOTH delivery paths so the UX is identical regardless of transport:
 *   - [ObscuraMessagingService] (FCM silent-push drain, when the process was dead)
 *   - [ObscuraBridgeModule] (live envelope loop, when the process is alive in background)
 *
 * Fixed NOTIFICATION_ID means repeat posts replace rather than stack — no spam.
 */
object NotificationHelper {
    private const val TAG = "ObscuraBridge"
    private const val CHANNEL_ID = "obscura_messages"
    private const val CHANNEL_NAME = "Obscura messages"
    private const val NOTIFICATION_ID = 1

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH)
                    .apply {
                        description = "Notifications for new pix and messages"
                        enableVibration(true)
                        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                    }
            )
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
            .setContentTitle("Obscura")
            .setContentText(text)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH) // pre-O fallback; channel wins on O+
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, notif)
        Log.d(TAG, "Posted notification: $text")
    }
}
