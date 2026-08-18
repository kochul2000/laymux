package com.laymux.android.web

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDocumentAuthorityTest {
    @Test
    fun replacingDocumentRevokesThePreviousGenerationBeforeTheNextIsAuthorized() {
        val authority = RemoteDocumentAuthority()
        val first = authority.installFreshDocument()

        assertFalse(authority.allows(first, remoteSurface = true))
        assertTrue(authority.authorize(first))
        assertTrue(authority.allows(first, remoteSurface = true))
        assertFalse(authority.allows(first, remoteSurface = false))

        val second = authority.installFreshDocument()

        assertFalse(authority.allows(first, remoteSurface = true))
        assertFalse(authority.allows(second, remoteSurface = true))
        assertFalse(authority.authorize(first))
        assertTrue(authority.authorize(second))
        assertTrue(authority.allows(second, remoteSurface = true))

        authority.revoke()
        assertFalse(authority.allows(second, remoteSurface = true))
    }
}
