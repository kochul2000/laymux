package com.laymux.android.pairing

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.nio.charset.StandardCharsets

class PairingAckException(
    message: String,
    val pairingInvalidated: Boolean = false,
) : IllegalStateException(message)

class PairingAckClient(
    private val connectTimeoutMillis: Int = 10_000,
    private val readTimeoutMillis: Int = 10_000,
) {
    fun confirm(session: PairingAckSession): PairingConfirmation {
        val target = session.endpoint.resolve(ACK_PATH).toURL()
        val connection = target.openConnection() as? HttpURLConnection
            ?: throw PairingAckException("Relay 연결을 열지 못했습니다.")
        val requestBody = session.request.toJson().toByteArray(StandardCharsets.UTF_8)
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = connectTimeoutMillis
            connection.readTimeout = readTimeoutMillis
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(requestBody.size)
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.outputStream.use { it.write(requestBody) }

            return when (connection.responseCode) {
                HttpURLConnection.HTTP_OK -> session.verifyResponse(
                    readBounded(connection.inputStream, RESPONSE_BYTES_LIMIT),
                )
                HttpURLConnection.HTTP_UNAUTHORIZED -> throw PairingAckException(
                    "페어링 확인 정보가 올바르지 않습니다. 새 값을 다시 받으세요.",
                    pairingInvalidated = true,
                )
                HttpURLConnection.HTTP_CONFLICT -> throw PairingAckException(
                    "이 페어링 값은 다른 Android 클라이언트가 이미 사용했습니다.",
                    pairingInvalidated = true,
                )
                HttpURLConnection.HTTP_GONE -> throw PairingAckException(
                    "페어링 값이 만료됐습니다. 새 값을 스캔하거나 붙여넣으세요.",
                    pairingInvalidated = true,
                )
                HttpURLConnection.HTTP_UNAVAILABLE -> throw PairingAckException(
                    "데스크톱이 오프라인입니다. 원격 제어를 켠 뒤 다시 시도하세요.",
                )
                else -> throw PairingAckException("데스크톱 페어링 확인에 실패했습니다.")
            }
        } catch (error: PairingAckException) {
            throw error
        } catch (_: Exception) {
            throw PairingAckException("Relay에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.")
        } finally {
            java.util.Arrays.fill(requestBody, 0)
            connection.disconnect()
        }
    }

    private fun readBounded(stream: InputStream, limit: Int): String = stream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(1_024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (output.size() + read > limit) {
                throw PairingAckException("데스크톱 확인 응답이 너무 큽니다.")
            }
            output.write(buffer, 0, read)
        }
        output.toString(StandardCharsets.UTF_8.name())
    }

    companion object {
        private const val ACK_PATH = "/api/android/pair/ack"
        private const val RESPONSE_BYTES_LIMIT = 8 * 1024
    }
}
