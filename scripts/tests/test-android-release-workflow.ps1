$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$workflow = Get-Content -Raw -Encoding utf8 (Join-Path $repoRoot ".github/workflows/release.yml")
$gradle = Get-Content -Raw -Encoding utf8 (Join-Path $repoRoot "apps/android/app/build.gradle.kts")

$requiredWorkflowTokens = @(
    "android:",
    "ANDROID_APP_SIGNING_KEYSTORE_BASE64",
    "ANDROID_APP_SIGNING_KEYSTORE_PASSWORD",
    "ANDROID_APP_SIGNING_KEY_ALIAS",
    "ANDROID_APP_SIGNING_KEY_PASSWORD",
    "ANDROID_APP_SIGNING_CERT_SHA256",
    "ANDROID_GOOGLE_WEB_CLIENT_ID",
    "git merge-base --is-ancestor",
    "fetch-depth: 0",
    'release_json="$(gh api --method POST',
    'release_id="$(jq -er ''.id'' <<<"$release_json")"',
    '--arg tag "$RELEASE_TAG"',
    'select(.tag_name == $tag)',
    ":app:testDebugUnitTest",
    ":app:assembleRelease",
    "apksigner verify --verbose --print-certs",
    "sha256sum",
    "gh release upload"
)
foreach ($token in $requiredWorkflowTokens) {
    if (-not $workflow.Contains($token)) {
        throw "missing workflow contract: $token"
    }
}

$requiredGradleTokens = @(
    "LAYMUX_ANDROID_VERSION_CODE",
    "LAYMUX_ANDROID_VERSION_NAME",
    "LAYMUX_ANDROID_APP_SIGNING_STORE_FILE",
    "LAYMUX_ANDROID_APP_SIGNING_STORE_PASSWORD",
    "LAYMUX_ANDROID_APP_SIGNING_KEY_ALIAS",
    "LAYMUX_ANDROID_APP_SIGNING_KEY_PASSWORD",
    "signingConfigs",
    'signingConfig = signingConfigs.getByName("release")'
)
foreach ($token in $requiredGradleTokens) {
    if (-not $gradle.Contains($token)) {
        throw "missing Gradle contract: $token"
    }
}

if ($workflow.Contains("bundleRelease")) {
    throw "GitHub APK workflow must not sign Play AAB with the app signing key"
}

if ($workflow.Contains('gh release create') -or $workflow.Contains('/releases/tags/$RELEASE_TAG')) {
    throw "draft release identity must come from the create response, not a tag lookup"
}

Write-Output "Android release workflow contract passed"
