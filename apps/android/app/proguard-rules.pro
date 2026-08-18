# Only Cloud account selection and authenticated Remote transport remain exposed
# to JavaScript. Pairing actions are native Material UI callbacks (ADR-0178).
-keepclassmembers class com.laymux.android.web.CloudBridge {
    @android.webkit.JavascriptInterface <methods>;
}

-keepclassmembers class com.laymux.android.web.RemoteBridge {
    @android.webkit.JavascriptInterface <methods>;
}
