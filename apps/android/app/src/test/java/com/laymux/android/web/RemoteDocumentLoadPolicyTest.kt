package com.laymux.android.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RemoteDocumentLoadPolicyTest {
    @Test
    fun mainDocumentHttpFailureReturnsToDashboard() {
        assertEquals(
            404,
            RemoteDocumentLoadPolicy.dashboardStatus(
                isMainFrame = true,
                RemoteResourceLoadResult.Response(RemoteResourceResponse.error(404, "missing")),
            ),
        )
        assertEquals(
            503,
            RemoteDocumentLoadPolicy.dashboardStatus(
                isMainFrame = true,
                RemoteResourceLoadResult.Unavailable,
            ),
        )
    }

    @Test
    fun lifecycleCancellationAndFailedSubresourcesStayOnRemoteSurface() {
        assertNull(
            RemoteDocumentLoadPolicy.dashboardStatus(
                isMainFrame = true,
                RemoteResourceLoadResult.Cancelled,
            ),
        )
        assertNull(
            RemoteDocumentLoadPolicy.dashboardStatus(
                isMainFrame = false,
                RemoteResourceLoadResult.Response(RemoteResourceResponse.error(404, "missing")),
            ),
        )
        assertNull(
            RemoteDocumentLoadPolicy.dashboardStatus(
                isMainFrame = true,
                RemoteResourceLoadResult.Response(RemoteResourceResponse.error(200, "ok")),
            ),
        )
    }
}
