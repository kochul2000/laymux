package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudDocumentLoadStateTest {
    private val firstGeneration = 1L
    private val retryGeneration = 2L
    private val startUrl = "https://app.laymux.com/app/android"
    private val dashboardUrl = "https://app.laymux.com/dashboard?client=android"

    @Test
    fun mainDocumentFailureStaysUnavailableAfterPageFinished() {
        val state = CloudDocumentLoadState()

        assertEquals(
            CloudDocumentPresentation.LOADING,
            state.started(firstGeneration, startUrl),
        )
        assertEquals(
            CloudDocumentPresentation.UNAVAILABLE,
            state.failed(firstGeneration, startUrl, isMainFrame = true),
        )
        assertNull(state.finished(firstGeneration, startUrl))
        assertEquals(CloudDocumentPresentation.UNAVAILABLE, state.presentation)
    }

    @Test
    fun retryReturnsToLoadingAndSuccessfulFinishRevealsTheCloudDocument() {
        val state = CloudDocumentLoadState()
        state.started(firstGeneration, startUrl)
        state.failed(firstGeneration, startUrl, isMainFrame = true)

        assertEquals(
            CloudDocumentPresentation.LOADING,
            state.started(retryGeneration, startUrl),
        )
        assertEquals(
            CloudDocumentPresentation.READY,
            state.finished(retryGeneration, startUrl),
        )
        assertEquals(CloudDocumentPresentation.READY, state.presentation)
    }

    @Test
    fun subresourceAndStaleNavigationCallbacksDoNotReplaceTheCurrentPresentation() {
        val state = CloudDocumentLoadState()
        state.started(firstGeneration, startUrl)
        state.started(firstGeneration, dashboardUrl)

        assertNull(state.failed(firstGeneration, startUrl, isMainFrame = true))
        assertNull(state.failed(firstGeneration, dashboardUrl, isMainFrame = false))
        assertNull(state.finished(firstGeneration, startUrl))
        assertEquals(CloudDocumentPresentation.LOADING, state.presentation)
        assertEquals(
            CloudDocumentPresentation.READY,
            state.finished(firstGeneration, dashboardUrl),
        )
    }

    @Test
    fun retryIgnoresLateCallbacksFromThePreviousGenerationAtTheSameUrl() {
        val state = CloudDocumentLoadState()
        state.started(firstGeneration, startUrl)
        state.failed(firstGeneration, startUrl, isMainFrame = true)
        state.started(retryGeneration, startUrl)

        assertNull(state.finished(firstGeneration, startUrl))
        assertNull(state.failed(firstGeneration, startUrl, isMainFrame = true))
        assertEquals(CloudDocumentPresentation.LOADING, state.presentation)
        assertEquals(
            CloudDocumentPresentation.READY,
            state.finished(retryGeneration, startUrl),
        )
    }

    @Test
    fun programmaticNavigationPublishesLoadingBeforeStartingTheWebViewLoad() {
        val state = CloudDocumentLoadState()
        val events = mutableListOf<String>()

        beginCloudDocumentNavigation(
            state = state,
            generation = firstGeneration,
            url = startUrl,
            publish = { events += it.name },
            navigate = { events += "NAVIGATE" },
        )

        assertEquals(listOf("LOADING", "NAVIGATE"), events)
    }
}
