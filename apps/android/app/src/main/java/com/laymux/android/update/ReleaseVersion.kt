package com.laymux.android.update

/**
 * 릴리스 버전 문자열 계약 (ADR-0190·ADR-0197).
 *
 * `x.y.z` 와 `x.y.z-beta.N` 만 받는다. 다른 prerelease 라벨과 build metadata 를
 * 거절하는 이유는 채널을 넓히는 것이 임의 문자열 수용으로 번지지 않게 하는
 * 것이고, 같은 계약이 `scripts/release/release-version.mjs` 와
 * `src-tauri/src/app_update.rs` 에도 각각 있다. 세 사본이 갈라지면 폰만 후보를
 * 놓치거나 폰만 잘못된 후보를 받으므로, 경계값은 각 사본이 자기 테스트로
 * 고정한다.
 */
data class ReleaseVersion(
    val version: String,
    val major: Int,
    val minor: Int,
    val patch: Int,
    val beta: Int?,
) : Comparable<ReleaseVersion> {
    /** prerelease 가 없는 쪽이 크다. 같은 `x.y.z` 에서 정식 > beta.N 이다. */
    override fun compareTo(other: ReleaseVersion): Int {
        if (major != other.major) return major - other.major
        if (minor != other.minor) return minor - other.minor
        if (patch != other.patch) return patch - other.patch
        val mine = beta
        val theirs = other.beta
        return when {
            mine == theirs -> 0
            mine == null -> 1
            theirs == null -> -1
            else -> mine - theirs
        }
    }

    companion object {
        // 선행 0 을 거절한다: `0.11.01` 같은 값은 발행 실수이고, 받아 주면 같은
        // 릴리스를 가리키는 문자열이 둘 생긴다.
        private val PATTERN = Regex(
            """^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?$""",
        )

        /**
         * 파싱에 실패하면 null. 호출자는 이 결과를 오류가 아니라 "확인 비활성"
         * 으로 다룬다 — 로컬 개발 빌드의 기본 `versionName` 이 여기로 온다.
         */
        fun parseOrNull(raw: String?): ReleaseVersion? {
            val match = PATTERN.matchEntire(raw?.trim().orEmpty()) ?: return null
            val (major, minor, patch, beta) = match.destructured
            return ReleaseVersion(
                version = if (beta.isEmpty()) {
                    "$major.$minor.$patch"
                } else {
                    "$major.$minor.$patch-beta.$beta"
                },
                major = major.toInt(),
                minor = minor.toInt(),
                patch = patch.toInt(),
                beta = beta.ifEmpty { null }?.toInt(),
            )
        }
    }
}
