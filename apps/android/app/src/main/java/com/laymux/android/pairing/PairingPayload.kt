package com.laymux.android.pairing

import java.io.Closeable
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Arrays

/**
 * Validated v2 pairing payload from a QR scan or explicit clipboard paste.
 * The secret is deliberately absent from properties,
 * [toString], and exception messages; callers can only take a defensive copy.
 */
class PairingPayload private constructor(
    val endpoint: URI,
    val instanceId: String,
    val pairingId: String,
    val expiresAtEpochSeconds: Long,
    val label: String?,
    private val secret: ByteArray,
) : Closeable {
    internal fun secretCopy(): ByteArray = secret.copyOf()

    override fun close() {
        Arrays.fill(secret, 0)
    }

    override fun toString(): String =
        "PairingPayload(endpoint=$endpoint, instanceId=$instanceId, " +
            "pairingId=$pairingId, expiresAtEpochSeconds=$expiresAtEpochSeconds, " +
            "label=$label, secret=<redacted>)"

    companion object {
        const val SECRET_BYTES = 32
        const val PAIRING_ID_BYTES = 16

        private const val MAX_ENDPOINT_LENGTH = 2048
        private const val MAX_PAYLOAD_LENGTH = 4096
        private const val MAX_LABEL_LENGTH = 80
        private val INSTANCE_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
        private val PAIRING_ID_PATTERN = Regex("^[A-Za-z0-9_-]{22}$")
        private val SECRET_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")
        private val REQUIRED_FIELDS = setOf("endpoint", "instance", "pairing", "expires", "secret")
        private val ALLOWED_FIELDS = REQUIRED_FIELDS + "label"

        fun parse(
            raw: String,
            allowLoopbackHttp: Boolean = false,
            nowEpochSeconds: Long = System.currentTimeMillis() / 1_000,
        ): PairingPayload {
            if (raw.length > MAX_PAYLOAD_LENGTH) {
                throw invalid("페어링 값이 너무 깁니다")
            }
            val uri = try {
                URI(raw)
            } catch (_: Exception) {
                throw invalid("페어링 값 형식이 올바르지 않습니다")
            }
            if (!uri.scheme.equals("laymux", ignoreCase = true) ||
                !uri.host.equals("pair", ignoreCase = true) ||
                uri.port != -1 ||
                uri.userInfo != null ||
                uri.path != "/v2" ||
                uri.fragment != null
            ) {
                throw invalid("지원하지 않는 Laymux 페어링 값입니다")
            }

            val fields = parseQuery(uri.rawQuery)
            if (!fields.keys.containsAll(REQUIRED_FIELDS)) {
                throw invalid("페어링 값에 필수 항목이 없습니다")
            }
            val unknown = fields.keys - ALLOWED_FIELDS
            if (unknown.isNotEmpty()) {
                throw invalid("페어링 값에 지원하지 않는 항목이 있습니다")
            }

            val endpoint = validateEndpoint(fields.getValue("endpoint"), allowLoopbackHttp)
            val instanceId = fields.getValue("instance")
            if (!INSTANCE_PATTERN.matches(instanceId)) {
                throw invalid("인스턴스 식별자가 올바르지 않습니다")
            }
            val pairingId = fields.getValue("pairing")
            decodeFixedBase64Url(
                encoded = pairingId,
                pattern = PAIRING_ID_PATTERN,
                expectedBytes = PAIRING_ID_BYTES,
                errorMessage = "페어링 식별자가 올바르지 않습니다",
            ).also { Arrays.fill(it, 0) }
            val expiresAtEpochSeconds = fields.getValue("expires").toLongOrNull()
                ?.takeIf { it > 0 && it > nowEpochSeconds }
                ?: throw invalid("페어링 값이 만료됐습니다")
            val label = fields["label"]?.also {
                if (it.isBlank() ||
                    it.length > MAX_LABEL_LENGTH ||
                    it.any(Char::isISOControl)
                ) {
                    throw invalid("기기 이름이 올바르지 않습니다")
                }
            }
            val secret = decodeSecret(fields.getValue("secret"))

            return PairingPayload(
                endpoint,
                instanceId,
                pairingId,
                expiresAtEpochSeconds,
                label,
                secret,
            )
        }

        private fun parseQuery(rawQuery: String?): Map<String, String> {
            if (rawQuery.isNullOrEmpty()) {
                throw invalid("페어링 값에 쿼리가 없습니다")
            }
            val fields = linkedMapOf<String, String>()
            rawQuery.split('&').forEach { pair ->
                val separator = pair.indexOf('=')
                if (separator <= 0) {
                    throw invalid("페어링 값 쿼리가 올바르지 않습니다")
                }
                val key = decodeQueryComponent(pair.substring(0, separator))
                val value = decodeQueryComponent(pair.substring(separator + 1))
                if (key in fields) {
                    throw invalid("페어링 값에 중복 항목이 있습니다")
                }
                fields[key] = value
            }
            return fields
        }

        private fun decodeQueryComponent(value: String): String = try {
            URLDecoder.decode(value, StandardCharsets.UTF_8.name())
        } catch (_: Exception) {
            throw invalid("페어링 값 인코딩이 올바르지 않습니다")
        }

        private fun validateEndpoint(raw: String, allowLoopbackHttp: Boolean): URI {
            if (raw.length > MAX_ENDPOINT_LENGTH) {
                throw invalid("Relay 주소가 너무 깁니다")
            }
            val endpoint = try {
                URI(raw)
            } catch (_: Exception) {
                throw invalid("Relay 주소가 올바르지 않습니다")
            }
            val scheme = endpoint.scheme?.lowercase()
            val host = endpoint.host
                ?.removePrefix("[")
                ?.removeSuffix("]")
                ?.lowercase()
            val loopbackHttp = allowLoopbackHttp &&
                scheme == "http" &&
                (host == "127.0.0.1" || host == "::1")
            if ((scheme != "https" && !loopbackHttp) ||
                host.isNullOrBlank() ||
                endpoint.rawUserInfo != null ||
                endpoint.rawQuery != null ||
                endpoint.rawFragment != null ||
                (endpoint.rawPath.isNotEmpty() && endpoint.rawPath != "/")
            ) {
                throw invalid("Relay 주소는 HTTPS origin이어야 합니다")
            }
            return URI(scheme, null, host, endpoint.port, "/", null, null)
        }

        private fun decodeSecret(encoded: String): ByteArray = decodeFixedBase64Url(
            encoded = encoded,
            pattern = SECRET_PATTERN,
            expectedBytes = SECRET_BYTES,
            errorMessage = "페어링 키 형식이 올바르지 않습니다",
        )

        private fun decodeFixedBase64Url(
            encoded: String,
            pattern: Regex,
            expectedBytes: Int,
            errorMessage: String,
        ): ByteArray {
            if (!pattern.matches(encoded)) throw invalid(errorMessage)
            val decoded = ByteArray(expectedBytes)
            var accumulator = 0
            var bits = 0
            var output = 0
            encoded.forEach { character ->
                val value = when (character) {
                    in 'A'..'Z' -> character.code - 'A'.code
                    in 'a'..'z' -> character.code - 'a'.code + 26
                    in '0'..'9' -> character.code - '0'.code + 52
                    '-' -> 62
                    '_' -> 63
                    else -> throw invalid(errorMessage)
                }
                accumulator = (accumulator shl 6) or value
                bits += 6
                if (bits >= 8) {
                    bits -= 8
                    if (output >= decoded.size) {
                        Arrays.fill(decoded, 0)
                        throw invalid(errorMessage)
                    }
                    decoded[output++] = (accumulator shr bits).toByte()
                    accumulator = if (bits == 0) 0 else accumulator and ((1 shl bits) - 1)
                }
            }
            if (output != expectedBytes || accumulator != 0) {
                Arrays.fill(decoded, 0)
                throw invalid(errorMessage)
            }
            return decoded
        }

        private fun invalid(message: String) = IllegalArgumentException(message)
    }
}
