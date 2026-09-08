package com.laymux.android.web

import org.json.JSONObject

/**
 * Wire shape of the Remote page's `open` message on the output bridge.
 *
 * The key set is exact so a page cannot smuggle unknown fields into the E2E
 * open record. `historyKib` is the optional scroll-top history expansion budget
 * (ADR-0182): the PC owns the real clamp, so anything outside the wire range
 * degrades to "no expansion" instead of failing an otherwise valid attach — and
 * never to the maximum, which is not what such a request meant.
 */
object RemoteOutputOpen {
    /** Mirrors the PC-side `MAX_REMOTE_SNAPSHOT_MAX_KIB` clamp ceiling. */
    const val MAX_HISTORY_KIB = 1024

    private val REQUIRED_KEYS = setOf("type", "streamId", "terminalId", "leaseId")
    private val KEYS_WITH_HISTORY = REQUIRED_KEYS + "historyKib"

    fun hasAcceptedKeys(message: JSONObject): Boolean {
        val actual = mutableSetOf<String>()
        val keys = message.keys()
        while (keys.hasNext()) actual += keys.next()
        return actual == REQUIRED_KEYS || actual == KEYS_WITH_HISTORY
    }

    fun historyKib(message: JSONObject): Int {
        val requested = message.optInt("historyKib", 0)
        return if (requested in 0..MAX_HISTORY_KIB) requested else 0
    }
}
