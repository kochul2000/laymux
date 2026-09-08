#!/usr/bin/env bash
# 채널 파일 네 개를 한 트리 커밋으로 배포 브랜치에 올린다 (ADR-0190·ADR-0223).
#
# 클론 대신 Git Data API 를 쓰는 이유: 채널 브랜치는 이 파일들만 담는 배포
# 산출물이고, 클론은 소스 트리와 자격증명을 그 작업본에 남긴다. 트리를 매번
# 통째로 만들므로 브랜치가 소스 히스토리를 누적하지 않는다.
#
# 한 커밋으로 올리는 이유: 부분 갱신은 beta < stable 상태를 노출한다.
# 같은 트리면 아무것도 하지 않으므로 job 재실행은 멱등이다.
#
# 사용: bash publish-channel-commit.sh <channel-dir> <branch> <commit-message>
# 필요 env: GH_TOKEN, GITHUB_REPOSITORY
#
# 워크플로는 `bash <path>` 로 부른다. 파일 모드가 git 에서 100644 로 들어가면
# 직접 실행이 exit 126(Permission denied)으로 죽는데, 그 실패가 릴리스 게시
# *뒤에* 나면 채널이 갱신되지 않은 채 새 버전이 latest 가 된다.

set -euo pipefail

channels="${1:?channel directory required}"
branch="${2:?branch required}"
message="${3:?commit message required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"

# 종료 코드로 판단한다. `gh api` 는 404 에서도 에러 본문을 stdout 으로 내보내고
# --jq 를 적용하지 않으므로, `|| true` 로 받으면 브랜치가 없을 때 빈 값이 아니라
# JSON 이 담겨 "브랜치가 있다"로 오판하고 그 문자열을 commit sha 로 쓴다.
branch_sha="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$branch" --jq '.object.sha' 2>/dev/null)" || branch_sha=""

# 트리를 통째로 만들므로 이 목록에서 빠진 파일은 브랜치에서 사라진다. 호출자가
# 기존 파일을 먼저 채널 디렉터리에 내려놓아야 하고, 새 계열을 추가할 때는
# 여기와 채널 job 의 다운로드 목록을 함께 넓혀야 한다.
entries=""
for file in desktop-stable.json desktop-beta.json android-stable.json android-beta.json; do
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
