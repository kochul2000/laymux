package com.laymux.android.update

/**
 * 업데이트 표시의 원시 상태와 그것에서 도출하는 계산 (ADR-0197, ADR-0005).
 *
 * 배너와 설정 섹션은 같은 계산의 두 투영이다. 계산은 Android 프레임워크 없이
 * 단위 테스트한다 — "이 상태에서 배너가 뜨는가" 를 화면으로만 확인하면 조건이
 * 늘어날 때마다 회귀를 놓친다.
 */

/** 배너가 겹치면 안 되는 표면을 구분한다. */
enum class UpdateSurface {
    /** 터미널 세션. 픽셀 하나가 입력 대상이므로 상단 오버레이를 띄우지 않는다. */
    REMOTE,
    OTHER,
}

/** 확인이 찾아낸 후보. */
data class AvailableUpdate(
    val version: String,
    val releaseUrl: String,
)

data class UpdateState(
    /** 확인 자체가 가능한가. debug 빌드와 파싱 불가 `versionName` 이 여기서 걸린다. */
    val enabled: Boolean,
    val currentVersion: String,
    val channel: UpdateChannel,
    val checking: Boolean,
    val lastCheckedAtEpochMillis: Long?,
    val available: AvailableUpdate?,
    /** 배너를 닫은 버전. 그 버전에서만 침묵하고 다음 버전에서는 다시 뜬다. */
    val dismissedVersion: String?,
    val lastError: String?,
    val surface: UpdateSurface,
)

data class UpdateBannerPresentation(
    val visible: Boolean,
    val version: String?,
    val releaseUrl: String?,
    val channel: UpdateChannel,
)

enum class UpdateSectionStatus {
    /** 이 빌드는 확인하지 않는다. */
    DISABLED,
    CHECKING,
    AVAILABLE,
    UP_TO_DATE,
    /** 확인이 실패했다. 최신 상태와 같은 표시로 접지 않는다. */
    ERROR,
    NEVER_CHECKED,
}

data class UpdateSectionPresentation(
    val status: UpdateSectionStatus,
    val currentVersion: String,
    val channel: UpdateChannel,
    val availableVersion: String?,
    val releaseUrl: String?,
    val checkEnabled: Boolean,
    val channelChoiceEnabled: Boolean,
    val betaWarningVisible: Boolean,
    val lastError: String?,
    val lastCheckedAtEpochMillis: Long?,
)

/**
 * 배너는 후보가 있고, 그 버전을 닫지 않았고, Remote 표면이 아닐 때만 뜬다.
 * 확인 오류는 배너로 올리지 않는다 — 네트워크 실패를 배너로 알리면 배너의
 * 의미가 "새 버전 있음" 에서 흐려진다.
 */
fun presentUpdateBanner(state: UpdateState): UpdateBannerPresentation {
    val candidate = state.available
    val visible = state.enabled &&
        candidate != null &&
        candidate.version != state.dismissedVersion &&
        state.surface != UpdateSurface.REMOTE
    return UpdateBannerPresentation(
        visible = visible,
        version = if (visible) candidate?.version else null,
        releaseUrl = if (visible) candidate?.releaseUrl else null,
        channel = state.channel,
    )
}

fun presentUpdateSection(state: UpdateState): UpdateSectionPresentation {
    val status = when {
        !state.enabled -> UpdateSectionStatus.DISABLED
        state.checking -> UpdateSectionStatus.CHECKING
        state.available != null -> UpdateSectionStatus.AVAILABLE
        state.lastError != null -> UpdateSectionStatus.ERROR
        state.lastCheckedAtEpochMillis == null -> UpdateSectionStatus.NEVER_CHECKED
        else -> UpdateSectionStatus.UP_TO_DATE
    }
    return UpdateSectionPresentation(
        status = status,
        currentVersion = state.currentVersion,
        channel = state.channel,
        // 닫은 배너는 설정 섹션의 후보를 숨기지 않는다. 닫기는 "지금 안 받는다"
        // 이지 "잊어라" 가 아니고, 사용자가 설정을 열었다면 묻고 있는 것이다.
        availableVersion = state.available?.version,
        releaseUrl = state.available?.releaseUrl,
        checkEnabled = state.enabled && !state.checking,
        channelChoiceEnabled = !state.checking,
        betaWarningVisible = state.channel == UpdateChannel.BETA,
        lastError = state.lastError,
        lastCheckedAtEpochMillis = state.lastCheckedAtEpochMillis,
    )
}
