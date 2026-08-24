package com.laymux.android.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 버전 문법 계약은 node·Rust·Kotlin 세 곳에 사본이 있다(ADR-0197). 갈라지면
 * 폰만 후보를 놓치거나 폰만 잘못된 후보를 받으므로 경계값을 여기서 고정한다.
 */
class ReleaseVersionTest {
    @Test
    fun `stable 과 beta 를 파싱한다`() {
        val stable = requireNotNull(ReleaseVersion.parseOrNull("v0.11.1"))
        assertEquals("0.11.1", stable.version)
        assertNull(stable.beta)

        val beta = requireNotNull(ReleaseVersion.parseOrNull("0.12.0-beta.3"))
        assertEquals("0.12.0-beta.3", beta.version)
        assertEquals(3, beta.beta)
    }

    @Test
    fun `다른 prerelease 라벨과 build metadata 는 거절한다`() {
        assertNull(ReleaseVersion.parseOrNull("0.11.1-alpha.1"))
        assertNull(ReleaseVersion.parseOrNull("0.11.1-rc.1"))
        assertNull(ReleaseVersion.parseOrNull("0.11.1+build.5"))
        assertNull(ReleaseVersion.parseOrNull("0.11.1-beta.0"))
        assertNull(ReleaseVersion.parseOrNull("0.11.1-beta.01"))
        assertNull(ReleaseVersion.parseOrNull("0.11.01"))
        assertNull(ReleaseVersion.parseOrNull("nightly-2026-08-24"))
        assertNull(ReleaseVersion.parseOrNull(""))
        assertNull(ReleaseVersion.parseOrNull(null))
    }

    @Test
    fun `성분 개수가 셋이 아니면 거절한다`() {
        assertNull(ReleaseVersion.parseOrNull("0.11"))
        assertNull(ReleaseVersion.parseOrNull("11"))
        assertNull(ReleaseVersion.parseOrNull("0.11.1.1"))
        assertNull(ReleaseVersion.parseOrNull("0.11."))
    }

    @Test
    fun `beta 라벨에 슬롯 번호가 없으면 거절한다`() {
        assertNull(ReleaseVersion.parseOrNull("0.11.1-beta"))
        assertNull(ReleaseVersion.parseOrNull("0.11.1-beta."))
        assertNull(ReleaseVersion.parseOrNull("0.11.1-beta.x"))
    }

    @Test
    fun `정식은 같은 버전의 beta 보다 크다`() {
        val stable = requireNotNull(ReleaseVersion.parseOrNull("0.12.0"))
        val beta = requireNotNull(ReleaseVersion.parseOrNull("0.12.0-beta.9"))
        assertTrue(stable > beta)
    }

    @Test
    fun `성분과 beta 슬롯 순서로 비교한다`() {
        val order = listOf(
            "0.11.1",
            "0.12.0-beta.1",
            "0.12.0-beta.2",
            "0.12.0",
            "0.12.1-beta.1",
            "1.0.0",
        ).map { requireNotNull(ReleaseVersion.parseOrNull(it)) }
        for (index in 1 until order.size) {
            assertTrue("${order[index]} > ${order[index - 1]}", order[index] > order[index - 1])
        }
    }

    @Test
    fun `같은 버전은 동등하다`() {
        val left = requireNotNull(ReleaseVersion.parseOrNull("v0.11.1"))
        val right = requireNotNull(ReleaseVersion.parseOrNull("0.11.1"))
        assertEquals(0, left.compareTo(right))
    }
}
