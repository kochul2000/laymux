package com.laymux.android.update

import android.content.Context

/**
 * 채널과 확인 이력의 기기-로컬 저장소 (ADR-0197).
 *
 * `PairingVault` 에 넣지 않는다. 채널은 비밀이 아니고, 생체 게이트 뒤에 두면
 * 잠금 해제 전에는 확인 자체가 불가능해진다.
 */
interface UpdateStore {
    var channel: UpdateChannel
    var lastCheckedAtEpochMillis: Long?

    /** 배너를 닫은 버전. null 이면 닫은 것이 없다. */
    var dismissedVersion: String?
}

class SharedPreferencesUpdateStore(context: Context) : UpdateStore {
    private val preferences =
        context.applicationContext.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)

    override var channel: UpdateChannel
        get() = UpdateChannel.fromStoredValue(preferences.getString(KEY_CHANNEL, null))
        set(value) {
            preferences.edit().putString(KEY_CHANNEL, value.id).apply()
        }

    override var lastCheckedAtEpochMillis: Long?
        get() = preferences.getLong(KEY_LAST_CHECKED_AT, 0L).takeIf { it > 0L }
        set(value) {
            preferences.edit().putLong(KEY_LAST_CHECKED_AT, value ?: 0L).apply()
        }

    override var dismissedVersion: String?
        get() = preferences.getString(KEY_DISMISSED_VERSION, null)
        set(value) {
            preferences.edit().putString(KEY_DISMISSED_VERSION, value).apply()
        }

    private companion object {
        const val FILE_NAME = "laymux_app_update"
        const val KEY_CHANNEL = "channel"
        const val KEY_LAST_CHECKED_AT = "last_checked_at"
        const val KEY_DISMISSED_VERSION = "dismissed_version"
    }
}
