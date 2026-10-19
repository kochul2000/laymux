package com.laymux.android.push

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

class PushSettingsController(private val activity: FragmentActivity) {
    private var pending: (() -> Unit)? = null
    private val permission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        val action = pending; pending = null
        if (allowed) action?.invoke() else message("Android 설정에서 Laymux 알림 권한을 허용해주세요.")
    }
    private val client = PushCloudClient(activity)
    fun show(instanceId: String) {
        if (!PushNotifications.initialize(activity)) {
            message("이 앱 빌드에 푸시 서비스가 설정되지 않았습니다.")
            return
        }
        val current = PushNotifications.config(activity, instanceId)
        val labels = listOf("waiting" to "입력·승인 요청", "failure" to "작업 실패", "complete" to "작업 완료", "general" to "일반 알림")
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, 0, pad, 0)
        }
        content.addView(TextView(activity).apply { text = "이 휴대전화와 이 PC의 앱 알림입니다. 브라우저 수신과 별도로 동작합니다." })
        val checks = labels.map { (key, label) -> key to CheckBox(activity).apply {
            text = label
            isChecked = current?.optJSONArray("categories")?.let { categories ->
                (0 until categories.length()).any { categories.optString(it) == key }
            } ?: true
            content.addView(this)
        } }
        val details = CheckBox(activity).apply { text = "알림에 상세 내용 표시"; isChecked = current?.optBoolean("includeDetails") ?: false }
        content.addView(details)
        content.addView(TextView(activity).apply { text = "기본 알림에는 작업 내용을 넣지 않습니다. 상세 표시를 켜면 본문이 Cloud와 푸시 제공자에 전달됩니다." })
        MaterialAlertDialogBuilder(activity).setTitle("휴대전화 알림").setView(content)
            .setPositiveButton("허용·저장") { _, _ ->
                val config = JSONObject().put("instanceId", instanceId)
                    .put("categories", JSONArray(checks.filter { it.second.isChecked }.map { it.first }))
                    .put("includeDetails", details.isChecked)
                val enable = { register(config) }
                if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    pending = enable; permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else enable()
            }
            .setNeutralButton("이 PC 알림 중지") { _, _ ->
                activity.lifecycleScope.launch {
                    runCatching { withContext(Dispatchers.IO) {
                        client.request("/api/push/subscription?deviceId=${PushNotifications.deviceId(activity)}&instanceId=$instanceId", "DELETE")
                    } }.onSuccess {
                        PushNotifications.save(activity, instanceId, null); message("이 PC의 앱 알림을 중지했습니다.")
                    }.onFailure { message(it.message ?: "알림 중지에 실패했습니다.") }
                }
            }.setNegativeButton("취소", null).show()
    }
    private fun register(config: JSONObject) {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            activity.lifecycleScope.launch {
                runCatching { withContext(Dispatchers.IO) { client.register(config, token) } }
                    .onSuccess {
                        PushNotifications.preferences(activity).edit().putString("token", token).apply()
                        PushNotifications.save(activity, config.getString("instanceId"), config)
                        message("이 휴대전화에서 이 PC의 알림을 받습니다.")
                    }.onFailure { message(it.message ?: "알림 설정을 저장하지 못했습니다.") }
            }
        }.addOnFailureListener { message("푸시 토큰을 가져오지 못했습니다. 네트워크와 Google Play 서비스를 확인해주세요.") }
    }
    fun synchronize() { PushRegistrationWorker.enqueue(activity) }
    private fun message(text: String) { Toast.makeText(activity, text, Toast.LENGTH_LONG).show() }
}
