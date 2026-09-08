package com.laymux.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatePresentationTest {
    private fun state(
        enabled: Boolean = true,
        channel: UpdateChannel = UpdateChannel.STABLE,
        checking: Boolean = false,
        lastCheckedAtEpochMillis: Long? = 1_000L,
        available: AvailableUpdate? = AvailableUpdate(
            version = "0.12.0",
            releaseUrl = "https://github.com/kochul2000/laymux/releases/tag/v0.12.0",
        ),
        dismissedVersion: String? = null,
        lastError: String? = null,
        surface: UpdateSurface = UpdateSurface.OTHER,
    ) = UpdateState(
        enabled = enabled,
        currentVersion = "0.11.2",
        channel = channel,
        checking = checking,
        lastCheckedAtEpochMillis = lastCheckedAtEpochMillis,
        available = available,
        dismissedVersion = dismissedVersion,
        lastError = lastError,
        surface = surface,
    )

    @Test
    fun `후보가 있으면 배너가 뜬다`() {
        val banner = presentUpdateBanner(state())
        assertTrue(banner.visible)
        assertEquals("0.12.0", banner.version)
        assertEquals(
            "https://github.com/kochul2000/laymux/releases/tag/v0.12.0",
            banner.releaseUrl,
        )
    }

    @Test
    fun `Remote 표면에서는 배너를 띄우지 않는다`() {
        val banner = presentUpdateBanner(state(surface = UpdateSurface.REMOTE))
        assertFalse(banner.visible)
        assertNull(banner.releaseUrl)
    }

    @Test
    fun `닫은 버전은 침묵하고 다음 버전은 다시 뜬다`() {
        assertFalse(presentUpdateBanner(state(dismissedVersion = "0.12.0")).visible)
        assertTrue(presentUpdateBanner(state(dismissedVersion = "0.11.9")).visible)
    }

    @Test
    fun `후보가 없거나 확인이 비활성이면 배너가 없다`() {
        assertFalse(presentUpdateBanner(state(available = null)).visible)
        assertFalse(presentUpdateBanner(state(enabled = false)).visible)
    }

    @Test
    fun `확인 오류는 배너로 올리지 않는다`() {
        val banner = presentUpdateBanner(state(available = null, lastError = "확인 실패"))
        assertFalse(banner.visible)
    }

    @Test
    fun `설정 섹션 상태는 후보 오류 확인이력 순으로 갈린다`() {
        assertEquals(
            UpdateSectionStatus.AVAILABLE,
            presentUpdateSection(state()).status,
        )
        assertEquals(
            UpdateSectionStatus.CHECKING,
            presentUpdateSection(state(checking = true)).status,
        )
        assertEquals(
            UpdateSectionStatus.ERROR,
            presentUpdateSection(state(available = null, lastError = "확인 실패")).status,
        )
        assertEquals(
            UpdateSectionStatus.UP_TO_DATE,
            presentUpdateSection(state(available = null)).status,
        )
        assertEquals(
            UpdateSectionStatus.NEVER_CHECKED,
            presentUpdateSection(
                state(available = null, lastCheckedAtEpochMillis = null),
            ).status,
        )
        assertEquals(
            UpdateSectionStatus.DISABLED,
            presentUpdateSection(state(enabled = false)).status,
        )
    }

    @Test
    fun `닫은 배너는 설정 섹션의 후보를 숨기지 않는다`() {
        val section = presentUpdateSection(state(dismissedVersion = "0.12.0"))
        assertEquals(UpdateSectionStatus.AVAILABLE, section.status)
        assertEquals("0.12.0", section.availableVersion)
    }

    @Test
    fun `확인 중에는 다시 확인할 수 없고 비활성 빌드는 아예 못 한다`() {
        assertFalse(presentUpdateSection(state(checking = true)).checkEnabled)
        assertFalse(presentUpdateSection(state(enabled = false)).checkEnabled)
        assertTrue(presentUpdateSection(state()).checkEnabled)
    }

    @Test
    fun `beta 채널은 경고를 함께 보여준다`() {
        assertTrue(presentUpdateSection(state(channel = UpdateChannel.BETA)).betaWarningVisible)
        assertFalse(presentUpdateSection(state()).betaWarningVisible)
    }
}
