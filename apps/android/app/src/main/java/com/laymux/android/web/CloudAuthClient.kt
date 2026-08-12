package com.laymux.android.web

import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import javax.net.ssl.HttpsURLConnection

class CloudAuthException(message: String) : Exception(message)

data class CloudAuthResult(val setCookies: List<String>)

object CloudAuthResponse {
    private const val EXPECTED_LOCATION = "/dashboard?client=android"
    private const val MAX_COOKIE_LENGTH = 8 * 1024
    private const val MAX_COOKIE_BYTES = 16 * 1024

    fun requireSuccess(
        status: Int,
        location: String?,
        setCookies: List<String>,
    ): List<String> {
        if (status != 303 || location != EXPECTED_LOCATION) {
            throw CloudAuthException("Cloud authentication was rejected")
        }
        if (setCookies.size != 1 ||
            setCookies.any {
                it.isEmpty() || it.length > MAX_COOKIE_LENGTH || it.contains('\r') || it.contains('\n')
            } ||
            setCookies.sumOf { it.length } > MAX_COOKIE_BYTES
        ) {
            throw CloudAuthException("Cloud authentication cookie is invalid")
        }
        val attributes = setCookies.single().split(';').map { it.trim() }
        val nameValue = attributes.firstOrNull()?.split('=', limit = 2)
        val normalizedAttributes = attributes.drop(1).map { it.lowercase() }
        if (nameValue?.size != 2 || nameValue[0].isBlank() || nameValue[1].isBlank() ||
            "httponly" !in normalizedAttributes || "secure" !in normalizedAttributes ||
            "path=/" !in normalizedAttributes ||
            normalizedAttributes.none { it.startsWith("samesite=") } ||
            normalizedAttributes.any { it.startsWith("domain=") }
        ) {
            throw CloudAuthException("Cloud authentication cookie attributes are invalid")
        }
        return setCookies.toList()
    }
}

/** Sends the Google ID token outside WebView/service-worker interception. */
class CloudAuthClient {
    fun authenticate(endpoint: String, cookieHeader: String, idToken: String): CloudAuthResult {
        if (cookieHeader.isBlank() || cookieHeader.length > MAX_COOKIE_HEADER_LENGTH ||
            cookieHeader.contains('\r') || cookieHeader.contains('\n')
        ) {
            throw CloudAuthException("Cloud authentication challenge is unavailable")
        }
        if (idToken.isBlank() || idToken.length > MAX_ID_TOKEN_LENGTH) {
            throw CloudAuthException("Google ID token is invalid")
        }
        val body = (
            "id_token=" + URLEncoder.encode(idToken, StandardCharsets.UTF_8.name())
        ).toByteArray(StandardCharsets.UTF_8)
        val connection = try {
            URL(endpoint).openConnection() as HttpsURLConnection
        } catch (error: Exception) {
            throw CloudAuthException("Cloud authentication endpoint is invalid").also {
                it.initCause(error)
            }
        }
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = TIMEOUT_MILLIS
            connection.readTimeout = TIMEOUT_MILLIS
            connection.doOutput = true
            connection.useCaches = false
            connection.setFixedLengthStreamingMode(body.size)
            connection.setRequestProperty(
                "Content-Type",
                "application/x-www-form-urlencoded",
            )
            connection.setRequestProperty("Accept", "text/html")
            connection.setRequestProperty("Cache-Control", "no-store")
            connection.setRequestProperty("Cookie", cookieHeader)
            connection.outputStream.use { it.write(body) }

            val cookies = connection.headerFields.entries
                .filter { (name, _) -> name?.equals("set-cookie", ignoreCase = true) == true }
                .flatMap { it.value ?: emptyList() }
            return CloudAuthResult(
                CloudAuthResponse.requireSuccess(
                    connection.responseCode,
                    connection.getHeaderField("Location"),
                    cookies,
                ),
            )
        } catch (error: CloudAuthException) {
            throw error
        } catch (error: Exception) {
            throw CloudAuthException("Cloud authentication request failed").also {
                it.initCause(error)
            }
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        private const val TIMEOUT_MILLIS = 15_000
        private const val MAX_ID_TOKEN_LENGTH = 12 * 1024
        private const val MAX_COOKIE_HEADER_LENGTH = 16 * 1024
    }
}
