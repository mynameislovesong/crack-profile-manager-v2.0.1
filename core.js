(function initCrackProfileChatCore(root, factory) {
  const api = factory();
  root.CrackProfileChatCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this, function createCrackProfileChatCore() {
  "use strict";

  function asId(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  function buildProfileIndex(chats) {
    const index = new Map();
    for (const chat of Array.isArray(chats) ? chats : []) {
      const profileId = asId(chat?.profileId);
      if (!profileId) continue;
      const bucket = index.get(profileId);
      if (bucket) bucket.push(chat);
      else index.set(profileId, [chat]);
    }
    return index;
  }

  function planChatDetails(chats, cache, forceChatIds) {
    const sourceCache = cache && typeof cache === "object" ? cache : {};
    const forced = forceChatIds instanceof Set ? forceChatIds : new Set(forceChatIds || []);
    const reused = new Map();
    const pending = [];

    for (const chat of Array.isArray(chats) ? chats : []) {
      const chatId = asId(chat?._id);
      if (!chatId) continue;
      const saved = sourceCache[chatId];
      const cacheHasProfile = saved && Object.prototype.hasOwnProperty.call(saved, "chatProfileId");
      if (!forced.has(chatId) && cacheHasProfile && saved.updatedAt === (chat.updatedAt || "")) {
        reused.set(chatId, saved.chatProfileId || null);
      } else {
        pending.push(chat);
      }
    }

    return { reused, pending };
  }

  function makeChatCache(chats) {
    const cache = {};
    for (const chat of Array.isArray(chats) ? chats : []) {
      const chatId = asId(chat?._id);
      if (!chatId || chat?.stale) continue;
      cache[chatId] = {
        updatedAt: chat.updatedAt || "",
        chatProfileId: asId(chat.profileId)
      };
    }
    return cache;
  }

  function routeForChat(chat) {
    const chatId = asId(chat?._id);
    if (!chatId) return null;
    const storyId = asId(chat?.storyId);
    if (storyId) return `/stories/${encodeURIComponent(storyId)}/episodes/${encodeURIComponent(chatId)}`;
    const characterId = asId(chat?.characterId);
    if (characterId) {
      return `/characters/${encodeURIComponent(characterId)}/chats/${encodeURIComponent(chatId)}?autoScroll=false`;
    }
    return null;
  }

  function extractChangedChatId(url) {
    const match = String(url || "").match(/\/v3\/chats\/([a-z0-9_-]+)(?:\?|$)/i);
    if (!match || ["delete", "default-chat-setting"].includes(match[1])) return null;
    return match[1];
  }

  function notePreview(value, limit) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 42;
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max).trimEnd()}…`;
  }

  function normalizeSearchText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function tagKey(value) {
    return normalizeSearchText(value);
  }

  function normalizeTagList(values) {
    const result = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
      const label = String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
      const key = tagKey(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(label);
    }
    return result;
  }

  function matchesProfileFilters(profile, settings, searchQuery, selectedTags) {
    const query = normalizeSearchText(searchQuery);
    if (query) {
      const haystack = normalizeSearchText([
        profile?.name || "",
        profile?.information || "",
        settings?.text || ""
      ].join(" "));
      if (!haystack.includes(query)) return false;
    }

    const required = normalizeTagList(selectedTags).map(tagKey);
    if (!required.length) return true;
    const owned = new Set(normalizeTagList(settings?.tags).map(tagKey));
    return required.every((key) => owned.has(key));
  }

  function messageText(value, depth = 0) {
    if (value == null || depth > 4) return "";
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = messageText(item, depth + 1);
        if (text.trim()) return text;
      }
      return "";
    }
    if (typeof value !== "object") return "";

    // Crack chat payloads can expose the preview as a string or as a small message object.
    // Only inspect text-bearing fields; never stringify the whole object into "[object Object]".
    for (const key of ["content", "text", "message", "body", "value"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const text = messageText(value[key], depth + 1);
      if (text.trim()) return text;
    }
    for (const key of ["parts", "contents", "segments"]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const text = messageText(value[key], depth + 1);
      if (text.trim()) return text;
    }
    return "";
  }

  function firstContentLine(value, limit) {
    const line = messageText(value)
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean) || "";
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 72;
    if (line.length <= max) return line;
    return `${line.slice(0, max).trimEnd()}…`;
  }

  function parseDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number" && Number.isFinite(value)) {
      const milliseconds = Math.abs(value) < 1e12 ? value * 1000 : value;
      const date = new Date(milliseconds);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d{10,13}$/.test(raw)) {
      const number = Number(raw);
      if (Number.isFinite(number)) {
        const milliseconds = raw.length <= 10 ? number * 1000 : number;
        const date = new Date(milliseconds);
        if (!Number.isNaN(date.getTime())) return date;
      }
    }
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatChatTime(value, nowValue) {
    const date = parseDate(value);
    if (!date) return "";
    const now = parseDate(nowValue) || new Date();
    const pad = (number) => String(number).padStart(2, "0");
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDiff = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000);

    if (dayDiff === 0) return `오늘 ${time}`;
    if (dayDiff === 1) return `어제 ${time}`;
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
    }
    return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}. ${time}`;
  }

  function mergeProfileOrder(profileIds, savedOrder) {
    const source = Array.isArray(profileIds) ? profileIds.filter(asId) : [];
    const valid = new Set(source);
    const result = [];
    const seen = new Set();
    for (const id of Array.isArray(savedOrder) ? savedOrder : []) {
      if (valid.has(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
    for (const id of source) {
      if (!seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
    return result;
  }

  function moveProfile(order, activeId, overId, placeAfter) {
    const source = Array.isArray(order) ? [...order] : [];
    const from = source.indexOf(activeId);
    const over = source.indexOf(overId);
    if (from < 0 || over < 0 || activeId === overId) return source;
    source.splice(from, 1);
    const target = source.indexOf(overId);
    source.splice(target + (placeAfter ? 1 : 0), 0, activeId);
    return source;
  }

  function isProfilePage(url) {
    try {
      const parsed = new URL(url, "https://crack.wrtn.ai");
      return parsed.pathname === "/setting/chat" && parsed.searchParams.get("menu") === "chat_profile";
    } catch {
      return false;
    }
  }

  return {
    buildProfileIndex,
    extractChangedChatId,
    firstContentLine,
    formatChatTime,
    isProfilePage,
    makeChatCache,
    matchesProfileFilters,
    mergeProfileOrder,
    moveProfile,
    normalizeSearchText,
    normalizeTagList,
    notePreview,
    planChatDetails,
    routeForChat,
    tagKey
  };
});
