export function WorktreeWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <details className="worktree-warnings">
      <summary>제거 보류 · 사용 확인 필요 {warnings.length}건</summary>
      <p>
        현재 경로를 확인하지 못한 터미널이 있어 제거를 보류합니다. 아래 경고는 전체 사용 관측에 관한
        것이며 이 저장소를 사용한다는 뜻은 아닙니다.
      </p>
      <div className="worktree-warning-list">
        {warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </div>
    </details>
  );
}
