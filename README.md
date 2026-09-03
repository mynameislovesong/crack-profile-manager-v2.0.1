# Crack 프로필 관리 보조 2.0.1

크랙의 `설정 → 채팅 → 대화 프로필` 카드에 현재 연결 채팅, 개인 메모, 메모 글씨 색, 카드 배경색, 프로필 순서 편집 및 일괄 삭제를 추가하는 Chrome/Edge Manifest V3 확장 프로그램입니다.


## 2.0.1 수정

- 연결 채팅 제목이 중복되지 않아도 모든 채팅에 마지막 메시지 첫 줄을 표시합니다.
- 각 연결 채팅 오른쪽에 `updatedAt` 기반 로컬 시간을 표시합니다 (`오늘 HH:MM`, `어제 HH:MM`, 이전 날짜).
- `lastMessage`가 문자열이 아닌 작은 메시지 객체인 경우에도 텍스트 필드를 안전하게 읽습니다.
- 채팅 상세 조회가 일시적으로 실패하면 429/네트워크/5xx 응답을 최대 3회 재시도하고, 실패 항목을 fresh cache로 고정하지 않아 다음 로드에서 다시 확인합니다.
- 상세 조회 동시 요청 수를 낮춰 일시적인 요청 실패 가능성을 줄였습니다.

## 설치

1. 기존 1.x 확장을 사용 중이면 Chrome 확장 프로그램 화면에서 먼저 비활성화합니다. 데이터는 같은 저장 key를 사용하므로 메모가 유지됩니다.
2. `chrome://extensions` 또는 `edge://extensions`를 엽니다.
3. 개발자 모드를 켭니다.
4. `압축해제된 확장 프로그램을 로드합니다`에서 이 폴더를 선택합니다.
5. `https://crack.wrtn.ai/setting/chat?menu=chat_profile`을 새로고침합니다.

## 확인된 크랙 구조와 구현 방식

- 대화 프로필 stable ID: `GET /profiles/{ownerProfileId}/chat-profiles`의 각 항목 `_id`
- 현재 연결 판별: `GET /v3/chats/{chatId}`의 현재 `chatProfile._id`
- 채팅 stable ID/제목/구분 문구: 목록 응답의 `_id`, `title`, `lastMessage` 첫 비어 있지 않은 줄
- 이동: 현재 크랙의 `window.next.router.push`와 기존 스토리/캐릭터 경로 규칙
- 단일 삭제 원본 경로: 원본과 같은 API 클라이언트의 `DELETE /profiles/{ownerProfileId}/chat-profiles/{chatProfileId}`
- 삭제 확인: 크랙 단일 삭제 화면이 쓰는 기존 confirm 서비스
- 카드 원본 배경: `bg-surface_tertiary` / `--surface_tertiary`
- 색상: 크랙의 light/dark 연동 `--accent_surface_*`, `--accent_text_*`, `--surface_cracker_tertiary` 토큰

실제 프로필 응답에는 order/index/sortOrder 필드가 없고 현재 번들의 프로필 API 모듈에도 reorder 함수나 엔드포인트가 없습니다. 그래서 서버 데이터나 DOM 노드 순서를 변조하지 않고, stable `_id` 배열을 확장 저장소에 저장한 뒤 각 카드의 CSS `order`만 적용합니다. 새 프로필은 저장 순서 뒤에 원본 응답 순서대로 합쳐지고 삭제된 ID는 자동 제외됩니다.

## 저장 데이터

- 메모·메모 색·카드 색: `chrome.storage.local`의 기존 `crackProfileConnectionNotesV1`
  - key: 대화 프로필 `_id`
  - 기존 `{ text, updatedAt }`는 그대로 읽음
  - 새 선택값만 `memoColor`, `cardColor`로 추가
  - 필드가 없거나 `default`이면 크랙 원래 테마 색을 사용
- 표시 순서: `crackProfileOrderV2`
  - key: 로그인 소유자 프로필 `_id`
  - value: 대화 프로필 `_id[]`
- 연결 캐시: 기존 `crackProfileConnectionIndexV1`

확장 권한은 기존과 동일하게 `storage`뿐입니다. 호스트 권한, 외부 서버, 원격 코드가 없습니다.

## 동작 메모

- 메모 색은 접힌 미리보기의 실제 메모 부분과 textarea 입력 글씨에만 적용됩니다.
- 카드 색 메뉴는 크랙의 `수정하기`, `삭제하기` 메뉴가 열린 뒤 `삭제하기` 바로 아래에 삽입됩니다.
- 편집 모드에서는 카드 선택/드래그 충돌을 막기 위해 연결 채팅과 메모 영역을 잠시 비활성화합니다. `완료` 후 원래대로 돌아옵니다.
- 드래그는 손잡이에서만 시작하며 Pointer Events를 사용합니다. 손잡이 밖의 모바일 세로 스크롤은 그대로 유지됩니다.
- 일괄 삭제는 연결 인덱스를 다시 탐색하지 않고 기존 `Map<profileId, ChatInfo[]>`를 재사용해 경고를 만듭니다.
- 삭제는 대표/현재 선택 프로필 처리까지 크랙 서버와 원본 초기화 로직에 맡기기 위해 순차 완료 후 프로필 페이지를 한 번 새로고침합니다.
