package com.laymux.android.update

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

/** 확인 1회의 결과. 실패는 "최신" 과 구분해 남긴다 (ADR-0197). */
sealed interface UpdateCheckResult {
    data class Found(val update: AvailableUpdate) : UpdateCheckResult

    data object UpToDate : UpdateCheckResult

    data class Failed(val message: String) : UpdateCheckResult
}

/**
 * 채널 매니페스트를 한 번 조회해 후보를 판정한다 (ADR-0197).
 *
 * 호출은 블로킹이다 — 호출자가 자기 실행기에서 돌리고, 앱이 파괴된 뒤 도착한
 * 결과는 버린다. 판정(버전 비교·문법 검사)은 전부 순수 코드에 있고 여기 있는
 * 것은 전송뿐이다.
 */
class UpdateCheckClient(
    private val connectionFactory: (URI) -> HttpURLConnection = { uri ->
        uri.toURL().openConnection() as HttpURLConnection
    },
) {
    fun check(channel: UpdateChannel, currentVersion: ReleaseVersion): UpdateCheckResult {
        val body = try {
            fetch(UpdateEndpoints.manifestUrl(channel))
        } catch (error: UpdateManifestException) {
            return UpdateCheckResult.Failed(error.message.orEmpty())
        } catch (error: Exception) {
            return UpdateCheckResult.Failed("업데이트 확인에 실패했습니다.")
        }
        val manifest = try {
            AndroidUpdateManifests.parse(channel, body)
        } catch (error: UpdateManifestException) {
            return UpdateCheckResult.Failed(error.message.orEmpty())
        }
        // 다운그레이드는 제안하지 않는다. 채널을 되돌린 사용자가 후보를 못 보는
        // 상태는 오류가 아니라 정상이다.
        if (manifest.version <= currentVersion) return UpdateCheckResult.UpToDate
        return UpdateCheckResult.Found(
            AvailableUpdate(
                version = manifest.version.version,
                releaseUrl = manifest.releaseUrl,
            ),
        )
    }

    private fun fetch(url: String): String {
        val connection = connectionFactory(URI(url))
        return try {
            connection.requestMethod = "GET"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Accept", "application/json")
            // raw.githubusercontent.com 은 짧은 캐시를 가진다. 발행 직후 확인이
            // 옛 매니페스트를 다시 읽는 것을 막는다.
            connection.setRequestProperty("Cache-Control", "no-cache")
            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.close()
                // 404 는 "최신" 이 아니라 배포 경로가 끊긴 것이다.
                throw UpdateManifestException("업데이트 채널이 HTTP $status 응답을 반환했습니다.")
            }
            readBounded(connection.inputStream, RESPONSE_LIMIT)
        } finally {
            connection.disconnect()
        }
    }

    private fun readBounded(stream: InputStream, limit: Int): String = stream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (output.size() + read > limit) {
                throw UpdateManifestException("업데이트 매니페스트가 허용 크기를 초과했습니다.")
            }
            output.write(buffer, 0, read)
        }
        output.toString(StandardCharsets.UTF_8.name())
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 15_000

        /** 매니페스트는 1KB 미만이다. 이 상한은 응답이 매니페스트가 아닐 때를 위한 것이다. */
        const val RESPONSE_LIMIT = 64 * 1024
    }
}
