# NativeBridge methods are annotated with @JavascriptInterface and are retained
# by the Android Gradle Plugin's default WebView keep rules.
-keepclassmembers class com.laymux.android.web.NativeBridge {
    @android.webkit.JavascriptInterface <methods>;
}
