#!/usr/bin/env bash
# 채널 파일 두 개를 한 커밋으로 배포 브랜치에 올린다 (ADR-0190).
#
# 클론 대신 Git Data API 를 쓰는 이유: 채널 브랜치는 이 파일들만 담는 배포
# 산출물이고, 클론은 소스 트리와 자격증명을 그 작업본에 남긴다. 트리를 매번
# 통째로 만들므로 브랜치가 소스 히스토리를 누적하지 않는다.
#
# 한 커밋으로 올리는 이유: 부분 갱신은 beta < stable 상태를 노출한다.
# 같은 트리면 아무것도 하지 않으므로 job 재실행은 멱등이다.
#
# 사용: publish-channel-commit.sh <channel-dir> <branch> <commit-message>
# 필요 env: GH_TOKEN, GITHUB_REPOSITORY

set -euo pipefail

channels="${1:?channel directory required}"
branch="${2:?branch required}"
message="${3:?commit message required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"

branch_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$branch" --jq '.object.sha' 2>/dev/null || true)"

entries=""
for file in desktop-stable.json desktop-beta.json; do
  [[ -s "$channels/$file" ]] || continue
  blob_sha="$(gh api --method POST "repos/$GITHUB_REPOSITORY/git/blobs" \
    -f content="$(base64 -w0 <"$channels/$file")" -f encoding=base64 --jq '.sha')"
  entries="$entries{\"path\":\"$file\",\"mode\":\"100644\",\"type\":\"blob\",\"sha\":\"$blob_sha\"},"
done
[[ -n "$entries" ]] || { echo "No channel files to publish" >&2; exit 1; }

tree_sha="$(gh api --method POST "repos/$GITHUB_REPOSITORY/git/trees" \
  --input - --jq '.sha' <<<"{\"tree\":[${entries%,}]}")"

if [[ -n "$branch_sha" ]]; then
  current_tree="$(gh api "repos/$GITHUB_REPOSITORY/git/commits/$branch_sha" --jq '.tree.sha')"
  if [[ "$current_tree" == "$tree_sha" ]]; then
    echo "channel manifests already up to date"
    exit 0
  fi
  commit_sha="$(gh api --method POST "repos/$GITHUB_REPOSITORY/git/commits" \
    --input - --jq '.sha' <<<"{\"message\":\"$message\",\"tree\":\"$tree_sha\",\"parents\":[\"$branch_sha\"]}")"
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/git/refs/heads/$branch" -f sha="$commit_sha" >/dev/null
else
  commit_sha="$(gh api --method POST "repos/$GITHUB_REPOSITORY/git/commits" \
    --input - --jq '.sha' <<<"{\"message\":\"$message\",\"tree\":\"$tree_sha\",\"parents\":[]}")"
  gh api --method POST "repos/$GITHUB_REPOSITORY/git/refs" \
    -f ref="refs/heads/$branch" -f sha="$commit_sha" >/dev/null
fi
echo "published channel manifests as $commit_sha"
