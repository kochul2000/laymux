package com.laymux.android.web

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ActivityInfo
import android.net.Uri
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.view.MotionEvent
import android.view.InputDevice
import android.os.SystemClock
import org.json.JSONObject
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.laymux.android.MainActivity
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RemoteAttachmentPickerTest {
    @Test
    fun staleConfirmationAndCancellationDoNotConsumeANewerShare() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val picker = RemoteAttachmentPicker(activity) { fail("No system picker expected") }
                val first = Uri.parse("content://gallery/first")
                val second = Uri.parse("content://gallery/second")
                picker.receiveShare(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, first))
                val oldId = picker.sharedOffer()!!.id
                picker.cancel() // Switching documents/PCs retains the inbox.
                assertEquals(oldId, picker.sharedOffer()!!.id)
                picker.receiveShare(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, second))
                val currentId = picker.sharedOffer()!!.id
                picker.discardSharedFiles(oldId)
                assertFalse(picker.deliverSharedFiles(oldId) { fail("Stale share must not deliver") })
                val received = mutableListOf<Uri>()
                assertTrue(picker.deliverSharedFiles(currentId) { received.addAll(it!!.toList()) })
                assertEquals(listOf(second), received)
                assertNull(picker.sharedOffer())
                assertFalse(picker.deliverSharedFiles(currentId) { fail("Share must deliver once") })
                picker.receiveShare(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, first))
                picker.discardSharedFiles(picker.sharedOffer()!!.id)
                assertNull(picker.sharedOffer())
            }
        }
    }

    @Test
    fun installedAppReceivesSingleAndMultipleFileSharesInOneTask() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        for (action in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) {
            val intent = Intent(action).setType("application/pdf").setPackage(context.packageName)
            val receiver = context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)!!.activityInfo
            assertEquals(MainActivity::class.java.name, receiver.name)
            assertTrue(receiver.exported)
            assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK, receiver.launchMode)
        }
    }

    @Test
    fun malformedStreamExtrasDoNotCrashTheExportedReceiver() {
        for (action in listOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) {
            assertTrue(RemoteAttachmentPicker.shareUris(Intent(action).putExtra(Intent.EXTRA_STREAM, "bad-extra")).isEmpty())
        }
    }

    @Test
    fun oneTapSharedConfirmationReachesARealWebViewWithoutAnotherPicker() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val loaded = CountDownLatch(1)
        val chosen = CountDownLatch(1)
        var received = ""
        var picker: RemoteAttachmentPicker? = null
        var view: WebView? = null
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val uri = RemoteFileOpener.prepare(activity, "shared.txt", "text/plain", "c2hhcmVkIGJ5dGVz").data!!
                picker = RemoteAttachmentPicker(activity) { fail("Sharing must not open a second picker") }
                assertTrue(picker!!.receiveShare(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uri)))
                val shareId = picker!!.sharedOffer()!!.id
                view = WebView(activity).apply {
                    settings.javaScriptEnabled = true
                    settings.allowContentAccess = false
                    settings.allowFileAccess = false
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(webView: WebView, callback: android.webkit.ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                            webView.evaluateJavascript("window.takeSharedFileSelection()") { selected ->
                                assertEquals(JSONObject.quote(shareId), selected)
                                assertTrue(picker!!.deliverSharedFiles(shareId, callback))
                            }
                            return true
                        }
                        override fun onReceivedTitle(view: WebView, title: String) {
                            if (title.startsWith("received:")) {
                                received = title
                                chosen.countDown()
                            }
                        }
                    }
                }
                activity.setContentView(view)
                view!!.loadDataWithBaseURL("https://remote.laymux.invalid/", """
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <button style="position:fixed;left:0;top:0;width:100%;height:160px" onclick="document.getElementById('file').click()">여기에 첨부</button>
                    <input id="file" type="file" accept="text/plain" multiple hidden>
                    <script>
                    window.takeSharedFileSelection = function() { return ${JSONObject.quote(shareId)}; };
                    document.getElementById('file').onchange = async function() {
                      var f = this.files[0]; document.title = 'received:' + f.name + ':' + await f.text();
                    };
                    </script>
                """.trimIndent(), "text/html", "utf-8", null)
            }
            assertTrue("WebView document did not load", loaded.await(10, TimeUnit.SECONDS))
            instrumentation.waitForIdleSync()
            val location = IntArray(2)
            scenario.onActivity { view!!.getLocationOnScreen(location) }
            val downTime = SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, location[0] + 200f, location[1] + 200f, 0)
                event.source = InputDevice.SOURCE_TOUCHSCREEN
                assertTrue(instrumentation.uiAutomation.injectInputEvent(event, true))
                event.recycle()
            }
            instrumentation.waitForIdleSync()
            assertTrue("WebView did not read the selected URI", chosen.await(10, TimeUnit.SECONDS))
            assertEquals("received:shared.txt:shared bytes", received)
            scenario.onActivity { picker!!.cancel(); view!!.destroy() }
        }
    }

    @Test
    fun galleryClipDataAndStreamResultsKeepOnlyUniqueContentUris() {
        val first = Uri.parse("content://gallery/first")
        val second = Uri.parse("content://gallery/second")
        val result = Intent().apply {
            data = first
            clipData = ClipData.newRawUri("first", first).apply {
                addItem(ClipData.Item(second))
                addItem(ClipData.Item(Uri.parse("file:///private/secret")))
                addItem(ClipData.Item(Uri.parse("https://example.com/file")))
            }
        }
        assertEquals(listOf(first, second), RemoteAttachmentPicker.resultUris(Activity.RESULT_OK, result))
        assertNull(RemoteAttachmentPicker.resultUris(Activity.RESULT_CANCELED, result))
    }

    @Test
    fun singleAndMultipleSharesSupportStreamAndClipDataFallback() {
        val uri = Uri.parse("content://gallery/photo")
        val single = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uri)
        assertEquals(listOf(uri), RemoteAttachmentPicker.shareUris(single))
        val multiple = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
            putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri, uri))
        }
        assertEquals(listOf(uri), RemoteAttachmentPicker.shareUris(multiple))
        val fallback = Intent(Intent.ACTION_SEND).apply {
            clipData = ClipData.newRawUri("photo", uri)
        }
        assertEquals(listOf(uri), RemoteAttachmentPicker.shareUris(fallback))
        assertTrue(RemoteAttachmentPicker.shareUris(Intent(Intent.ACTION_VIEW).setData(uri)).isEmpty())
        assertTrue(RemoteAttachmentPicker.shareUris(Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "hello")).isEmpty())
        single.putExtra(Intent.EXTRA_STREAM, Uri.parse("file:///private/secret"))
        assertTrue(RemoteAttachmentPicker.shareUris(single).isEmpty())
    }

    @Test
    fun systemPickerKeepsMimeFiltersAndMultipleSelection() {
        val multi = RemoteAttachmentPicker.selectionIntent(listOf("image/*", "application/pdf"), true)
        assertEquals(Intent.ACTION_GET_CONTENT, multi.action)
        assertEquals("*/*", multi.type)
        assertArrayEquals(arrayOf("image/*", "application/pdf"), multi.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
        assertTrue(multi.hasCategory(Intent.CATEGORY_OPENABLE))
        assertTrue(multi.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        val image = RemoteAttachmentPicker.selectionIntent(listOf("image/*"), false)
        assertEquals("image/*", image.type)
        assertFalse(image.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true))
        val customExtension = RemoteAttachmentPicker.selectionIntent(listOf("image/*", "*/*"), false)
        assertEquals("*/*", customExtension.type)
        assertNull(customExtension.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
    }

    @Test
    fun shareInboxIsBounded() {
        val uris = ArrayList((1..100).map { Uri.parse("content://gallery/$it") })
        val intent = Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        assertEquals(64, RemoteAttachmentPicker.shareUris(intent).size)
    }
}
