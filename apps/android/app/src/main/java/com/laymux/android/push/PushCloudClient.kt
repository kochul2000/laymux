package com.laymux.android.push

import android.content.Context
import android.app.NotificationManager
import android.webkit.CookieManager
import com.laymux.android.R
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PushCloudClient(private val context: Context) {
    private class RequestFailure(val status: Int, message: String) : IllegalStateException(message)
    private val origin = context.getString(R.string.laymux_cloud_base_url).trimEnd('/')
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).callTimeout(8, TimeUnit.SECONDS).build()
    fun request(path: String, method: String = "GET", payload: JSONObject? = null): JSONObject {
        require(path.startsWith("/api/push/"))
        val cookie = CookieManager.getInstance().getCookie(origin) ?: throw IllegalStateException("Cloud 로그인이 필요합니다.")
        val body = payload?.toString()?.toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(origin + path).header("Cookie", cookie)
            .header("Origin", origin).method(method, body).build()
        return client.newCall(request).execute().use { response ->
            if (response.code == 401) {
                PushNotifications.disableAll(context)
                throw IllegalStateException("Cloud 로그인이 필요합니다.")
            }
            if (!response.isSuccessful) throw RequestFailure(response.code,
                if (response.code == 503) "Cloud 서버에 알림 서비스가 아직 설정되지 않았습니다." else "알림 설정을 저장하지 못했습니다 (${response.code}).")
            if (response.code == 204) JSONObject() else {
                val source = response.body?.source() ?: throw IllegalStateException("알림 응답이 없습니다.")
                source.request(256 * 1024L + 1)
                if (source.buffer.size > 256 * 1024L) throw IllegalStateException("알림 응답이 너무 큽니다.")
                JSONObject(source.readUtf8())
            }
        }
    }
    fun register(configuration: JSONObject, token: String) {
        val payload = JSONObject(configuration.toString()).put("deviceId", PushNotifications.deviceId(context))
            .put("kind", "android").put("token", token)
        request("/api/push/subscription", "PUT", payload)
    }
    fun refreshRegistrations(token: String): Boolean {
        var complete = true
        for (config in PushNotifications.configurations(context)) {
            runCatching { register(config, token) }.onFailure { error ->
                if (error is RequestFailure && error.status == 404) {
                    PushNotifications.save(context, config.getString("instanceId"), null)
                } else complete = false
            }
        }
        return complete
    }
    fun synchronize(): Boolean {
        val token = PushNotifications.preferences(context).getString("token", null) ?: return true
        var complete = refreshRegistrations(token)
        for (config in PushNotifications.configurations(context)) {
            runCatching {
                val instance = config.getString("instanceId")
                val displayedIds = context.getSystemService(NotificationManager::class.java).activeNotifications
                    .mapNotNull { item -> item.tag?.takeIf { it.startsWith("laymux:$instance:") }?.substringAfterLast(':') }
                    .filter(PushPayload::validId).take(100)
                if (displayedIds.isEmpty()) return@runCatching
                val read = request("/api/push/state?instanceId=$instance&notificationIds=${displayedIds.joinToString(",")}").getJSONArray("read")
                for (i in 0 until read.length()) {
                    val id = read.getString(i)
                    PushNotifications.receive(context, PushPayload(instance, id, 2, ""))
                }
            }.onFailure { complete = false }
        }
        return complete
    }
}
