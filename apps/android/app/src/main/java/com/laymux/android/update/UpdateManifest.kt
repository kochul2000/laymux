package com.laymux.android.update

import org.json.JSONObject

/** 매니페스트를 신뢰할 수 없을 때 던진다. 호출자는 확인 오류로 표시한다. */
class UpdateManifestException(message: String) : IllegalArgumentException(message)

/**
 * `android-<channel>.json` 의 클라이언트 표현 (ADR-0197).
 *
 * `apkUrl`·`apkSha256Url` 은 자체 설치를 붙이는 후속 결정을 위해 발행 쪽이
 * 기록하는 필드이고 이 클라이언트는 읽지 않는다. 없거나 형식이 어긋나도 확인을
 * 실패시키지 않는다.
 */
data class AndroidUpdateManifest(
    val version: ReleaseVersion,
    val releaseUrl: String,
)

object AndroidUpdateManifests {
    /**
     * 채널 계약과 릴리스 페이지 문법을 검사한 매니페스트만 돌려준다.
     *
     * `releaseUrl` 을 매니페스트가 준 대로 열지 않는 이유: `ACTION_VIEW` 는 이
     * 기능의 유일한 외부 효과이므로, 변조·오발행된 매니페스트가 임의 주소로
     * 사용자를 보내는 경로를 문법 단계에서 끊는다. 통과하면 최대치는 같은
     * 저장소의 다른 릴리스 페이지다.
     */
    fun parse(channel: UpdateChannel, body: String): AndroidUpdateManifest {
        val json = try {
            JSONObject(body)
        } catch (error: org.json.JSONException) {
            throw UpdateManifestException("매니페스트를 읽을 수 없습니다: ${error.message}")
        }
        val rawVersion = json.optString("version").takeIf { it.isNotEmpty() }
            ?: throw UpdateManifestException("매니페스트에 version 이 없습니다")
        val version = ReleaseVersion.parseOrNull(rawVersion)
            ?: throw UpdateManifestException("지원하지 않는 버전 형식입니다: $rawVersion")
        // stable 채널 파일에 prerelease 가 들어가면 그 채널은 오류도 후보도 없이
        // 멈춘다. 발행 쪽과 같은 판정을 여기서 한 번 더 한다.
        if (channel == UpdateChannel.STABLE && version.beta != null) {
            throw UpdateManifestException("stable 채널에 테스트 버전이 올라와 있습니다: $rawVersion")
        }

        val releaseUrl = json.optString("releaseUrl").takeIf { it.isNotEmpty() }
            ?: throw UpdateManifestException("매니페스트에 releaseUrl 이 없습니다")
        if (!isReleaseTagUrl(releaseUrl, version)) {
            throw UpdateManifestException("릴리스 페이지 주소가 아닙니다: $releaseUrl")
        }

        return AndroidUpdateManifest(version = version, releaseUrl = releaseUrl)
    }

    /**
     * 고정 접두사 하위이고, 남는 부분이 이 버전의 태그(`v?x.y.z`)와 정확히
     * 같아야 한다. 경로·질의·프래그먼트가 더 붙는 것도 거절한다.
     */
    private fun isReleaseTagUrl(url: String, version: ReleaseVersion): Boolean {
        if (!url.startsWith(UpdateEndpoints.RELEASE_TAG_URL_PREFIX)) return false
        val tag = url.substring(UpdateEndpoints.RELEASE_TAG_URL_PREFIX.length)
        return tag == version.version || tag == "v${version.version}"
    }
}
