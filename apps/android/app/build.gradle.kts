import org.jetbrains.kotlin.gradle.dsl.JvmTarget

val laymuxCloudBaseUrl = providers.gradleProperty("laymuxCloudBaseUrl")
    .orElse(providers.environmentVariable("LAYMUX_CLOUD_BASE_URL"))
    .orElse("https://app.laymux.com")
val laymuxGoogleWebClientId = providers.gradleProperty("laymuxGoogleWebClientId")
    .orElse(providers.environmentVariable("LAYMUX_GOOGLE_WEB_CLIENT_ID"))
    .orElse("")
val laymuxAndroidVersionCode = providers.environmentVariable("LAYMUX_ANDROID_VERSION_CODE")
    .orElse("1")
val laymuxAndroidVersionName = providers.environmentVariable("LAYMUX_ANDROID_VERSION_NAME")
    .orElse("0.1.0")
val releaseSigningStoreFile = providers.environmentVariable(
    "LAYMUX_ANDROID_APP_SIGNING_STORE_FILE",
).orElse("")
val releaseSigningStorePassword = providers.environmentVariable(
    "LAYMUX_ANDROID_APP_SIGNING_STORE_PASSWORD",
).orElse("")
val releaseSigningKeyAlias = providers.environmentVariable(
    "LAYMUX_ANDROID_APP_SIGNING_KEY_ALIAS",
).orElse("")
val releaseSigningKeyPassword = providers.environmentVariable(
    "LAYMUX_ANDROID_APP_SIGNING_KEY_PASSWORD",
).orElse("")
val releaseSigningValues = listOf(
    releaseSigningStoreFile,
    releaseSigningStorePassword,
    releaseSigningKeyAlias,
    releaseSigningKeyPassword,
).map { it.get() }
val releaseSigningConfigured = releaseSigningValues.all { it.isNotBlank() }

if (releaseSigningValues.any { it.isNotBlank() } && !releaseSigningConfigured) {
    throw GradleException("Android release signing configuration is incomplete")
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.laymux.android"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.laymux.android"
        minSdk = 23
        targetSdk = 36
        versionCode = laymuxAndroidVersionCode.get().toInt().also {
            require(it in 1..2_100_000_000) { "Android versionCode is out of range" }
        }
        versionName = laymuxAndroidVersionName.get().also {
            require(it.matches(Regex("[0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.-]+)?"))) {
                "Android versionName is not a supported release version"
            }
        }

        resValue("string", "laymux_cloud_base_url", laymuxCloudBaseUrl.get())
        resValue("string", "laymux_google_web_client_id", laymuxGoogleWebClientId.get())

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(releaseSigningStoreFile.get())
                storePassword = releaseSigningStorePassword.get()
                keyAlias = releaseSigningKeyAlias.get()
                keyPassword = releaseSigningKeyPassword.get()
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
                enableV4Signing = true
            }
        }
    }

    buildTypes {
        release {
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all {
            it.useJUnit()
        }
    }

}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.6.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.2.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
