package com.laymux.android.push

data class PushPayload(
    val instanceId: String,
    val notificationId: String,
    val revision: Int,
    val body: String,
) {
    val tag: String get() = "laymux:$instanceId:$notificationId"
    companion object {
        private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        fun validId(value: String?): Boolean = value != null && uuid.matches(value)
        fun shouldApply(previous: Int, next: Int): Boolean = next > previous
        fun parse(data: Map<String, String>): PushPayload? {
            val instance = data["instanceId"] ?: return null
            val notification = data["notificationId"] ?: return null
            if (!validId(instance) || !validId(notification)) return null
            val revision = data["revision"]?.toIntOrNull() ?: return null
            if (revision !in 1..2 || data["action"] != if (revision == 1) "created" else "read") return null
            return PushPayload(instance.lowercase(), notification.lowercase(), revision,
                (data["body"] ?: "Laymux에 확인할 알림이 있습니다.").take(500))
        }
    }
}
