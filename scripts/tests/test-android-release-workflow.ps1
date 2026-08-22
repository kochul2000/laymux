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
    "gh release upload",
    # ADR-0190: both channels feed a client updater, so both tags are checked
    # against the client contract and the versionCode encoding has one owner.
    'scripts/release/android-version-code.mjs "$RELEASE_TAG"',
    "*-beta.*)",
    "src-tauri/Cargo.toml version",
    "scripts/release/channel-manifest.mjs",
    "release-channels"
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

# ADR-0190: the Android job must run for prereleases too, and publish must gate
# on it rather than tolerate a skip.
if ($workflow.Contains("needs.prepare.outputs.prerelease == 'false'")) {
    throw "Android job must not be limited to stable releases"
}
if ($workflow.Contains("needs.android.result == 'skipped'")) {
    throw "publish must require the Android job, not tolerate a skipped one"
}
if (-not $workflow.Contains('--bundles')) {
    throw "prerelease desktop builds must limit bundles (rpm/deb reject semver prereleases)"
}

# ADR-0190: the channel branch is written through the API, never a clone that
# would carry a credential and the source tree into the deployment branch.
if ($workflow.Contains('x-access-token:$GH_TOKEN@github.com')) {
    throw "the channel job must not embed the token in a clone URL"
}
if (-not $workflow.Contains('--seed-stable true')) {
    throw "the channel job must seed a missing stable manifest so neither channel 404s"
}
if (-not $workflow.Contains('needs: [prepare, build, android, channel_bootstrap]')) {
    throw "publish must wait for the channel branch to be seeded"
}
if (-not $workflow.Contains('release-version.mjs')) {
    throw "channel forwardness must be checked before publish"
}
if (-not $workflow.Contains('publish-channel-commit.sh')) {
    throw "channel commits must go through the shared API publisher"
}

# `gh api` prints the error body to stdout on a 404 without applying --jq, so a
# missing channel file reads as a non-empty value. Probing by output made the
# bootstrap job pass without seeding anything (run 32559427438).
if ($workflow -match '(?m)^\s*\w+="\$\(gh api [^\n]*contents/[^\n]*--jq[^\n]*\|\| true\)"') {
    throw "channel file probes must branch on gh api exit status, not captured output"
}
if (-not $workflow.Contains('if gh api "repos/$GITHUB_REPOSITORY/contents/desktop-stable.json?ref=$BRANCH" >/dev/null 2>&1; then')) {
    throw "the bootstrap seeding guard must test the gh api exit status"
}

# The channel publisher had the same trap inside it: a 404 body became the parent
# commit sha. It also died with exit 126 when checked out as 100644, and that
# failure lands *after* publish — the release goes latest with a stale channel.
$publisher = Join-Path $repoRoot "scripts/release/publish-channel-commit.sh"
$publisherSource = Get-Content -Raw -Encoding utf8 $publisher
if ($publisherSource -match '(?m)branch_sha="\$\(gh api [^\n]*\|\| true\)"') {
    throw "publish-channel-commit.sh must branch on gh api exit status, not captured output"
}
$mode = (& git -C $repoRoot ls-files -s -- scripts/release/publish-channel-commit.sh) -split '\s+' | Select-Object -First 1
if ($mode -ne "100755") {
    throw "publish-channel-commit.sh must be executable in git (found $mode)"
}
foreach ($call in ($workflow -split "`n" | Where-Object { $_ -match 'publish-channel-commit\.sh' })) {
    if ($call -notmatch 'bash\s+"\$GITHUB_WORKSPACE') {
        throw "the channel publisher must be invoked via bash so the file mode cannot break it: $($call.Trim())"
    }
}

# The release-contract scripts are only a gate if something runs them.
& node (Join-Path $repoRoot "scripts/tests/release-channels.test.mjs")
if ($LASTEXITCODE -ne 0) {
    throw "release channel script tests failed"
}

$updater = Get-Content -Raw -Encoding utf8 (Join-Path $repoRoot "src-tauri/tauri.conf.json")
if ($updater.Contains("releases/latest/download/latest.json")) {
    throw "the static updater endpoint must be the stable channel manifest (ADR-0190)"
}

Write-Output "Android release workflow contract passed"
