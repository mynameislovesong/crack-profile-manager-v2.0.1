const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

test("연결 0개, 1개, 여러 개와 동일 제목을 ID로 인덱싱한다", () => {
  const chats = [
    { _id: "chat-a", title: "같은 제목", profileId: "profile-1" },
    { _id: "chat-b", title: "같은 제목", profileId: "profile-1" },
    { _id: "chat-c", title: "다른 제목", profileId: "profile-2" },
    { _id: "chat-d", title: "미연결", profileId: null }
  ];
  const index = core.buildProfileIndex(chats);
  assert.equal(index.get("profile-0"), undefined);
  assert.deepEqual(index.get("profile-2").map((chat) => chat._id), ["chat-c"]);
  assert.deepEqual(index.get("profile-1").map((chat) => chat._id), ["chat-a", "chat-b"]);
});

test("이름이 아닌 profileId만 연결 판별에 사용한다", () => {
  const profiles = [
    { _id: "profile-a", name: "중복 이름" },
    { _id: "profile-b", name: "중복 이름" }
  ];
  const index = core.buildProfileIndex([
    { _id: "chat-a", title: "중복 제목", profileId: profiles[0]._id },
    { _id: "chat-b", title: "중복 제목", profileId: profiles[1]._id }
  ]);
  assert.equal(index.get("profile-a")[0]._id, "chat-a");
  assert.equal(index.get("profile-b")[0]._id, "chat-b");
});

test("updatedAt이 같은 캐시는 재사용하고 변경된 채팅만 다시 읽는다", () => {
  const chats = [
    { _id: "same", updatedAt: "1" },
    { _id: "changed", updatedAt: "2" },
    { _id: "new", updatedAt: "1" }
  ];
  const cache = {
    same: { updatedAt: "1", chatProfileId: "p1" },
    changed: { updatedAt: "1", chatProfileId: "p2" },
    deleted: { updatedAt: "1", chatProfileId: "p3" }
  };
  const plan = core.planChatDetails(chats, cache, []);
  assert.equal(plan.reused.get("same"), "p1");
  assert.deepEqual(plan.pending.map((chat) => chat._id), ["changed", "new"]);
  const nextCache = core.makeChatCache([
    { _id: "same", updatedAt: "1", profileId: "p1" },
    { _id: "changed", updatedAt: "2", profileId: "p4" }
  ]);
  assert.equal(nextCache.deleted, undefined);
  assert.equal(nextCache.changed.chatProfileId, "p4");
});

test("강제 무효화된 채팅은 updatedAt이 같아도 다시 읽는다", () => {
  const chats = [{ _id: "chat-a", updatedAt: "1" }];
  const cache = { "chat-a": { updatedAt: "1", chatProfileId: "p1" } };
  const plan = core.planChatDetails(chats, cache, ["chat-a"]);
  assert.deepEqual(plan.pending.map((chat) => chat._id), ["chat-a"]);
});

test("스토리와 캐릭터 채팅은 stable ID로 기존 경로를 만든다", () => {
  assert.equal(
    core.routeForChat({ _id: "chat-1", storyId: "story-1" }),
    "/stories/story-1/episodes/chat-1"
  );
  assert.equal(
    core.routeForChat({ _id: "chat-2", characterId: "character-1" }),
    "/characters/character-1/chats/chat-2?autoScroll=false"
  );
});

test("메모 미리보기는 공백을 정리하고 긴 글을 안전하게 줄인다", () => {
  assert.equal(core.notePreview("  첫 줄\n  둘째 줄  ", 20), "첫 줄 둘째 줄");
  assert.equal(core.notePreview("가".repeat(50), 10), `${"가".repeat(10)}…`);
  assert.equal(core.notePreview("   ", 10), "");
});

test("마지막 메시지는 첫 번째 비어 있지 않은 줄만 안전하게 줄인다", () => {
  assert.equal(core.firstContentLine("\n  첫 메시지  \n둘째", 20), "첫 메시지");
  assert.equal(core.firstContentLine("가".repeat(30), 10), `${"가".repeat(10)}…`);
  assert.equal(core.firstContentLine("\n\n", 10), "");
});

test("저장 순서는 stable ID만 병합하고 새 프로필은 원본 순서로 뒤에 붙인다", () => {
  assert.deepEqual(
    core.mergeProfileOrder(["p1", "p2", "p3", "p4"], ["deleted", "p3", "p1", "p3"]),
    ["p3", "p1", "p2", "p4"]
  );
});

test("드래그 이동은 대상 앞뒤에 stable ID를 배치한다", () => {
  assert.deepEqual(core.moveProfile(["p1", "p2", "p3"], "p1", "p3", false), ["p2", "p1", "p3"]);
  assert.deepEqual(core.moveProfile(["p1", "p2", "p3"], "p1", "p3", true), ["p2", "p3", "p1"]);
  assert.deepEqual(core.moveProfile(["p1", "p2"], "missing", "p2", true), ["p1", "p2"]);
});

test("100개 프로필과 10,000개 채팅도 한 번의 선형 인덱싱으로 처리한다", () => {
  const chats = Array.from({ length: 10_000 }, (_, index) => ({
    _id: `chat-${index}`,
    title: `채팅 ${index % 50}`,
    profileId: `profile-${index % 100}`
  }));
  const startedAt = performance.now();
  const index = core.buildProfileIndex(chats);
  const elapsed = performance.now() - startedAt;
  assert.equal(index.size, 100);
  assert.equal(index.get("profile-42").length, 100);
  assert.ok(elapsed < 1_000, `인덱싱이 너무 느립니다: ${elapsed.toFixed(1)}ms`);
});

test("마지막 메시지가 객체여도 실제 텍스트 필드를 찾아 첫 줄을 표시한다", () => {
  assert.equal(core.firstContentLine({ content: "  객체 메시지\n둘째 줄" }, 30), "객체 메시지");
  assert.equal(core.firstContentLine({ message: { text: "중첩 메시지" } }, 30), "중첩 메시지");
  assert.equal(core.firstContentLine({ parts: [{ text: "파트 메시지" }] }, 30), "파트 메시지");
  assert.equal(core.firstContentLine({ unknown: "내부 메타데이터" }, 30), "");
});

test("채팅 시간은 로컬 날짜 기준으로 오늘/어제/이전 날짜를 표시한다", () => {
  const now = new Date(2026, 8, 3, 18, 30, 0);
  assert.equal(core.formatChatTime(new Date(2026, 8, 3, 18, 12, 0), now), "오늘 18:12");
  assert.equal(core.formatChatTime(new Date(2026, 8, 2, 23, 41, 0), now), "어제 23:41");
  assert.equal(core.formatChatTime(new Date(2026, 7, 29, 1, 4, 0), now), "8월 29일 01:04");
  assert.equal(core.formatChatTime(new Date(2025, 11, 31, 22, 10, 0), now), "2025. 12. 31. 22:10");
  assert.equal(core.formatChatTime("not-a-date", now), "");
});

test("상세 조회 실패로 stale 표시된 채팅은 캐시에 남기지 않아 다음 로드에서 재시도할 수 있다", () => {
  const cache = core.makeChatCache([
    { _id: "ok", updatedAt: "1", profileId: "p1", stale: false },
    { _id: "failed", updatedAt: "2", profileId: "p2", stale: true }
  ]);
  assert.ok(cache.ok);
  assert.equal(cache.failed, undefined);
});
