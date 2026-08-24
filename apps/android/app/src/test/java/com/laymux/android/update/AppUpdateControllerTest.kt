package com.laymux.android.update

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeStore(
    override var channel: UpdateChannel = UpdateChannel.STABLE,
    override var lastCheckedAtEpochMillis: Long? = null,
    override var dismissedVersion: String? = null,
) : UpdateStore

/** 한 응답을 되돌려주는 `HttpURLConnection`. 네트워크 없이 전송 경로를 돈다. */
private class FakeConnection(
    url: URL,
    private val status: Int,
    private val body: String,
) : HttpURLConnection(url) {
    var disconnected = false
    val requestHeaders = mutableMapOf<String, String>()

    override fun connect() = Unit

    override fun disconnect() {
        disconnected = true
    }

    override fun usingProxy(): Boolean = false

    override fun getResponseCode(): Int = status

    override fun setRequestProperty(key: String, value: String) {
        requestHeaders[key] = value
    }

    override fun getInputStream(): InputStream = ByteArrayInputStream(body.toByteArray())

    override fun getErrorStream(): InputStream = ByteArrayInputStream(ByteArray(0))
}

class AppUpdateControllerTest {
    private val requestedUrls = mutableListOf<String>()

    private fun manifest(version: String, tag: String = "v$version"): String = """
        {
          "version": "$version",
          "releaseUrl": "https://github.com/kochul2000/laymux/releases/tag/$tag"
        }
    """.trimIndent()

    private fun client(status: Int = 200, body: String): UpdateCheckClient =
        UpdateCheckClient { uri ->
            requestedUrls += uri.toString()
            FakeConnection(uri.toURL(), status, body)
        }

    private fun controller(
        store: UpdateStore = FakeStore(),
        currentVersionName: String = "0.11.2",
        checkEnabledBuild: Boolean = true,
        body: String = manifest("0.12.0"),
        status: Int = 200,
        now: () -> Long = { 1_000_000L },
    ): AppUpdateController = AppUpdateController(
        store = store,
        currentVersionName = currentVersionName,
        checkEnabledBuild = checkEnabledBuild,
        // 테스트는 같은 스레드에서 즉시 돌린다.
        runOnWorker = { it.run() },
        runOnMain = { it.run() },
        client = client(status = status, body = body),
        nowEpochMillis = now,
    )

    @Test
    fun `더 높은 버전은 후보가 된다`() {
        val store = FakeStore()
        val controller = controller(store = store)
        controller.check(UpdateSchedule.Trigger.PERIODIC)

        val state = controller.state()
        assertEquals("0.12.0", state.available?.version)
        assertNull(state.lastError)
        assertEquals(1_000_000L, store.lastCheckedAtEpochMillis)
        assertEquals(
            listOf(
                "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/android-stable.json",
            ),
            requestedUrls,
        )
    }

    @Test
    fun `같거나 낮은 버전은 후보가 아니다`() {
        val controller = controller(body = manifest("0.11.2"))
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        assertNull(controller.state().available)

        val older = controller(body = manifest("0.10.9"))
        older.check(UpdateSchedule.Trigger.PERIODIC)
        assertNull(older.state().available)
    }

    @Test
    fun `beta 채널은 beta 매니페스트를 읽는다`() {
        val store = FakeStore(channel = UpdateChannel.BETA)
        val controller = controller(
            store = store,
            body = manifest("0.12.0-beta.1"),
        )
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        assertEquals("0.12.0-beta.1", controller.state().available?.version)
        assertEquals(
            listOf(
                "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/android-beta.json",
            ),
            requestedUrls,
        )
    }

    @Test
    fun `404 는 최신이 아니라 확인 오류다`() {
        val store = FakeStore()
        val controller = controller(store = store, status = 404, body = "not found")
        controller.check(UpdateSchedule.Trigger.PERIODIC)

        val state = controller.state()
        assertNotNull(state.lastError)
        assertNull(state.available)
        // 실패는 확인 시각을 갱신하지 않는다 — 갱신하면 끊긴 경로가 6시간에 한 번만 재시도된다.
        assertNull(store.lastCheckedAtEpochMillis)
    }

    @Test
    fun `stable 채널에 올라온 prerelease 는 후보가 아니라 오류다`() {
        val controller = controller(
            body = manifest("0.12.0-beta.1"),
        )
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        assertNull(controller.state().available)
        assertNotNull(controller.state().lastError)
    }

    @Test
    fun `주기 확인은 6시간 throttle 을 지키고 수동 확인은 무시한다`() {
        var now = 1_000_000L
        val store = FakeStore(lastCheckedAtEpochMillis = now)
        val controller = controller(store = store, now = { now })

        controller.check(UpdateSchedule.Trigger.PERIODIC)
        assertTrue(requestedUrls.isEmpty())

        controller.check(UpdateSchedule.Trigger.MANUAL)
        assertEquals(1, requestedUrls.size)

        now += UpdateSchedule.INTERVAL_MILLIS
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        assertEquals(2, requestedUrls.size)
    }

    @Test
    fun `기기 시계가 뒤로 가면 확인이 멈추지 않는다`() {
        val store = FakeStore(lastCheckedAtEpochMillis = 5_000_000L)
        val controller = controller(store = store, now = { 1_000L })
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        assertEquals(1, requestedUrls.size)
    }

    @Test
    fun `채널 변경은 옛 후보를 버리고 즉시 확인한다`() {
        val store = FakeStore(lastCheckedAtEpochMillis = 1_000_000L)
        val controller = controller(store = store, body = manifest("0.12.0"))
        controller.setChannel(UpdateChannel.BETA)

        assertEquals(UpdateChannel.BETA, store.channel)
        assertEquals(
            listOf(
                "https://raw.githubusercontent.com/kochul2000/laymux/release-channels/android-beta.json",
            ),
            requestedUrls,
        )
    }

    @Test
    fun `확인 중 채널이 바뀌면 옛 채널의 응답은 버린다`() {
        val store = FakeStore()
        val controller = AppUpdateController(
            store = store,
            currentVersionName = "0.11.2",
            checkEnabledBuild = true,
            // 응답이 도착하기 직전에 채널이 바뀐 상황을 만든다.
            runOnWorker = { it.run() },
            runOnMain = { task ->
                store.channel = UpdateChannel.BETA
                task.run()
            },
            client = client(body = manifest("0.12.0")),
            nowEpochMillis = { 1_000_000L },
        )
        controller.check(UpdateSchedule.Trigger.PERIODIC)

        assertNull(controller.state().available)
        assertNull(store.lastCheckedAtEpochMillis)
    }

    @Test
    fun `debug 빌드와 파싱 불가 버전은 확인하지 않는다`() {
        val disabled = controller(checkEnabledBuild = false)
        disabled.check(UpdateSchedule.Trigger.MANUAL)
        assertTrue(requestedUrls.isEmpty())
        assertFalse(disabled.state().enabled)

        val unparsable = controller(currentVersionName = "0.1.0-dev")
        unparsable.check(UpdateSchedule.Trigger.MANUAL)
        assertTrue(requestedUrls.isEmpty())
        assertFalse(unparsable.state().enabled)
    }

    @Test
    fun `닫기는 현재 후보 버전만 기억한다`() {
        val store = FakeStore()
        val controller = controller(store = store)
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        controller.dismissAvailable()

        assertEquals("0.12.0", store.dismissedVersion)
        assertFalse(presentUpdateBanner(controller.state()).visible)
    }

    @Test
    fun `표면 전환은 후보를 유지하고 표시만 미룬다`() {
        val controller = controller()
        controller.check(UpdateSchedule.Trigger.PERIODIC)
        controller.setSurface(UpdateSurface.REMOTE)
        assertFalse(presentUpdateBanner(controller.state()).visible)

        controller.setSurface(UpdateSurface.OTHER)
        assertTrue(presentUpdateBanner(controller.state()).visible)
    }

    @Test
    fun `상태 변경은 구독자에게 통지된다`() {
        val controller = controller()
        val seen = mutableListOf<UpdateState>()
        controller.onStateChanged = { seen += it }
        controller.check(UpdateSchedule.Trigger.PERIODIC)

        // 확인 시작과 결과 반영이 각각 통지된다.
        assertTrue(seen.size >= 2)
        assertTrue(seen.first().checking)
        assertFalse(seen.last().checking)
    }
}
