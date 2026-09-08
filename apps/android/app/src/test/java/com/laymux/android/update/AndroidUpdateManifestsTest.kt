package com.laymux.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidUpdateManifestsTest {
    private fun manifestJson(
        version: String = "0.11.2",
        releaseUrl: String = "https://github.com/kochul2000/laymux/releases/tag/v0.11.2",
        extra: String = "",
    ): String = """
        {
          "version": "$version",
          "versionCode": 110029,
          "releaseUrl": "$releaseUrl",
          "apkUrl": "https://github.com/kochul2000/laymux/releases/download/v0.11.2/Laymux-Android-0.11.2.apk",
          "apkSha256Url": "https://github.com/kochul2000/laymux/releases/download/v0.11.2/Laymux-Android-0.11.2.apk.sha256",
          "pubDate": "2026-08-24T00:00:00Z"$extra
        }
    """.trimIndent()

    @Test
    fun `정상 매니페스트는 버전과 릴리스 페이지를 준다`() {
        val manifest = AndroidUpdateManifests.parse(UpdateChannel.STABLE, manifestJson())
        assertEquals("0.11.2", manifest.version.version)
        assertEquals(
            "https://github.com/kochul2000/laymux/releases/tag/v0.11.2",
            manifest.releaseUrl,
        )
    }

    @Test
    fun `beta 채널은 prerelease 버전을 받는다`() {
        val manifest = AndroidUpdateManifests.parse(
            UpdateChannel.BETA,
            manifestJson(
                version = "0.12.0-beta.2",
                releaseUrl = "https://github.com/kochul2000/laymux/releases/tag/v0.12.0-beta.2",
            ),
        )
        assertEquals("0.12.0-beta.2", manifest.version.version)
    }

    @Test
    fun `stable 채널에 prerelease 가 올라오면 거절한다`() {
        assertThrows(UpdateManifestException::class.java) {
            AndroidUpdateManifests.parse(
                UpdateChannel.STABLE,
                manifestJson(
                    version = "0.12.0-beta.2",
                    releaseUrl = "https://github.com/kochul2000/laymux/releases/tag/v0.12.0-beta.2",
                ),
            )
        }
    }

    @Test
    fun `저장소 밖 릴리스 주소는 거절한다`() {
        val hostile = listOf(
            "https://example.com/kochul2000/laymux/releases/tag/v0.11.2",
            "https://github.com/someone/else/releases/tag/v0.11.2",
            "http://github.com/kochul2000/laymux/releases/tag/v0.11.2",
            "https://github.com/kochul2000/laymux/releases/download/v0.11.2/evil.apk",
        )
        for (url in hostile) {
            assertThrows(url, UpdateManifestException::class.java) {
                AndroidUpdateManifests.parse(UpdateChannel.STABLE, manifestJson(releaseUrl = url))
            }
        }
    }

    @Test
    fun `태그가 버전과 다르거나 경로가 더 붙으면 거절한다`() {
        val mismatched = listOf(
            "https://github.com/kochul2000/laymux/releases/tag/v0.11.3",
            "https://github.com/kochul2000/laymux/releases/tag/v0.11.2/extra",
            "https://github.com/kochul2000/laymux/releases/tag/v0.11.2?x=1",
            "https://github.com/kochul2000/laymux/releases/tag/",
        )
        for (url in mismatched) {
            assertThrows(url, UpdateManifestException::class.java) {
                AndroidUpdateManifests.parse(UpdateChannel.STABLE, manifestJson(releaseUrl = url))
            }
        }
    }

    @Test
    fun `v 접두사 없는 태그도 같은 버전이면 받는다`() {
        val manifest = AndroidUpdateManifests.parse(
            UpdateChannel.STABLE,
            manifestJson(releaseUrl = "https://github.com/kochul2000/laymux/releases/tag/0.11.2"),
        )
        assertEquals("0.11.2", manifest.version.version)
    }

    @Test
    fun `버전이 없거나 형식이 어긋나면 거절한다`() {
        assertThrows(UpdateManifestException::class.java) {
            AndroidUpdateManifests.parse(UpdateChannel.STABLE, """{"releaseUrl":"x"}""")
        }
        assertThrows(UpdateManifestException::class.java) {
            AndroidUpdateManifests.parse(UpdateChannel.STABLE, manifestJson(version = "latest"))
        }
    }

    @Test
    fun `매니페스트가 아닌 본문은 거절한다`() {
        assertThrows(UpdateManifestException::class.java) {
            AndroidUpdateManifests.parse(UpdateChannel.STABLE, "<html>404</html>")
        }
    }

    @Test
    fun `쓰지 않는 apk 필드가 빠져도 통과한다`() {
        val manifest = AndroidUpdateManifests.parse(
            UpdateChannel.STABLE,
            """
            {
              "version": "0.11.2",
              "releaseUrl": "https://github.com/kochul2000/laymux/releases/tag/v0.11.2"
            }
            """.trimIndent(),
        )
        assertEquals("0.11.2", manifest.version.version)
    }

    @Test
    fun `매니페스트 endpoint 는 채널별 고정 주소다`() {
        assertEquals(
            "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/android-stable.json",
            UpdateEndpoints.manifestUrl(UpdateChannel.STABLE),
        )
        assertEquals(
            "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/android-beta.json",
            UpdateEndpoints.manifestUrl(UpdateChannel.BETA),
        )
    }

    @Test
    fun `알 수 없는 채널 값은 stable 로 읽는다`() {
        assertEquals(UpdateChannel.STABLE, UpdateChannel.fromStoredValue(null))
        assertEquals(UpdateChannel.STABLE, UpdateChannel.fromStoredValue("nightly"))
        assertEquals(UpdateChannel.STABLE, UpdateChannel.fromStoredValue("BETA"))
        assertEquals(UpdateChannel.BETA, UpdateChannel.fromStoredValue("beta"))
    }
}
