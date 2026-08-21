// 릴리스 버전 문자열 계약 (ADR-0189).
//
// stable 은 `x.y.z`, beta 는 `x.y.z-beta.N` 만 허용한다. 다른 prerelease 라벨과
// build metadata 를 받지 않는 이유는 채널을 넓히는 것이 임의 문자열 수용으로
// 번지지 않게 하기 위해서다. 클라이언트(`src-tauri/src/app_update.rs`)가 같은
// 계약을 독립적으로 다시 검사한다.

const RELEASE_VERSION_PATTERN =
  /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?$/;

/**
 * 태그 또는 버전 문자열을 성분으로 분해한다.
 * @param {string} raw `v0.11.0` `0.11.0-beta.3` 처럼 선행 `v` 는 선택이다.
 * @returns {{version: string, major: number, minor: number, patch: number, beta: number|null}}
 */
export function parseReleaseVersion(raw) {
  if (typeof raw !== "string") {
    throw new Error(`릴리스 버전은 문자열이어야 한다: ${raw}`);
  }
  const match = RELEASE_VERSION_PATTERN.exec(raw.trim());
  if (!match) {
    throw new Error(
      `릴리스 태그는 v?x.y.z 또는 v?x.y.z-beta.N 이어야 한다: ${raw}`,
    );
  }
  const [, major, minor, patch, beta] = match;
  const version =
    beta === undefined
      ? `${major}.${minor}.${patch}`
      : `${major}.${minor}.${patch}-beta.${beta}`;
  return {
    version,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    beta: beta === undefined ? null : Number(beta),
  };
}

/**
 * semver 순서로 비교한다. prerelease 가 없는 쪽이 크다.
 * @returns {number} a > b 면 양수, 같으면 0, a < b 면 음수
 */
export function compareReleaseVersions(a, b) {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.beta === right.beta) return 0;
  if (left.beta === null) return 1;
  if (right.beta === null) return -1;
  return left.beta - right.beta;
}
