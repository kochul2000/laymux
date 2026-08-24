package com.laymux.android.update

/**
 * 업데이트 확인의 상태 소유자 (ADR-0197).
 *
 * 화면(배너·설정 섹션)은 이 객체의 상태에서 계산으로만 도출되고, 네트워크는
 * 주입된 실행기에서 돈다. Android 타입에 의존하지 않으므로 확인 주기·채널
 * 전환·결과 반영을 JVM 단위 테스트로 고정할 수 있다.
 */
class AppUpdateController(
    private val store: UpdateStore,
    private val currentVersionName: String,
    checkEnabledBuild: Boolean,
    private val runOnWorker: (Runnable) -> Unit,
    private val runOnMain: (Runnable) -> Unit,
    private val client: UpdateCheckClient = UpdateCheckClient(),
    private val nowEpochMillis: () -> Long = { System.currentTimeMillis() },
) {
    private val currentVersion = ReleaseVersion.parseOrNull(currentVersionName)

    /**
     * 파싱 불가한 `versionName`(로컬 개발 기본값)은 오류가 아니라 비활성이다.
     * 비교 기준이 없는 상태에서 후보를 만들면 매번 "새 버전 있음" 이 뜬다.
     */
    private var enabled = checkEnabledBuild && currentVersion != null

    private var checking = false
    private var available: AvailableUpdate? = null
    private var lastError: String? = null
    private var surface = UpdateSurface.OTHER

    var onStateChanged: ((UpdateState) -> Unit)? = null

    fun state(): UpdateState = UpdateState(
        enabled = enabled,
        currentVersion = currentVersionName,
        channel = store.channel,
        checking = checking,
        lastCheckedAtEpochMillis = store.lastCheckedAtEpochMillis,
        available = available,
        dismissedVersion = store.dismissedVersion,
        lastError = lastError,
        surface = surface,
    )

    fun setSurface(next: UpdateSurface) {
        if (surface == next) return
        surface = next
        publish()
    }

    /** 채널 변경은 즉시 1회 확인을 트리거한다. 주기 확인만으로는 다음 확인까지 후보가 없다. */
    fun setChannel(next: UpdateChannel) {
        if (store.channel == next) return
        store.channel = next
        // 옛 채널에서 찾은 후보는 새 채널의 후보가 아니다.
        available = null
        lastError = null
        publish()
        check(UpdateSchedule.Trigger.MANUAL)
    }

    /** 배너 닫기. 그 버전에서만 침묵한다. */
    fun dismissAvailable() {
        val version = available?.version ?: return
        store.dismissedVersion = version
        publish()
    }

    fun check(trigger: UpdateSchedule.Trigger) {
        if (!UpdateSchedule.shouldCheck(
                enabled = enabled,
                checking = checking,
                lastCheckedAtEpochMillis = store.lastCheckedAtEpochMillis,
                nowEpochMillis = nowEpochMillis(),
                trigger = trigger,
            )
        ) {
            return
        }
        val version = currentVersion ?: return
        val channel = store.channel
        checking = true
        publish()
        runOnWorker {
            val result = client.check(channel, version)
            runOnMain { apply(channel, result) }
        }
    }

    private fun apply(checkedChannel: UpdateChannel, result: UpdateCheckResult) {
        checking = false
        // 확인 중에 채널이 바뀌면 옛 endpoint 로 떠난 요청의 응답은 버린다
        // (ADR-0190 이 데스크톱에 둔 것과 같은 세대 비교).
        if (checkedChannel != store.channel) {
            publish()
            return
        }
        when (result) {
            is UpdateCheckResult.Found -> {
                available = result.update
                lastError = null
                store.lastCheckedAtEpochMillis = nowEpochMillis()
            }
            is UpdateCheckResult.UpToDate -> {
                available = null
                lastError = null
                store.lastCheckedAtEpochMillis = nowEpochMillis()
            }
            is UpdateCheckResult.Failed -> {
                // 실패는 확인 시각을 갱신하지 않는다. 갱신하면 끊긴 배포 경로가
                // 6시간마다 한 번만 재시도되고, 그 사이 상태는 "확인함" 이 된다.
                lastError = result.message
            }
        }
        publish()
    }

    /**
     * debug 빌드의 결정적 미리보기 전용 (ADR-0197). 확인 결과 없이 후보를 주입해
     * 배너와 설정 섹션을 화면으로 관측할 수 있게 한다. 호출자가 debuggable
     * 여부를 게이트한다.
     */
    fun injectAvailableForPreview(update: AvailableUpdate) {
        enabled = true
        available = update
        lastError = null
        publish()
    }

    private fun publish() {
        onStateChanged?.invoke(state())
    }
}
