# 0226. Remote 첨부는 signature 확인된 PDF·DOCX·PPTX 문서를 이미지와 같은 등급으로 받는다

- Status: Proposed
- Date: 2026-09-03
- Source: 사용자 요구(Remote에서 PDF·DOCX·PPTX 첨부), [ADR-0181](0181-remote-terminal-file-attachments.md) 확장

## Context

ADR-0181은 Remote 터미널 첨부를 signature가 확인되는 이미지와 NUL 없는 UTF-8 text로 한정하고 "임의 binary 업로드"를 비목표로 두었다. 그러나 사용자는 접속 기기의 PDF·Word·PowerPoint 문서를 PC의 CLI 에이전트에 넘기고 싶어 한다. 이 문서들은 PTY에 붙일 수 없는 binary라는 점에서 이미지와 같은 성격이고, CLI가 host path로 읽어 스스로 파싱하는 사용법도 이미지와 같다.

문제는 허용 판정이다. text는 declared MIME/확장자에 UTF-8 검증을 얹어 판정하지만 binary 문서는 내용을 검증할 방법이 signature뿐이다. PDF는 고정 header가 있다. DOCX·PPTX는 둘 다 ZIP 컨테이너여서 ZIP header만으로는 임의 archive와 구분되지 않고, ZIP 안의 어떤 파일인지는 확장자를 믿어야만 알 수 있다는 것이 확장 전 가정이었다.

범위는 PDF·DOCX·PPTX 세 종류를 기존 attachments 계약(1 MiB 상한, cache quota, private directory, UUID 파일명, structured path 입력)에 그대로 얹는 것이다. XLSX·구형 DOC/PPT·ZIP·임의 binary는 계속 비목표다. 첨부 내용을 서버가 파싱·변환·미리보기하는 것도 비목표다.

## Decision

**PDF·DOCX·PPTX는 caller의 파일명·MIME가 아니라 bytes의 signature로 판정하고, 판정된 확장자로 저장한다. 이미지와 동일한 "signature-checked binary" 등급이다.**

1. 판정 순서는 image signature → document signature → text declared 검증이다. 이미지·문서는 caller의 확장자·MIME를 무시하고 bytes가 말하는 확장자를 쓴다. text만 declared MIME/확장자 whitelist를 사용한다.
2. PDF는 `%PDF-` header다.
3. DOCX·PPTX는 ZIP local header(`PK\x03\x04`)에 더해 OOXML package의 main part 이름이 bytes 안에 plain text로 존재해야 한다. ZIP central directory는 part 이름을 압축하지 않으므로 archive를 풀지 않고도 `word/document.xml`은 DOCX, `ppt/presentation.xml`은 PPTX로 확정할 수 있다. 둘 다 없는 ZIP은 확장자가 `.docx`여도 거절한다.
4. 브라우저 `input[type=file]`의 `accept`에는 세 확장자와 세 MIME를 함께 넣는다. Android System WebView는 `FileChooserParams.createIntent()`가 `accept`의 MIME를 그대로 chooser에 넘기므로 native chooser도 같은 범위를 보인다. `accept`는 UX 필터일 뿐이며 서버 판정이 유일한 경계다.
5. 서버 오류 문구는 허용 종류를 열거한다. 1 MiB 상한·quota·cleanup·lease permit·WSL path 변환은 ADR-0181 그대로다.

## Alternatives Considered

- **확장자·MIME만으로 DOCX/PPTX 허용**: 가장 짧지만 임의 ZIP을 `.docx`로 이름만 바꿔 host cache에 넣을 수 있어 ADR-0181의 "signature 확인" 원칙을 깨고 비목표인 임의 binary 업로드가 된다.
- **ZIP을 실제로 열어 `[Content_Types].xml`을 파싱**: 정확하지만 zip 의존성·decompress 비용·zip bomb 방어가 필요하다. 1 MiB 상한 안의 plain-text part 이름 검색이 같은 판정을 훨씬 싸게 준다.
- **임의 binary를 통째로 허용**: 사용자 요구는 문서 세 종류였고, host cache에 남는 파일 종류를 넓히는 결정은 필요할 때 별도 ADR로 한다.

## Consequences

- Remote에서 PDF·DOCX·PPTX를 CLI 에이전트에 host path로 넘길 수 있다. 저장 확장자는 bytes 기준이라 이름을 잘못 붙인 문서도 올바른 확장자로 저장된다.
- DOCX/PPTX 판정은 1 MiB 이내 bytes에 대한 두 번의 substring 검색이다. 상한이 커지면 검색 비용을 다시 본다.
- DOCM·PPTM 같은 macro 변형은 같은 main part 이름을 가지므로 `.docx`/`.pptx`로 저장된다. CLI가 host path로 읽는 용도에서는 문제가 없고, 원본 확장자 보존이 필요해지면 그때 결정한다.
- 테스트는 PDF header, DOCX/PPTX part 이름 판정, `.docx` 이름의 임의 ZIP 거절을 단위 테스트로 고정한다.
