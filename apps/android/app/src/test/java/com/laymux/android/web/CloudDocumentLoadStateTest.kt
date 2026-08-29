package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudDocumentLoadStateTest {
    private val startUrl = "https://app.laymux.com/app/android"
    private val dashboardUrl = "https://app.laymux.com/dashboard?client=android"

    @Test
    fun mainDocumentFailureStaysUnavailableAfterPageFinished() {
        val state = CloudDocumentLoadState()

        assertEquals(CloudDocumentPresentation.LOADING, state.started(startUrl))
        assertEquals(
            CloudDocumentPresentation.UNAVAILABLE,
            state.failed(startUrl, isMainFrame = true),
        )
        assertNull(state.finished(startUrl))
        assertEquals(CloudDocumentPresentation.UNAVAILABLE, state.presentation)
    }

    @Test
    fun retryReturnsToLoadingAndSuccessfulFinishRevealsTheCloudDocument() {
        val state = CloudDocumentLoadState()
        state.started(startUrl)
        state.failed(startUrl, isMainFrame = true)

        assertEquals(CloudDocumentPresentation.LOADING, state.started(startUrl))
        assertEquals(CloudDocumentPresentation.READY, state.finished(startUrl))
        assertEquals(CloudDocumentPresentation.READY, state.presentation)
    }

    @Test
    fun subresourceAndStaleNavigationCallbacksDoNotReplaceTheCurrentPresentation() {
        val state = CloudDocumentLoadState()
        state.started(startUrl)
        state.started(dashboardUrl)

        assertNull(state.failed(startUrl, isMainFrame = true))
        assertNull(state.failed(dashboardUrl, isMainFrame = false))
        assertNull(state.finished(startUrl))
        assertEquals(CloudDocumentPresentation.LOADING, state.presentation)
        assertEquals(CloudDocumentPresentation.READY, state.finished(dashboardUrl))
    }
}
