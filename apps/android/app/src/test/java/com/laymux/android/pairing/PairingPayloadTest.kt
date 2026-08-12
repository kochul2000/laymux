package com.laymux.android.pairing

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingPayloadTest {
    private val now = 1_786_500_000L
    private val expires = now + 300
    private val pairingId = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(PairingPayload.PAIRING_ID_BYTES) { (it + 16).toByte() })
    private val secret = ByteArray(PairingPayload.SECRET_BYTES) { it.toByte() }
    private val encodedSecret = Base64.getUrlEncoder().withoutPadding().encodeToString(secret)

    @Test
    fun parsesVersionedPairingQr() {
        PairingPayload.parse(
            pairingUri(
                endpoint = "https://app.laymux.com",
                instance = "desktop-7",
                secret = encodedSecret,
                label = "작업 PC",
            ),
            nowEpochSeconds = now,
        ).use { payload ->
            assertEquals("https://app.laymux.com/", payload.endpoint.toString())
            assertEquals("desktop-7", payload.instanceId)
            assertEquals("작업 PC", payload.label)
            assertEquals(pairingId, payload.pairingId)
            assertEquals(expires, payload.expiresAtEpochSeconds)
            assertEquals(secret.toList(), payload.secretCopy().toList())
            assertFalse(payload.toString().contains(encodedSecret))
        }
    }

    @Test
    fun acceptsCleartextOnlyForLoopbackDevelopmentEndpoint() {
        PairingPayload.parse(
            pairingUri("http://127.0.0.1:8000", "dev", encodedSecret),
            allowLoopbackHttp = true,
            nowEpochSeconds = now,
        ).close()
        PairingPayload.parse(
            pairingUri("http://[::1]:8000", "dev-v6", encodedSecret),
            allowLoopbackHttp = true,
            nowEpochSeconds = now,
        ).close()

        assertThrows(IllegalArgumentException::class.java) {
            PairingPayload.parse(
                pairingUri("http://127.0.0.1:8000", "release", encodedSecret),
                nowEpochSeconds = now,
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            PairingPayload.parse(
                pairingUri("http://192.0.2.10:8000", "plain-http", encodedSecret),
                allowLoopbackHttp = true,
                nowEpochSeconds = now,
            )
        }
    }

    @Test
    fun rejectsWrongSchemeAuthorityOrVersion() {
        val validQuery = "endpoint=${encode("https://app.laymux.com")}" +
            "&instance=desktop&pairing=$pairingId&expires=$expires&secret=$encodedSecret"

        listOf(
            "https://pair/v1?$validQuery",
            "laymux://other/v1?$validQuery",
            "laymux://pair/v1?$validQuery",
            "laymux://pair/v3?$validQuery",
            "laymux://pair/v2?$validQuery#fragment",
        ).forEach { raw ->
            assertThrows(raw, IllegalArgumentException::class.java) {
                PairingPayload.parse(raw, nowEpochSeconds = now)
            }
        }
    }

    @Test
    fun rejectsDuplicateMissingAndUnknownFields() {
        val valid = pairingUri("https://app.laymux.com", "desktop", encodedSecret)

        listOf(
            "$valid&secret=$encodedSecret",
            "laymux://pair/v2?endpoint=${encode("https://app.laymux.com")}&secret=$encodedSecret",
            "$valid&token=must-not-be-accepted",
        ).forEach { raw ->
            assertThrows(raw, IllegalArgumentException::class.java) {
                PairingPayload.parse(raw, nowEpochSeconds = now)
            }
        }
    }

    @Test
    fun rejectsMalformedOrWrongLengthSecretWithoutEchoingIt() {
        listOf(
            "not-base64!",
            Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(31)),
            Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(33)),
        ).forEach { badSecret ->
            val error = assertThrows(IllegalArgumentException::class.java) {
                PairingPayload.parse(
                    pairingUri("https://app.laymux.com", "desktop", badSecret),
                    nowEpochSeconds = now,
                )
            }
            assertFalse(error.message.orEmpty().contains(badSecret))
        }
    }

    @Test
    fun rejectsEndpointCredentialsQueryAndFragment() {
        listOf(
            "https://user:password@app.laymux.com",
            "https://app.laymux.com?token=secret",
            "https://app.laymux.com/#secret",
        ).forEach { endpoint ->
            assertThrows(endpoint, IllegalArgumentException::class.java) {
                PairingPayload.parse(
                    pairingUri(endpoint, "desktop", encodedSecret),
                    nowEpochSeconds = now,
                )
            }
        }
    }

    @Test
    fun rejectsUnsafeInstanceAndLabelValues() {
        listOf("", "../desktop", "desktop id", "a".repeat(129)).forEach { instance ->
            assertThrows(instance, IllegalArgumentException::class.java) {
                PairingPayload.parse(
                    pairingUri("https://app.laymux.com", instance, encodedSecret),
                    nowEpochSeconds = now,
                )
            }
        }
        assertThrows(IllegalArgumentException::class.java) {
            PairingPayload.parse(
                pairingUri("https://app.laymux.com", "desktop", encodedSecret, "bad\nlabel"),
                nowEpochSeconds = now,
            )
        }
    }

    @Test
    fun rejectsExpiredInvitation() {
        assertThrows(IllegalArgumentException::class.java) {
            PairingPayload.parse(
                pairingUri("https://app.laymux.com", "desktop", encodedSecret),
                nowEpochSeconds = expires,
            )
        }
    }

    private fun pairingUri(
        endpoint: String,
        instance: String,
        secret: String,
        label: String? = null,
    ): String {
        val optionalLabel = label?.let { "&label=${encode(it)}" }.orEmpty()
        return "laymux://pair/v2?endpoint=${encode(endpoint)}" +
            "&instance=${encode(instance)}&pairing=$pairingId&expires=$expires" +
            "&secret=${encode(secret)}$optionalLabel"
    }

    private fun encode(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
}
