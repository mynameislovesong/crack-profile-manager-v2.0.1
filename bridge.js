(() => {
  "use strict";

  if (window.__crackProfileChatBridgeInstalled) return;
  window.__crackProfileChatBridgeInstalled = true;

  const SOURCE_CONTENT = "crack-profile-chat-content-v1";
  const SOURCE_BRIDGE = "crack-profile-chat-bridge-v1";
  const API_CHANGE_PATTERN = /\/(?:crack-gen\/)?v3\/chats(?:\/|\?|$)|\/profiles\/[^/]+\/chat-profiles(?:\/|\?|$)/;
  const core = window.CrackProfileChatCore;

  let apiClients = null;
  let confirmService = null;
  let lastChatsById = new Map();
  let activeLoad = null;
  let routerBound = false;

  function post(type, payload = {}) {
    window.postMessage({ source: SOURCE_BRIDGE, type, ...payload }, "*");
  }

  function unwrap(response) {
    let value = response?.data ?? response;
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "data")) {
      value = value.data;
    }
    return value;
  }

  function captureWebpackRequire() {
    const chunks = window.webpackChunk_N_E;
    if (!Array.isArray(chunks)) return null;
    let webpackRequire = null;
    const chunkId = `cpci_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    chunks.push([[chunkId], {}, (requireFunction) => { webpackRequire = requireFunction; }]);
    return webpackRequire;
  }

  function findApiClients() {
    if (apiClients?.character?.get && apiClients?.characterChat?.get) return apiClients;
    const webpackRequire = captureWebpackRequire();
    if (!webpackRequire?.m) return null;

    for (const [moduleId, factory] of Object.entries(webpackRequire.m)) {
      let source = "";
      try { source = Function.prototype.toString.call(factory); } catch { continue; }
      if (!source.includes("characterChat") || !source.includes("x-wrtn-id")) continue;
      try {
        const exports = webpackRequire(moduleId);
        const candidates = [exports, ...Object.values(exports || {})];
        for (const candidate of candidates) {
          if (candidate?.character?.get && candidate?.characterChat?.get) {
            apiClients = candidate;
            return apiClients;
          }
        }
      } catch {
        // A matching factory can still be unavailable until its dependencies load.
      }
    }
    return null;
  }

  function findConfirmService() {
    if (typeof confirmService?.call === "function") return confirmService;
    const webpackRequire = captureWebpackRequire();
    if (!webpackRequire?.m) return null;
    for (const [moduleId, factory] of Object.entries(webpackRequire.m)) {
      let source = "";
      try { source = Function.prototype.toString.call(factory); } catch { continue; }
      if (!source.includes("disableOutsideClose") || !source.includes("footerBottomSlot")) continue;
      try {
        const exports = webpackRequire(moduleId);
        const candidate = Object.values(exports || {}).find((value) => typeof value?.call === "function");
        if (candidate) {
          confirmService = candidate;
          return confirmService;
        }
      } catch {
        // The dialog module can be retried after the page finishes loading.
      }
    }
    return null;
  }

  async function waitForApiClients(timeoutMs = 15_000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const clients = findApiClients();
      if (clients) return clients;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("크랙 API 클라이언트를 찾지 못했습니다.");
  }

  async function loadAllChatSummaries(client) {
    const chats = [];
    const seenCursors = new Set();
    let cursor;

    for (let page = 0; page < 100; page += 1) {
      const params = { limit: 40 };
      if (cursor) params.cursor = cursor;
      const data = unwrap(await client.get("/v3/chats", { params })) || {};
      chats.push(...(Array.isArray(data.chats) ? data.chats : []));
      const nextCursor = data.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return chats;
  }

  function sanitizeProfile(profile) {
    return {
      _id: typeof profile?._id === "string" ? profile._id : "",
      name: typeof profile?.name === "string" ? profile.name : "",
      information: typeof profile?.information === "string" ? profile.information : "",
      isRepresentative: Boolean(profile?.isRepresentative)
    };
  }

  function sanitizeChat(summary, detail, profileId, stale) {
    return {
      _id: String(summary?._id || detail?._id || ""),
      title: String(summary?.title || detail?.title || summary?.story?.name || summary?.character?.name || "제목 없는 채팅"),
      updatedAt: String(summary?.updatedAt || detail?.updatedAt || ""),
      profileId: typeof profileId === "string" && profileId ? profileId : null,
      storyId: summary?.story?._id || detail?.story?._id || null,
      characterId: summary?.character?._id || detail?.character?._id || null,
      lastMessage: core.firstContentLine(summary?.lastMessage || detail?.lastMessage || "", 96),
      stale: Boolean(stale)
    };
  }

  async function mapChatProfiles(client, summaries, cache, forceChatIds, requestId) {
    const plan = core.planChatDetails(summaries, cache, forceChatIds);
    const mapped = new Array(summaries.length);
    const pendingById = new Map(plan.pending.map((chat) => [chat._id, chat]));
    const failedChatIds = [];
    let completed = summaries.length - plan.pending.length;
    let position = 0;

    post("CPCI_PROGRESS", { requestId, completed, total: summaries.length });

    async function worker() {
      while (position < summaries.length) {
        const index = position;
        position += 1;
        const summary = summaries[index];
        const chatId = summary?._id;
        if (!chatId) continue;

        if (!pendingById.has(chatId)) {
          mapped[index] = sanitizeChat(summary, null, plan.reused.get(chatId), false);
          continue;
        }

        try {
          let detail = null;
          let lastError = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              detail = unwrap(await client.get(`/v3/chats/${encodeURIComponent(chatId)}`)) || {};
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              const status = Number(error?.response?.status || error?.status || 0);
              const retryable = !status || status === 429 || status >= 500;
              if (!retryable || attempt === 2) break;
              await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            }
          }
          if (lastError) throw lastError;
          mapped[index] = sanitizeChat(summary, detail, detail?.chatProfile?._id || null, false);
        } catch {
          const saved = cache?.[chatId];
          // Keep a known previous mapping visible, but mark failures stale so they are not
          // considered fresh cache entries on the next load and can be retried.
          mapped[index] = sanitizeChat(summary, null, saved?.chatProfileId || null, true);
          failedChatIds.push(chatId);
        } finally {
          completed += 1;
          if (completed === summaries.length || completed % 8 === 0) {
            post("CPCI_PROGRESS", { requestId, completed, total: summaries.length });
          }
        }
      }
    }

    const workerCount = Math.min(5, Math.max(1, plan.pending.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { chats: mapped.filter(Boolean), failedChatIds };
  }

  async function loadData(cache, forceChatIds, requestId) {
    const clients = await waitForApiClients();
    const myProfile = unwrap(await clients.character.get("/profiles")) || {};
    if (!myProfile._id) throw new Error("로그인 프로필 ID를 확인하지 못했습니다.");

    const [profileData, summaries] = await Promise.all([
      clients.character.get(`/profiles/${encodeURIComponent(myProfile._id)}/chat-profiles`).then(unwrap),
      loadAllChatSummaries(clients.characterChat)
    ]);
    const profiles = (profileData?.chatProfiles || []).map(sanitizeProfile).filter((item) => item._id);
    const mapped = await mapChatProfiles(
      clients.characterChat,
      summaries,
      cache && typeof cache === "object" ? cache : {},
      Array.isArray(forceChatIds) ? forceChatIds : [],
      requestId
    );

    lastChatsById = new Map(mapped.chats.map((chat) => [chat._id, chat]));
    return {
      ownerProfileId: myProfile._id,
      profiles,
      chats: mapped.chats,
      failedChatIds: mapped.failedChatIds,
      cache: core.makeChatCache(mapped.chats)
    };
  }

  async function respondWithData(message) {
    const requestId = message.requestId;
    try {
      if (!activeLoad) {
        activeLoad = loadData(message.cache, message.forceChatIds, requestId)
          .finally(() => { activeLoad = null; });
      }
      const data = await activeLoad;
      post("CPCI_DATA", { requestId, data });
    } catch (error) {
      post("CPCI_ERROR", { requestId, error: error?.message || "연결 정보를 불러오지 못했습니다." });
    }
  }

  async function navigateToChat(chatId, requestId) {
    const chat = lastChatsById.get(chatId);
    const route = core.routeForChat(chat);
    const router = window.next?.router;
    if (!route || typeof router?.push !== "function") {
      post("CPCI_NAVIGATION_ERROR", { requestId, chatId });
      return;
    }
    try {
      await router.push(route);
      post("CPCI_NAVIGATED", { requestId, chatId });
    } catch {
      post("CPCI_NAVIGATION_ERROR", { requestId, chatId });
    }
  }

  async function confirmBatchDelete(message) {
    const requestId = message.requestId;
    try {
      const service = findConfirmService();
      if (!service) throw new Error("크랙 확인창을 찾지 못했습니다.");
      const count = Array.isArray(message.profileIds) ? message.profileIds.length : 0;
      const connected = Array.isArray(message.connectedProfiles) ? message.connectedProfiles : [];
      const lines = [];
      if (connected.length) {
        lines.push(`이 중 현재 채팅에 연결된 프로필이 ${connected.length}개 있습니다.`, "");
        const visible = connected.slice(0, 8);
        for (const item of visible) {
          lines.push(`${String(item.name || "이름 없는 프로필")} · 연결된 채팅 ${Number(item.chatCount) || 0}개`);
        }
        if (connected.length > visible.length) lines.push(`외 ${connected.length - visible.length}개`);
      } else {
        lines.push("삭제한 프로필은 복구할 수 없어요.");
      }
      const confirmed = await service.call({
        title: `프로필 ${count}개를 삭제할까요?`,
        message: lines.join("\n"),
        okText: `${count}개 삭제`,
        cancelText: "취소"
      });
      post("CPCI_DELETE_CONFIRM_RESULT", { requestId, confirmed: Boolean(confirmed) });
    } catch (error) {
      post("CPCI_DELETE_ERROR", {
        requestId,
        deletedProfileIds: [],
        error: error?.message || "삭제 확인창을 열지 못했습니다."
      });
    }
  }

  async function deleteProfiles(message) {
    const requestId = message.requestId;
    const requestedIds = Array.isArray(message.profileIds)
      ? [...new Set(message.profileIds.filter((id) => typeof id === "string" && id))]
      : [];
    const deletedProfileIds = [];
    try {
      const clients = await waitForApiClients();
      const myProfile = unwrap(await clients.character.get("/profiles")) || {};
      if (!myProfile._id || myProfile._id !== message.ownerProfileId) {
        throw new Error("현재 로그인 프로필이 변경되어 삭제를 중단했습니다.");
      }
      const profileData = unwrap(await clients.character.get(
        `/profiles/${encodeURIComponent(myProfile._id)}/chat-profiles`
      )) || {};
      const allowedIds = new Set((profileData.chatProfiles || []).map((profile) => profile?._id).filter(Boolean));
      if (requestedIds.some((id) => !allowedIds.has(id))) {
        throw new Error("프로필 목록이 변경되어 삭제를 중단했습니다. 다시 선택해 주세요.");
      }

      for (const chatProfileId of requestedIds) {
        await clients.character.delete(
          `/profiles/${encodeURIComponent(myProfile._id)}/chat-profiles/${encodeURIComponent(chatProfileId)}`
        );
        deletedProfileIds.push(chatProfileId);
        post("CPCI_DELETE_PROGRESS", {
          requestId,
          completed: deletedProfileIds.length,
          total: requestedIds.length
        });
      }
      post("CPCI_DELETE_COMPLETE", { requestId, deletedProfileIds });
    } catch (error) {
      post("CPCI_DELETE_ERROR", {
        requestId,
        deletedProfileIds,
        error: error?.message || "프로필을 삭제하지 못했습니다."
      });
    }
  }

  function normalizeRequestUrl(input) {
    try {
      if (typeof input === "string") return new URL(input, location.href).href;
      if (input instanceof Request) return input.url;
      return String(input?.url || "");
    } catch {
      return String(input || "");
    }
  }

  function reportApiChange(method, url) {
    const normalizedMethod = String(method || "GET").toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod) || !API_CHANGE_PATTERN.test(url)) return;
    post("CPCI_API_CHANGED", {
      method: normalizedMethod,
      url,
      chatId: core.extractChangedChatId(url),
      resetIndexCache: normalizedMethod === "DELETE" && /\/profiles\/[^/]+\/chat-profiles(?:\/|\?|$)/.test(url)
    });
  }

  function instrumentRequests() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function cpciFetch(input, init) {
        const method = init?.method || (input instanceof Request ? input.method : "GET");
        const url = normalizeRequestUrl(input);
        return originalFetch.apply(this, arguments).then((response) => {
          if (response.ok) reportApiChange(method, url);
          return response;
        });
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function cpciOpen(method, url) {
      this.__cpciRequest = { method, url: normalizeRequestUrl(url) };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function cpciSend() {
      const request = this.__cpciRequest;
      if (request) {
        this.addEventListener("loadend", () => {
          if (this.status >= 200 && this.status < 400) reportApiChange(request.method, request.url);
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }

  function bindRouter() {
    if (routerBound) return true;
    const events = window.next?.router?.events;
    if (typeof events?.on !== "function") return false;
    events.on("routeChangeComplete", (url) => post("CPCI_ROUTE_CHANGED", { url }));
    routerBound = true;
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE_CONTENT) return;
    if (event.data.type === "CPCI_REQUEST_DATA") respondWithData(event.data);
    if (event.data.type === "CPCI_NAVIGATE") navigateToChat(event.data.chatId, event.data.requestId);
    if (event.data.type === "CPCI_CONFIRM_DELETE") confirmBatchDelete(event.data);
    if (event.data.type === "CPCI_DELETE_PROFILES") deleteProfiles(event.data);
    if (event.data.type === "CPCI_RELOAD_PROFILE_PAGE") window.location.reload();
  });

  instrumentRequests();
  if (!bindRouter()) {
    const routerTimer = setInterval(() => {
      if (bindRouter()) clearInterval(routerTimer);
    }, 250);
    setTimeout(() => clearInterval(routerTimer), 30_000);
  }
})();
