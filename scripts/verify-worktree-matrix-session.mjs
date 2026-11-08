import { readFile } from "node:fs/promises";

export async function assertSetupMayStart(stateFile) {
  let contents;
  try {
    contents = await readFile(stateFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let previous;
  try {
    previous = JSON.parse(contents);
  } catch {
    throw new Error(
      "기존 검증 상태를 읽을 수 없습니다. 파일을 보존하고 원래 설정 복원을 먼저 확인하세요.",
    );
  }
  if (previous?.restored !== true) {
    throw new Error(
      "미복원 검증 상태가 있습니다. --restore를 완료한 뒤 --setup을 실행하세요.",
    );
  }
}
