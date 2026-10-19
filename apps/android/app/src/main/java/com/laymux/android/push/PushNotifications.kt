package com.laymux.android.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.laymux.android.BuildConfig
import com.laymux.android.MainActivity
import com.laymux.android.R
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import org.json.JSONObject
import java.util.UUID

/** FCM is independent of E2E keys and the secure WebView lifecycle. */
object PushNotifications {
    const val OPEN_ACTION = "com.laymux.android.OPEN_NOTIFICATION"
    private const val CHANNEL = "laymux-tasks"
    fun preferences(context: Context) = context.getSharedPreferences("notification-push", Context.MODE_PRIVATE)
    @Synchronized fun deviceId(context: Context): String {
        val prefs = preferences(context)
        return prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("deviceId", it).apply()
        }
    }
    fun configured(): Boolean = listOf(BuildConfig.PUSH_FIREBASE_APP_ID, BuildConfig.PUSH_FIREBASE_API_KEY,
        BuildConfig.PUSH_FIREBASE_PROJECT_ID, BuildConfig.PUSH_FIREBASE_SENDER_ID).all { it.isNotBlank() }
    fun initialize(context: Context): Boolean {
        if (!configured()) return false
        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.PUSH_FIREBASE_APP_ID)
                .setApiKey(BuildConfig.PUSH_FIREBASE_API_KEY)
                .setProjectId(BuildConfig.PUSH_FIREBASE_PROJECT_ID)
                .setGcmSenderId(BuildConfig.PUSH_FIREBASE_SENDER_ID).build())
        }
        return true
    }
    fun config(context: Context, instanceId: String): JSONObject? =
        preferences(context).getString("pc:$instanceId", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    fun configurations(context: Context): List<JSONObject> = preferences(context).all.entries
        .filter { it.key.startsWith("pc:") }.mapNotNull { (_, value) ->
            runCatching { JSONObject(value as String) }.getOrNull()
        }
    fun save(context: Context, instanceId: String, config: JSONObject?) {
        val editor = preferences(context).edit()
        if (config == null) editor.remove("pc:$instanceId") else editor.putString("pc:$instanceId", config.toString())
        editor.apply()
        if (config == null) closeInstance(context, instanceId)
    }
    fun disableAll(context: Context) {
        val editor = preferences(context).edit()
        for (key in preferences(context).all.keys) if (key.startsWith("pc:")) editor.remove(key)
        editor.apply()
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }
    private fun closeInstance(context: Context, instanceId: String) {
        val manager = context.getSystemService(NotificationManager::class.java)
        for (item in manager.activeNotifications) if (item.tag?.startsWith("laymux:$instanceId:") == true) manager.cancel(item.tag, 0)
    }
    @Synchronized fun receive(context: Context, payload: PushPayload) {
        if (config(context, payload.instanceId) == null) return
        val prefs = preferences(context)
        val key = "revision:${payload.tag}"
        if (!PushPayload.shouldApply(prefs.getInt(key, 0), payload.revision)) return
        val editor = prefs.edit().putInt(key, payload.revision)
        // Bound process-persistent deduplication entries. Cloud also keeps a
        // seven-day tombstone and does not resend an acknowledged transition.
        val keys = prefs.all.keys.filter { it.startsWith("revision:") }
        if (keys.size >= 2048) keys.take(keys.size - 2047).forEach(editor::remove)
        editor.apply()
        val manager = context.getSystemService(NotificationManager::class.java)
        if (payload.revision == 2) { manager.cancel(payload.tag, 0); return }
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "작업 알림", NotificationManager.IMPORTANCE_DEFAULT))
        val intent = Intent(context, MainActivity::class.java).setAction(OPEN_ACTION)
            .setData(android.net.Uri.parse("laymux-notification://${payload.instanceId}/${payload.notificationId}"))
            .putExtra("instanceId", payload.instanceId).putExtra("notificationId", payload.notificationId)
        val pending = PendingIntent.getActivity(context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify(payload.tag, 0, NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome).setContentTitle("Laymux")
            .setContentText(payload.body).setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
    }
}
