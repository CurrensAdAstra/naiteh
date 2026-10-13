# F1~F5 반영을 위한 수정 프롬프트 (2026-10-13)

`docs/code-review-2026-10-13.md`의 우선 수정 Top 5를 각각 자립적으로(다른 맥락
없이도) 수행할 수 있는 프롬프트. 하나의 공통 프리앰블 + 항목별 프롬프트 구성이며,
그대로 복사해 코딩 에이전트/개발자에게 전달하면 된다.

**실행 순서 권장**: F1+F2 한 세트(같은 모듈, 테스트 겹침) → F3 → F4(독립적, 가장
단순) → F5a → F5b → F5c. F5b·F5c는 각각 독립 커밋으로 나누면 리뷰가 쉽다.

---

## 공통 프리앰블 (각 프롬프트 앞에 붙일 것)

```text
저장소: C:\Users\Administrator\Documents\GitHub\naiteh (Tauri v2 + Rust + React 18/TS 노트 앱)
컨벤션(반드시 준수):
- 모든 볼트 파일 쓰기는 services/fs.rs의 fsx::atomic_write 경유. std::fs::write 금지(CI 가드).
- 노트 쓰기는 services/notes.rs의 write_versioned(expected_version) 사용 → 충돌 시 AppError::StaleWrite 반환.
- 모든 IPC 명령은 require_session 먼저 호출(lib.rs 메타테스트가 검증).
- IPC 스펙 변경 시 vault/wiki/ipc-api.md와 domain-model.md를 함께 갱신(wiki가 사실의 원천).
  architecture.md을 고치면 커밋 제목에 [architecture] 마커 필요.
- TS는 strict(no any), hex 색상은 tokens.css만.
완료 판정: pnpm check 통과(= typecheck + lint --max-warnings=0 + vitest + cargo fmt/clippy -D warnings + cargo test).
```

---

## F1 — 로그아웃 시 충돌 보류 편집 유실

```text
문제: state/authStore.ts의 clearSession(약 118행)이 flushPendingSave()를
{ leaving: true } 없이 호출한다. autosave 모듈의 계약(state/autosave.ts 상단 주석)상
문서를 떠나는 경로는 leaving: true로 호출해야 보류(held) 편집이
.local-<타임스탬프>.md 사본으로 보존되는데, 노트 전환(lib/openDocument.ts:73)은
지키고 로그아웃만 어겨서 메모리에만 존재하던 편집이 유실된다.

수행:
1. lib/와 state/에서 flushPendingSave() 호출부를 전수 조사해서 분류하라:
   - 문서를 떠나는 경로(로그아웃/세션 상실/볼트 전환/창 닫기) → { leaving: true } 전달.
   - 에디터가 열려 있는 경로(동기화 직전 flush 등) → 인자 없음 유지.
2. authStore.ts clearSession의 호출을 { leaving: true }로 수정.
3. 테스트(state/__tests__/autosave.test.ts 또는 authStore 테스트에 추가):
   외부 변경으로 편집이 held 상태인 상황에서 clearSession을 실행하면
   notesWrite가 .local- 사본 경로로 호출됨을 확인하는 테스트.
   기존 18개 autosave 테스트가 전부 통과해야 한다.
주의: 이 수정만으로 C2(preserveAsCopy 실패 처리)는 고쳐지지 않는다. F2와 세트로 진행 권장.
```

---

## F2 — 사본 저장 실패의 무음 유실 + 거짓 재시도 표시

```text
문제: state/autosave.ts의 preserveAsCopy(약 253~268행)는 notesWrite(사본 경로)가
실패하면 console.error만 남기고 return한다. 이 시점에 entry는 이미 pending에서
제거된 상태라(arm() 또는 flushPendingSave의 pending.clear) 재시도가 없고 편집이 사라진다.
또 flushPendingSave({leaving:true})가 이를 void enqueue(...)로 실행해 enqueue가
rejection을 삼키므로(약 129~132행) 호출부(창 닫기 등)는 보존 성공으로 진행한다.
shell/StatusBar.tsx(약 116행)는 실제로는 아무 재시도가 없는데
"Save failed — retrying"을 표시한다.

수행:
1. preserveAsCopy 실패 시 entry를 버리지 말고 재시도 큐에 되돌려라:
   실패한 entry를 pending에 유지(또는 held 상태 유지)하고 기존 일반 저장 실패와
   같은 백오프(2초부터 60초까지 배가)로 재시도를 예약. releaseSave/알림은 성공 시에만.
2. flushPendingSave({leaving:true})가 preserveAsCopy의 실제 결과를 반영하게 하라:
   enqueue가 삼키는 rejection을 최소한 로깅+상태 반영하고, 보존 실패 시
   setSaveError로 UI에 사실을 알릴 것. 반환값 설계는 자유지만 호출부
   (openDocument.ts, shell/useWorkspaceLifecycle.ts 창 닫기)가 거짓 성공으로
   진행하지 않게 할 것.
3. StatusBar: "Save failed — retrying"은 실제 재시도가 예약된 경우에만 표시.
   재시도가 없는 실패는 오류 상태로만 표시.
4. 테스트: notesWrite(사본 경로)가 첫 시도만 실패하도록 mock → entry가 재큐되어
   재시도에서 성공하고 .local- 사본이 쓰이는지; 계속 실패하면 saveError가
   유지되는지 확인.
```

---

## F3 — 핀 토글 무버전 덮어쓰기

```text
문제: apps/desktop/src-tauri/src/commands/notes.rs의 notes_set_pinned_impl(294~307행)는
파일을 읽어 pinned 플래그만 바꿔 fsx::atomic_write로 덮어쓴다. 다른 모든 쓰기가 쓰는
expected_version(SHA-256) 검사(services/notes.rs의 write_versioned)를 우회하므로,
읽기와 쓰기 사이에 Google Drive 등이 내려놓은 새 본문을 이전 내용으로 되돌려
외부 편집을 파괴한다.

수행:
1. notes_set_pinned IPC에 expected_version: Option<String> 파라미터 추가
   (notes_write와 동일한 규약: Some 불일치 → AppError::StaleWrite(현재 버전),
    None → 무조건 쓰기. vault 락은 이미 상위에서 잡히는지 확인하고 안 잡히면 잡을 것).
2. 구현을 write_versioned 기반으로 교체(원자적 쓰기+버전 검사+새 버전 반환).
3. 프론트엔드(lib/api/notes.ts setPinned, shell/EditorPanel.tsx PinToggleButton)에서
   현재 열린 문서의 version(editorStore의 open.version)을 전달.
   StaleWrite 응답 시 기존 외부변경 흐름(lib/externalChange.ts 또는 노트 재로드 +
   안내)으로 연결해 사용자가 충돌을 알 수 있게 할 것.
4. vault/wiki/ipc-api.md의 notes_set_pinned 항목 갱신.
5. Rust 테스트: 기대 버전 불일치 → StaleWrite이고 파일이 변하지 않음;
   일치 → 핀 토글 반영; expected_version=None → 무조건 쓰기.
   프론트 테스트: PinToggleButton이 version을 넘기는지, StaleWrite 시 안내 동작.
```

---

## F4 — 채팅 노트 `url:` 오버라이드를 통한 API 키 유출 차단

```text
문제: services/chat_doc.rs의 resolve_request(약 370~384행)에서 채팅 노트/에이전트
front matter의 url: 값이 프로바이더 baseUrl을 덮어쓰고, 그 프로바이더의 실제 API 키가
Authorization 헤더로 그 URL로 전송된다. 검증(validate_ai_base_url)은 https 여부만 본다.
노트와 에이전트 정의는 볼트에서 읽히므로(git pull로 유입 가능) 악성
url: https://attacker.example 노트 하나로 키가 유출될 수 있다.

수행:
1. 정책: 신뢰할 수 없는 출처(노트/에이전트 front matter의 layer.url)의 baseUrl 오버라이드는
   "키가 필요 없는 로컬 프로바이더(예: ollama, lmstudio)"에만 허용한다.
   provider.needs_key() && layer.url.is_some()이면
   AppError::Validation("The url: override in note/agent front matter is only
   allowed for keyless local providers")를 반환하고 요청을 만들지 않는다.
   - Settings에서 사용자가 직접 설정한 ai.providers.<id>.baseUrl(신뢰된 설정)은
     기존대로 키와 함께 동작해야 한다(회귀 금지).
   - ai_chat_send와 ai_infer_title 모두 resolve_request를 거치므로 한 곳에서 차단되는지 확인.
   - validate_ai_base_url(https 제한)는 그대로 유지.
2. vault/wiki의 AI 문서(domain-model.md의 Front-matter keys, product-overview.md)에
   새 규칙 문서화.
3. 테스트(chat_doc.rs #[cfg(test)]): (a) url: + 키 필요 프로바이더 → Validation 에러;
   (b) url: + ollama(키리스) → 허용; (c) 설정 baseUrl + 키 → 기존 동작 유지;
   (d) agent 파일의 url:도 동일 차단.
```

---

## F5 — 검색·메타데이터 인덱싱 + 목록 가상화 (3단계로 분리 실행)

```text
문제(3가지):
(a) commands/search.rs의 search_text가 쿼리마다 모든 노트를 디스크에서 통째로 읽고
    파일당 두 번 to_lowercase한다(57~96행). 인덱스 없음, 최소 글자수 제한 없음.
(b) notes_list가 TagIndex에 이미 있는 메타데이터를 무시하고 모든 파일을 다시 읽는다
    (services/notes.rs 338~341행). 매 저장마다 index.invalidate → 다음 조회 때 전체 리스캔.
    모듈 문서가 약속한 .naiteh/ 디스크 캐시도 미구현.
(c) features/notes/NotesListPanel.tsx(377~528행)가 노트 트리 전체를 DOM에 마운트하고
    (폴더 기본 전부 펼침, FolderRows 비메모, props 매 렌더 재생성, buildTree 비메모)
    수천 노트에서 재렌더마다 트리 전체가 다시 그려진다.

단계별 수행:
[5a — 메타데이터 통일, 먼저]
 notes_list_impl이 TagIndex 스냅샷(get_or_build)에서 NoteMeta를 읽게 하라.
 빈 디렉터리 표시에는 여전히 디렉터리 walk가 필요할 수 있음(파일 읽기와 분리).
 인덱스 신선도 근거(쓰기 무효화 + 워처 무효화 + watch-error 시 폴링)가 timeline/tags와
 동일하므로 일관성 주장 가능. 기존 notes_list 테스트 통과 + 대형 임시 볼트로
 동작 확인 테스트 추가.
[5b — 검색 콘텐츠 캐시]
 services/index.rs에 콘텐츠 캐시를 추가하라: 파일별 (path, mtime, size)를 키로
 소문자화 콘텐츠를 캐시(메모리 + .naiteh/ 디스크 저장, 모듈 주석이 이미 약속한 형태).
 search_text는 mtime/size 불일치 파일만 재독취하고 캐시된 콘텐츠에서 매칭.
 to_lowercase를 파일당 1회로 축소. 프론트(SearchListPanel)에 최소 쿼리 길이(2자) 추가.
 의미 변경(다중 단어, 순위)은 이 단계 범위 밖 — 하지 않는다.
 테스트: 캐시 히트/무효화(mtime 변경, 삭제), 결과가 기존 구현과 동일함을 보존하는
 동등성 테스트(기존 search_snapshot 테스트 기반).
[5c — 트리 가상화]
 NotesListPanel의 트리를 "보이는 행의 평탄화 목록(펼쳐진 폴더의 자식만)"으로 변환해
 윈도잉을 적용하라. 의존성 추가가 필요하면 @tanstack/react-virtual 또는 react-window
 (pnpm 유틸리티 규칙 준수, lockfile 갱신). FolderRows를 React.memo로 감싸고
 actions/folderActions 객체를 useMemo로 안정화, buildTree를 useMemo.
 폴더 접힘/펼침 상태는 유지. 기존 NotesListPanel 테스트가 통치하도록 DOM 구조
 변경은 최소화(role/class명 유지), 필요시 테스트 갱신.
 각 단계는 별도 커밋으로, pnpm check 전 단계 통과 필수.
```
