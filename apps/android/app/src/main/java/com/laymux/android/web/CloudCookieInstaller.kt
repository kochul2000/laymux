package com.laymux.android.web

import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

typealias CloudCookieSetter = (String, String, (Boolean) -> Unit) -> Unit

/** Awaits WebView cookie persistence before authenticated navigation may start. */
object CloudCookieInstaller {
    suspend fun install(
        originUrl: String,
        cookies: List<String>,
        setCookie: CloudCookieSetter,
    ) {
        for (cookie in cookies) {
            suspendCancellableCoroutine { continuation ->
                setCookie(originUrl, cookie) { accepted ->
                    if (!continuation.isActive) return@setCookie
                    if (accepted) {
                        continuation.resume(Unit)
                    } else {
                        continuation.resumeWithException(
                            CloudAuthException("Cloud authentication cookie was not stored"),
                        )
                    }
                }
            }
        }
    }
}
