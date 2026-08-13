package com.laymux.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumeGatedRunnerTest {
    @Test
    fun runsImmediatelyWhileResumed() {
        val runner = ResumeGatedRunner()
        runner.onResumed()
        var runs = 0

        assertTrue(runner.runWhenResumed { runs += 1 })

        assertEquals(1, runs)
        assertFalse(runner.hasPending)
    }

    @Test
    fun deferredRequestRunsOnceOnTheNextResume() {
        val runner = ResumeGatedRunner()
        var runs = 0

        runner.runWhenResumed { runs += 1 }
        assertEquals(0, runs)
        assertTrue(runner.hasPending)

        runner.onResumed()
        assertEquals(1, runs)
        assertFalse(runner.hasPending)

        runner.onPaused()
        runner.onResumed()
        assertEquals(1, runs)
    }

    @Test
    fun pausingAfterResumeDefersAgain() {
        val runner = ResumeGatedRunner()
        runner.onResumed()
        runner.onPaused()
        var runs = 0

        runner.runWhenResumed { runs += 1 }
        assertEquals(0, runs)

        runner.onResumed()
        assertEquals(1, runs)
    }

    @Test
    fun cancelPendingDropsDeferredWork() {
        val runner = ResumeGatedRunner()
        var runs = 0
        runner.runWhenResumed { runs += 1 }

        assertTrue(runner.cancelPending())
        assertFalse(runner.cancelPending())

        runner.onResumed()
        assertEquals(0, runs)
    }

    @Test
    fun aSecondRequestIsRejectedInsteadOfReplacingTheDeferredOne() {
        val runner = ResumeGatedRunner()
        val order = mutableListOf<String>()

        assertTrue(runner.runWhenResumed { order.add("first") })
        assertFalse(runner.runWhenResumed { order.add("second") })
        runner.onResumed()

        assertEquals(listOf("first"), order)
    }

    @Test
    fun aRequestIsAcceptedAgainAfterThePendingOneRan() {
        val runner = ResumeGatedRunner()
        val order = mutableListOf<String>()

        runner.runWhenResumed { order.add("first") }
        runner.onResumed()
        assertTrue(runner.runWhenResumed { order.add("second") })

        assertEquals(listOf("first", "second"), order)
    }
}
