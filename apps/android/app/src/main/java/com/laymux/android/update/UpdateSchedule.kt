package com.laymux.android.update

/**
 * 확인 시점 판정 (ADR-0197).
 *
 * 주기는 데스크톱과 같은 6시간이고, 트리거는 앱 콜드 스타트와 전면 복귀뿐이다.
 * 백그라운드 워커·시스템 알림은 쓰지 않는다 — 앱을 켜지 않은 사용자에게 알릴
 * 필요가 없는 등급의 정보이고, 그 경로는 권한과 배터리 정책을 새로 들여온다.
 */
object UpdateSchedule {
    const val INTERVAL_MILLIS: Long = 6L * 60L * 60L * 1000L

    /** 사용자가 명시적으로 물었을 때 "아직 확인할 시간이 아니다" 로 답하지 않는다. */
    enum class Trigger { PERIODIC, MANUAL }

    fun shouldCheck(
        enabled: Boolean,
        checking: Boolean,
        lastCheckedAtEpochMillis: Long?,
        nowEpochMillis: Long,
        trigger: Trigger,
    ): Boolean {
        if (!enabled) return false
        // 진행 중인 확인이 있으면 겹쳐 쏘지 않는다. 수동 확인도 마찬가지다 —
        // 버튼 연타가 요청을 쌓으면 마지막 응답이 무엇인지 알 수 없다.
        if (checking) return false
        if (trigger == Trigger.MANUAL) return true
        val last = lastCheckedAtEpochMillis ?: return true
        // 저장된 시각이 미래면 기기 시계가 뒤로 갔거나 값이 손상된 것이다. 그
        // 상태를 "아직 이르다" 로 읽으면 시계가 돌아올 때까지 확인이 멈춘다.
        if (last > nowEpochMillis) return true
        return nowEpochMillis - last >= INTERVAL_MILLIS
    }
}
