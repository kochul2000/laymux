package com.laymux.android.update

/**
 * 이 설치본이 따라가는 릴리스 계열 (ADR-0197).
 *
 * 채널은 기기-로컬 앱 설정이며 데스크톱의 `settings.json` 에서 상속하지 않는다.
 * 폰은 미페어링·미연결 상태로도 켜지므로, 확인이 데스크톱 가용성에 묶이면
 * 정작 갱신이 절실한 상태(compat 거부로 연결이 안 되는 상태)에서 채널을 읽을
 * 수 없다.
 */
enum class UpdateChannel(val id: String) {
    STABLE("stable"),
    BETA("beta"),
    ;

    companion object {
        /**
         * 알 수 없는 값은 stable 로 읽는다. 오독이 사용자를 테스트 계열로
         * 올리는 방향으로 기울면 안 된다 (ADR-0190 과 같은 편향).
         */
        fun fromStoredValue(raw: String?): UpdateChannel =
            if (raw == BETA.id) BETA else STABLE
    }
}

/**
 * 매니페스트 endpoint 와 릴리스 페이지 주소. host·저장소·브랜치·파일명은
 * 바이너리에 고정하며 설정으로 바꿀 수 없다 (ADR-0190·ADR-0197).
 */
object UpdateEndpoints {
    const val OWNER = "kochul2000"
    const val REPO = "laymux"
    private const val MANIFEST_HOST = "raw.githubusercontent.com"
    private const val MANIFEST_BRANCH = "release-channels"

    /** 이 릴리스 페이지 접두사 밖의 URL 은 열지 않는다. */
    const val RELEASE_TAG_URL_PREFIX =
        "https://github.com/$OWNER/$REPO/releases/tag/"

    fun manifestUrl(channel: UpdateChannel): String =
        "https://$MANIFEST_HOST/$OWNER/$REPO/$MANIFEST_BRANCH/android-${channel.id}.json"
}
