package com.laymux.android.pairing

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class BiometricThemeCompatibilityTest {
    @Test
    fun activityThemeSupportsTheAppCompatBiometricDialog() {
        val themes = listOf(
            File("src/main/res/values/themes.xml"),
            File("app/src/main/res/values/themes.xml"),
        ).firstOrNull(File::isFile)?.readText()
            ?: error("Android themes.xml not found")

        assertTrue(
            "androidx.biometric on API 28 opens an AppCompatDialog",
            themes.contains(
                "<style name=\"Theme.Laymux\" parent=\"Theme.AppCompat.NoActionBar\">",
            ),
        )
    }
}
