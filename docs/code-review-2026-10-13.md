# naiteh 코드 리뷰 — 약점 및 수정사항 (2026-10-13)

대상: Evernote/Obsidian 클론 로컬-퍼스트 Markdown 노트 앱 (Tauri v2 + Rust + React 18/TS)
범위: `apps/desktop/src-tauri/src` (약 2.2만 줄), `apps/desktop/src` (약 1.4만 줄), 설정/CI/문서
방법: 백엔드·프론트엔드 전수 코드 리뷰 + 문서 대조. ✅ 표시 항목은 리뷰어가 원본 코드에서
라인까지 직접 확인한 것.

## 총평

구조적으로 동급 클론 프로젝트치고 이례적으로 잘 만든 코드베이스다. 전 쓰기 경로가
임시파일+rename 원자적 쓰기로 통일되어 있고, SHA-256 버전 토큰 기반 낙관적 동시성 제어,
모든 IPC에 걸리는 세션 게이트(메타 테스트로 강제), Rust 약 503개 단위 테스트,
TS `strict` + `any` 제로. 약점은 "엉성한 코드"가 아니라 **드문 데이터 유실 경로,
규모 확장성 부재, 원본 제품 대비 기능 격차, 보안 경계의 구멍 몇 개**에 집중되어 있다.

Critical로 분류할 만한 것은 데이터 유실 경로 2개뿐이며, 나머지 대부분은
"볼트가 커지면 터지는" 유형이다.

---

> **2026-10-13 재확인**: 아래 코드 수준 수정 항목(F1~F5 포함)은 이 시점 기준
> **전부 미반영** 확인됨 (authStore.ts:118, autosave.ts preserveAsCopy,
> notes_set_pinned_impl, chat_doc.rs resolve_request, search.rs — 모두 원문 그대로).
> 대신 캘린더 기능이 커밋(07117ec)되고 새 **자동 백업 기능(Drive/SFTP)**이 추가되어,
> §6의 제품 수준 "동기화/백업" 약점 일부를 대응함 — 신규 발견은 §8 참조.

## 1. 우선 수정 Top 5

- [ ] **F1. 로그아웃이 충돌 보류 편집을 유실** — `src/state/authStore.ts:118`의
  `flushPendingSave()`에 `{ leaving: true }` 부여 (한 줄 수정) + 로그아웃-충돌 시나리오 테스트 추가
- [ ] **F2. `preserveAsCopy` 실패 시 무음 유실** — `src/state/autosave.ts:253-268`.
  사본 저장 실패 시 항목을 `pending`에 재등록(재시도), `enqueue`의 rejection 삼킴 제거,
  상태바 "Save failed — retrying" 거짓 표시 수정 (`src/shell/StatusBar.tsx:109-118`)
- [ ] **F3. 핀 토글 무버전 덮어쓰기** — `src-tauri/src/commands/notes.rs:294-307`에
  기존 `write_versioned`의 `expected_version` 검사 적용
- [ ] **F4. 채팅 노트 `url:` 오버라이드로 API 키 유출** — `src-tauri/src/services/chat_doc.rs:370-378`.
  키 없는 프로바이더만 `url:` 허용하거나 설정된 baseUrl과 매칭 강제
- [ ] **F5. 검색·메타데이터 인덱싱** (로드맵 v1.5 항목) — `notes_list`가 `TagIndex`를
  쓰게 하고(`src-tauri/src/services/notes.rs:338-341` 참조), 노트 트리 가상화 추가

---

## 2. 데이터 무결성

### Critical

- [ ] ✅ **C1. 로그아웃이 충돌 보류 중인 편집을 조용히 유실**
  `src/state/authStore.ts:118` vs `src/state/autosave.ts:30-36, 338-341`
  autosave 모듈의 자기 계약("문서를 떠나는 모든 경로는 `flushPendingSave({ leaving: true })`로
  보류 편집을 `.local-<ts>.md` 사본으로 보존")을 노트 전환(`src/lib/openDocument.ts:73`)은
  지키는데 로그아웃만 `leaving` 없이 호출한다. `leaving`이 없으면 보류 항목이 `pending`으로
  되돌아가기만 하고, `resetEditor()` 후 `AppShell` 언마운트로 창 닫기 플러시 핸들러까지
  사라져 복구 불가. → F1.

- [ ] ✅ **C2. 마지막 안전망(preserveAsCopy) 실패가 무음 + UI 거짓 표시**
  `src/state/autosave.ts:253-268, 126-134, 336-345`, `src/shell/StatusBar.tsx:109-118`
  사본 저장이 실패하면(디스크 만료, 백신 락) 항목은 이미 `arm()`/`pending.clear()`로
  제거된 뒤라 재시도가 없고 `console.error`만 남는다. `flushPendingSave({leaving:true})`가
  이를 `void enqueue(...)`로 감싸 rejection을 삼키므로 창 닫기/노트 전환은 "보존 성공"으로
  진행한다. 상태바는 아무것도 재시도하지 않는데 "Save failed — retrying"을 보여준다. → F2.

### High

- [ ] ✅ **H1. `notes_set_pinned`이 무조건적 read-modify-write — 외부 편집 되돌림**
  `src-tauri/src/commands/notes.rs:294-307`
  읽고 → 핀 플래그만 바꿔 → 원자적 쓰기. 다른 모든 쓰기 경로의 SHA-256
  `expected_version` 검사(`src-tauri/src/services/notes.rs:59-72` `write_versioned`)를
  우회한다. 읽기와 쓰기 사이에 Google Drive가 내려놓은 새 본문을 **이전 내용으로 되돌려
  파괴**한다. 사이드카·충돌 캡처·흔적 없음. → F3.

- [ ] **H4. 실행취소 히스토리가 노트 전환·외부 리로드마다 소멸**
  `src/shell/EditorPanel.tsx:111-167`
  `editorKey` 또는 `revision`이 바뀔 때마다 CodeMirror 뷰를 재생성(히스토리는 뷰 상태에
  존재). `reloadOpen`(동기화 pull, 워처 리로드, 충돌 해결)마다 undo가 초기화된다.
  히스토리 컴파트먼트 이동으로 해결 가능.

### Medium

- [ ] **M1. 동기화 force checkout이 외부 쓰기를 덮어쓸 수 있음 (TOCTOU vs Drive)**
  `src-tauri/src/services/git.rs:769-780`(fast-forward), `:918-922`(충돌 경로)
  dirty 검사(`git.rs:678-695`)와 `checkout_head(...force())` 사이에 낀 Drive 쓰기는
  충돌 캡처 없이 사라진다. `merge_into_branch`의 `checkout_tree(...force())`도 동일.

- [ ] **M2. 크래시 윈도우가 사이드카 고아 + 미기록 머지를 남김**
  `src-tauri/src/services/git.rs:917-940`
  처리 순서가 `write_sidecars` → `checkout_tree` → `ensure_gitignore` →
  `set_pending_merge`라, 중간에 크래시하면 사이드카는 남되 `pending_merge`가 없어
  `finalize_pending_merge`가 영구히 `NoPending`(`git.rs:579-596`).

### Low

- [ ] **L1. `atomic_write`가 부모 디렉터리를 fsync하지 않음** —
  `src-tauri/src/services/fs.rs:49-87`. POSIX에서 정전 시 "저장됨"이 이전 버전 부활로
  끝날 수 있음(내용이 깨지는 것은 아님).
- [ ] **L2. 자기-변경 태깅이 3초 TTL 휴리스틱** —
  `src-tauri/src/services/own_changes.rs:27`. 느린 디스크에서 Drive 에코가 외부 변경으로
  오분류되어 잦은 리로드 유발(설계 결, 치명적 아님).

---

## 3. 성능·확장성

- [ ] ✅ **H3. 검색이 매 쿼리마다 전체 볼트 선형 스캔**
  `src-tauri/src/commands/search.rs:57-96`
  모든 노트를 `read_to_string`으로 통째로 읽고 파일당 두 번 소문자화. 순위 없음,
  다중 단어 쿼리는 연속 부분문자열만 매칭, 결과는 경로순. 프론트엔드 디바운스만
  250ms이고 최소 글자수 제한 없음(`src/features/search/SearchListPanel.tsx:12-56`).
  → F5.

- [ ] **인덱스가 있는데 우회됨** — `notes_list`가 모든 파일 내용을 다시 읽어 메타데이터
  생성(`src-tauri/src/services/notes.rs:338-341`)하나 `TagIndex`에 같은 메타데이터가 이미
  있다. 매 저장마다 `index.invalidate`되어 다음 `tags_list`/`timeline_*`/`activity_recent`가
  전체 리스캔(`src-tauri/src/services/index.rs:123-129, 139-155`). 모듈 문서가 약속한
  `.naiteh/tags.json` 디스크 캐시는 미구현. → F5.

- [ ] **H1(프론트). 가상화 전무 — 노트 트리가 전체를 DOM에 마운트**
  `src/features/notes/NotesListPanel.tsx:377-528`
  폴더 기본 전부 펼침(`useState(true)`, `:386`), `FolderRows` 비메모, props 객체가 매
  렌더 재생성되어 상태 변경마다 트리 전체 재렌더. 수천 노트에서 지각 현상.

- [ ] **50MB 첨부가 JSON 정수 배열로 IPC 직렬화** —
  `src/lib/editorAttachmentDrop.ts:29, 107-112`. ~150-300MB 문자열 생성, 큰 스크린샷
  붙여넣기에 UI 수 초 멈춤. Tauri v2 raw-payload 또는 청크 업로드로 해결.

- [ ] **캘린더 새로고침이 순차 처리** — `src-tauri/src/commands/calendar.rs:183-189`.
  도달 불가 피드 N개에 최대 N×45초(소스당 connect 15s/total 45s,
  `src-tauri/src/services/calendar.rs:364-370`). `futures::join_all` + 소스별 오류 격리 필요.

- [ ] **위키링크 제목 폴백이 노트 전체 재스캔** — `src-tauri/src/services/chat_doc.rs:595-609`.
  미해결 링크당 `notes/*.md` 전체 `read_to_string`(링크당, 최대 10개).

- [ ] **상태바 단어 수가 키 입력마다 문서 전체 재계산** — `src/shell/StatusBar.tsx:17, 38-41`.
  디바운스 필요.

- [ ] **검색 결과가 `contentVersion` 범프마다 재쿼리** —
  `src/features/search/SearchListPanel.tsx:56`.

---

## 4. 보안

- [ ] ✅ **H2. 노트 front matter `url:` 하나로 LLM API 키 탈취 가능**
  `src-tauri/src/services/chat_doc.rs:370-378`
  채팅 노트/에이전트 front matter의 `url:`이 프로바이더 baseUrl을 덮어쓰고, 그
  프로바이더의 실제 API 키가 `Authorization: Bearer`로 그 URL로 전송된다
  (`src-tauri/src/services/llm.rs:123-135`). 검증은 https 여부만
  (`validate_ai_base_url`, `src-tauri/src/services/config.rs:417-449`). 노트와 에이전트
  정의는 볼트에서 읽히므로(Git pull로 유입 가능 — 코드베이스 스스로 싱크 심링크/훅을
  거부하는 위협 모델), 악성 `url:` 노트에서 채팅 실행 한 번으로 키 유출. → F4.

- [ ] **L4. 시크릿 전부 평문 저장, OS 키체인 미사용**
  LLM API 키: `config.json` 평문(`src-tauri/src/services/config.rs:175-181`).
  30일 세션 토큰: `remembered-session.json` 평문(`src-tauri/src/services/auth.rs:55-58, 346-362`).
  사용자 권한 프로세스가 한 번에 수확 가능. DPAPI/Keychain/libsecret 도입 검토.

- [ ] **M3. 감사 로그: 회전이 히스토리를 파괴, 무결성·내구성 없음**
  `src-tauri/src/services/auth.rs:693-712`
  단일 회전(`audit-log.1.jsonl` 덮어씀)으로 전체 히스토리 ~10MB 상한. 평문 JSONL에
  해시체인/HMAC 없음, append가 fsync 안 됨. 관리자 대면 "감사 로그"치고는 약함.

- [ ] **M5. 캘린더 SSRF 검사가 이름 기반 — DNS 리바인딩 우회**
  `src-tauri/src/services/calendar.rs:272-281`(`is_public_url`)
  호스트명 기준 검증 시점과 실제 fetch의 DNS 재해석 시점이 달라 우회 가능.
  리다이렉트 재검사는 있음(`calendar.rs:355-363`)으나 초기 요청이 IP-고정이 아님.

- [ ] **L9. `attachments_import`이 임의 경로 파일 읽기 프리미티브**
  `src-tauri/src/services/attachments.rs:26-48` + `src-tauri/src/commands/attachments.rs:15-39`.
  렌더러가 임의 OS 경로를 지정하면 50MB까지 볼트로 복사 후 재열람 가능. 세션 게이트
  내·동일 사용자 신뢰 모델이라 정보성.

- [ ] **M6. `ChatRequests` stop/run 정리 경쟁으로 신규 요청 취소 핸들 고아화**
  `src-tauri/src/services/llm.rs:597-618`. `run(id)` → `stop(id)` → `run(id)` 재사용 시
  첫 실행의 정리가 신규 요청의 `oneshot::Sender`를 제거해 영구 취소 불가.

---

## 5. 아키텍처·유지보수

- [ ] **H5. TS↔Rust DTO 전부 수동 미러링, 코드젠 없음**
  `src/lib/types.ts:1`(441줄). ts-rs/specta 도입 검토. Rust 쪽 rename이 프론트엔드에서
  조용히 무시됨. `CalendarConfig.subView: string`처럼 유니언이어야 할 것도 stringly.

- [ ] **M7. YAML 파서가 3개이고 메타데이터용이 가장 약함**
  `src-tauri/src/services/notes.rs:132-154`(`parse_header` — flow 리스트만),
  `src-tauri/src/services/chat_doc.rs:45-82`(블록 리스트 지원),
  `src/lib/frontMatter.ts`(TS — `[...]`만, `:126-134`).
  **Obsidian이 쓰는 블록형 `tags:` 목록을 태그/검색/핀이 읽지 못한다** — Obsidian 호환
  클론의 핵심 상호운용성 결함. 하나의 파서로 통일 필요.

- [ ] **H3(프론트). 핵심 CRUD가 `window.prompt`/`window.confirm` 사용**
  `src/features/notes/NotesListPanel.tsx:115, 153, 190-192, 215, 274`,
  `src/lib/chatMd/chatFlow.ts:275`. 웹뷰 전체 정지(autosave 타이머 포함), Tauri 권고
  위반(`@tauri-apps/plugin-dialog` 이미 있음), 스타일·로케일 불가.

- [ ] **H6(프론트). 서버 상태 중복** — `state/syncStore.ts`가 있는데
  `src/features/sync/SyncListPanel.tsx:42, 80-96`이 자체 상태를 따로 받음. 노트 목록도
  패널 3곳이 로컬 state로 독립 재요청(동기화 1번에 목록 3회+ 재요청). 서버 상태 캐시
  통합 필요.

- [ ] **M5(프론트). 노트 전환 중 1프레임 창의 view/store 경쟁으로 삽입 유실 가능**
  `src/state/editorStore.ts:288-309` + `src/shell/EditorPanel.tsx:145-154`.
  `openNote` 후 뷰 재생성 전 `appendToDocument`가 구 뷰를 조작하면 키 가드가 미러링을
  건너뛰고 텍스트가 사라짐.

- [ ] **M6(프론트). 중단된 채팅 스트림이 미완성 응답을 표시 없이 남김**
  `src/lib/chatMd/chatFlow.ts:118-151`. 부분 수신 후 실패 시 잘림 표시·롤백 없음.

- [ ] **M1(프론트). `isAppError`가 `{ kind: string }`이면 통과** —
  `src/lib/types.ts:370-375`. 유니언 검증 없음. `src/state/authStore.ts:106`은
  `Error`가 아닌 날객체를 throw.

- [ ] **M2(프론트). `invoke()` 래퍼에 타임아웃·취소·공통 로딩 규약 없음** —
  `src/lib/api/invoke.ts:59-82`. `lib/`에 무음 `catch {}` 11곳.

- [ ] **M8(프론트). 노트 트리에 키보드 내비게이션·트리 시맨틱 없음** —
  `role="tree"/"treeitem"`, 화살표 이동, type-ahead 부재.

- [ ] **M9(프론트). 의존성 2024-12 고착** — React 18.3.1, Vite 5, Vitest 2. 커버리지
  임계치 없음.
- [ ] **M10(프론트). ESLint가 타입 체크 규칙 미사용** —
  `eslint.config.js:13`(`recommended`만). `no-floating-promises`가 C2를 잡을 수 있었음.
  `recommendedTypeChecked` 승격 검토.

- [ ] **L3(프론트). 테스트 공백이 결함과 겹침** — 미커버: `state/syncStore.ts`,
  `state/vaultContentStore.ts`, `lib/activateVault.ts`, 캘린더 컴포넌트 3종,
  `ModelPicker.tsx`. 로그아웃-충돌 시나리오(C1)·`preserveAsCopy` 실패(C2) 테스트 없음.

- [ ] **M4(백). 읽기 불가 노트가 무음히 "빈 것"으로 강등** —
  `src-tauri/src/services/index.rs:143`, `src-tauri/src/services/notes.rs:339`의
  `unwrap_or_default()`. Windows 파일 락 등에서 태그/타임라인/검색에서 조용히 사라짐.

- [ ] **M8(백). Git 동기화가 볼트 전체를 커밋, 크기 정책 없음** —
  `src-tauri/src/services/git.rs:499-525`(`stage_all`). 100MB 초과 첨부가 이후 모든
  동기화를 실패시킴. 경고·LFS·제외 옵션 없음.

- [ ] **L3(백). 훅이 저장마다 새 OS 스레드, 무제한 중첩** —
  `src-tauri/src/services/hooks.rs:99`. 실패·타임아웃이 `eprintln!`만(창 없는 앱에서
  보이지 않음).

- [ ] **L5(백). 동기(sync) 명령 일부가 메인 스레드에서 블로킹 IO** —
  `src-tauri/src/commands/auth.rs:199-251`, `settings.rs:31-37`, `vault.rs:78-111, 188-235`.

- [ ] **L7(백). Git 오류가 전부 `Io(String)`으로 평탄화** —
  `src-tauri/src/services/git.rs:65-67`. 프론트엔드가 분기할 수 있는 오류 클래스 소실.

- [ ] **L8(백). 워처가 `.tmp` 등 접미 파일을 무조건 무시** —
  `src-tauri/src/services/watcher.rs:378-381`. 사용자의 실제 `.tmp` 노트는 갱신 이벤트
  미수신.

---

## 6. 제품 수준 격차 (vs Evernote / Obsidian)

| 영역 | naiteh 현황 | 원본 |
|---|---|---|
| 검색 | 전체 스캔, 순위 없음, 연속 부분문자열만 | Obsidian: 인덱스+쿼리 문법 / Evernote: 서버 검색 |
| 동기화 | 전용 서버 없음. 공식 백업이 Google Drive 폴더 동기화(README 스스로 Drive↔Git 충돌·병합 불가 인정). 선택적 Git 동기화는 100MB 첨부로 전체 실패, E2EE 없음 | 둘 다 자체 서버 |
| 편집 | 소스 모드 Markdown만 (WYSIWYG·라이브 프리뷰 v1 비목표) | Obsidian 라이브 프리뷰 / Evernote WYSIWYG |
| 연결 | 백링크·위키링크·그래프 없음 (v2 후보) | Obsidian 핵심 |
| 생태계 | 플러그인·사용자 테마 없음 (CLI 훅만) | Obsidian 최대 해자 |
| 모바일 | 없음 (v1.5 연구 예정) | 둘 다 있음 |
| 버전 이력 | Git 히스토리는 있으나 탐색 UI 없음(충돌 해결뿐) | Evernote 노트 히스토리 |
| i18n | 전무 — UI 문자열 전부 영어 하드코딩 | — |
| 릴리스 | 버전 `0.0.0`, 코드사이닝·자동업데이트·릴리스 워크플로우 없음 (CI는 디버그 번들만) | — |

로컬 로그인·감사 로그의 보안 의미도 제한적이다(볼트가 평문 `.md`라 디스크 접근자에게는
무의미, 감사 로그는 변조 가능). 관리자 대면 기능으로는 M3 수준의 무결성이 필요하다.

저장소 관리: main에서 캘린더 기능 등 22개 파일 수정 + 13개 미추적 파일이 커밋 없이
방치 중 — 작업 단위 커밋 권장.

---

## 7. 잘 되어 있는 부분 (참고)

- 쓰기 경로 무결성: `fsx::atomic_write` 전면 통일 + 자기-변경 레지스트리 + SHA-256
  버전 프로토콜 + `StaleWrite` 표면화 (`src-tauri/src/services/fs.rs:49-87`,
  `notes.rs:23-72`).
- 경로 격리: 탈출·심링크·`.git`·`GIT~N`·NTFS 스트림 차단 + 실제 테스트
  (`notes.rs:401-545`, `conflicts.rs:236-256`, `vault_path.rs`).
- 인증 거버넌스: Argon2id + OS-Rng 솔트, 더미 해시 타임밍 평준화, 계정 잠금,
  `generate_handler!`를 파싱해 모든 명령의 세션 게이트를 검증하는 메타 테스트
  (`src-tauri/src/lib.rs:454-488`).
- 프론트엔드: autosave 동시성 설계(모듈 계약 위반 C1/C2 제외하고 우수), TS strict
  옵션 전부 + `any` 제로, GitHub 스키마 새니타이즈 읽기 뷰, CodeMirror 6(한글 IME
  정상), 올바른 모달 포커스 트랩.
- CI: 3-OS 매트릭스 + clippy `-D warnings` + hex 색상/`fs::write` 금지 가드.

---

## 8. 신규: 자동 백업 기능 리뷰 (2026-10-13, 미커밋 작업 트리)

대상: `services/backup.rs`(1557줄), `services/backup_sftp.rs`(261줄),
`commands/backup.rs`(672줄), `lib/api/backup.ts`, `state/backupStore.ts`,
`features/backup/*`, `BackupSection.tsx`, Cargo(`ssh2 0.9.5`), watcher/session/lib 연결부.

**총평**: 볼트 쓰기 경로(복원)는 기존 규약을 모범적으로 준수 — `fsx::atomic_write`,
per-vault 락, `expected_version` → `StaleWrite`, `resolve_in_vault`, 인덱스 무효화,
12개 신규 명령 전부 `require_session` + 메타테스트 확장(`lib.rs:421`). TOFU 호스트키
처리가 교과서적(지문 제공 → 확인 시 실시간 키 재검증 + 자격증명 시험 → 핀),
비밀번호/패스프레이즈는 IPC로 절대 노출 안 됨(`SftpView`는 `hasPassword`만,
테스트로 강제). `RemoteFs` 트레이트 + `LocalDirFs` 테스트 더블 설계 우수.
커밋 전 아래 H1·M2 수정 권장, M3·M1 같은 패스 권장.

### 커밋 전 수정 권장

- [ ] **B-H1. Drive 대상 폴더 쪽 심링크 격리 없음 — 백업 폴더 밖으로 읽기·쓰기 탈출 가능**
  `services/backup.rs:580-616` — `LocalDirFs::abs`가 사전적 결합 + `safe_rel`만 적용.
  대상 폴더 안에 심링크가 있으면(다른 머신에서 동기화된) `backup_read_file`이 그것을
  통과해 읽고, `run_backup`이 그것을 통과해 씀. 앱 자신의 위협 모델(`resolve_in_vault`가
  존재하는 이유)과 모순. `canonicalize_lenient` 재사용으로 저렴하게 수정 가능.
- [ ] **B-M2. 일시적으로 읽을 수 없는 로컬 파일이 "삭제"로 오판되어 원격 사본을 휴지통행**
  `services/backup.rs:499-501`(읽기 실패 `continue`) → `plan`이 삭제로 분류(`:530-535`)
  → 원격 사본 trash(`:721-727`). 실행은 "성공" 보고. `NotFound`(→ trash)와 다른 IO
  오류(→ 건너뛰기+표시)를 구분해야 함. 업로드 루프(`:703`)도 같은 무음 스킵.
- [ ] **B-M3. 자동 백업 실패가 변경 신호를 삼켜 다음 편집까지 재시도 없음**
  `commands/backup.rs:381` — `record_run_start`가 연결 전에 세대를 기록,
  `is_due`가 `vault_changed`까지 요구(`backup.rs:1041-1046`). T시점 변경 → 백업 실패 →
  서버 회복 후에도 유휴 볼트는 재시도 안 됨. 성공 시에만 세대 기록으로 수정.

### 차선 (같은 패스 또는 fast-follow)

- [ ] **B-M1. 백업이 스냅샷이 아님** — 스캔(`:496-512`) 후 업로드 때 재독(`:703`),
  크로스파일 토린 상태 가능. 모듈 주석 "각 파일 한 번 읽음"(`:20-22`)과 불일치.
  주석·`vault-and-data.md` 수정 + 해시 불일치 재큐 검토.
- [ ] **B-L1. 동시 실행 가드가 타깃 id 기준** — 같은 폴더를 가리키는 두 타깃이 병렬 실행되어
  매니페스트 read-modify-write 유실 가능(`backup.rs:1051-1073`).
- [ ] **B-L5. UI/백엔드 기본값 불일치** — 원격 디렉터리 기본값, 볼트 표시명 vs 폴더명,
  인터벌 최소값(프론트 ≥1 vs 백엔드 ≥5)이 왕복 후에야 오류로 드러남.
- [ ] **B-L6. 취소된 신뢰 플로우가 평문 비밀번호를 남김** — `cancelTrust`에서
  `backupTargetRemove` 실패 시 `TargetDialogs.tsx:300-311`.
- [ ] 기타: SFTP 연결 재사용 없음(`backup_read_file`마다 새 세션), `backup_sftp.rs`·
  `commands/backup.rs` 테스트 0건, 스케줄러가 async 런타임 스레드에서 블로킹 IO
  (`commands/backup.rs:514-519`), 멀티 A레코드 첫 주소만 시도(`backup_sftp.rs:41-46`).

### 잘 된 점

- 복원(`backup_restore_file`): 바이트 선취득 → 락 → 원자적 쓰기 → `StaleWrite` 존중,
  크로스-볼트 매니페스트 거부, 변조된 매니페스트 경로 삭제 처리.
- 휴지통-대신-삭제 미러 설계 + 50 연산마다 매니페스트 체크포인트 + 실패 run에도 저장.
- 엔진 17개 단위 테스트 + `BackupSection.test.tsx`(398줄, TOFU·쓰기전용 비밀·진행률)
  + `CompareModal.test.tsx`(복원 사본/덮어쓰기/StaleWrite) — 위키 문서 주장은
  코드와 정확히 일치(재검증됨).
