(() => {
  "use strict";

  if (window.__crackProfileChatContentInstalled) return;
  window.__crackProfileChatContentInstalled = true;

  const SOURCE_CONTENT = "crack-profile-chat-content-v1";
  const SOURCE_BRIDGE = "crack-profile-chat-bridge-v1";
  const NOTES_KEY = "crackProfileConnectionNotesV1";
  const INDEX_CACHE_KEY = "crackProfileConnectionIndexV1";
  const ORDER_KEY = "crackProfileOrderV2";
  const TAGS_KEY = "crackProfileTagsV1";
  const DEFAULT_TAGS = ["남", "여", "인외"];
  const LEGACY_DEFAULT_TAGS = ["남", "여", "인외", "기타"];
  const OWNED_SELECTOR = "[data-cpci-owned]";
  const CARD_SELECTOR = "div.bg-surface_tertiary.rounded-lg.p-4";
  const core = window.CrackProfileChatCore;

  const MEMO_COLORS = [
    { key: "default", label: "기본", value: "" },
    { key: "red", label: "빨강", value: "var(--accent_text_red_secondary, var(--text_brand, #ff4432))" },
    { key: "orange", label: "주황", value: "var(--text_cracker_primary, #d68b00)" },
    { key: "yellow", label: "노랑", value: "var(--accent_text_yellow_secondary, #ba9d05)" },
    { key: "green", label: "초록", value: "var(--accent_text_green_secondary, #0a811e)" },
    { key: "blue", label: "파랑", value: "var(--accent_text_blue_secondary, #3f8ebb)" },
    { key: "violet", label: "보라", value: "var(--accent_text_violet_secondary, #636dbd)" }
  ];
  const CARD_COLORS = [
    { key: "default", label: "기본" },
    { key: "pink", label: "연한 분홍" },
    { key: "orange", label: "연한 주황" },
    { key: "yellow", label: "연한 노랑" },
    { key: "green", label: "연한 초록" },
    { key: "blue", label: "연한 파랑" },
    { key: "violet", label: "연한 보라" }
  ];
  const MEMO_COLOR_KEYS = new Set(MEMO_COLORS.map((item) => item.key));
  const CARD_COLOR_KEYS = new Set(CARD_COLORS.map((item) => item.key));

  let notes = {};
  let indexCache = {};
  let orderStore = {};
  let globalTags = [...DEFAULT_TAGS];
  let ownerProfileId = "";
  let profiles = [];
  let chats = [];
  let profileIndex = new Map();
  let orderedIds = [];
  let failedChatIds = [];
  let lastLoadedAt = 0;
  let activeRequestId = null;
  let renderTimer = null;
  let refreshTimer = null;
  let lastUrl = location.href;
  let settingsWriteQueue = Promise.resolve();
  let orderWriteQueue = Promise.resolve();
  let tagWriteQueue = Promise.resolve();
  let editMode = false;
  let deleting = false;
  let pendingDelete = null;
  let menuProfileId = "";
  let openPalette = null;
  let activeDragId = "";
  let statusOverride = null;
  let searchQuery = "";
  let searchTimer = null;
  const selectedIds = new Set();
  const selectedTagKeys = new Set();
  const noteTimers = new Map();

  const storageReady = chrome.storage.local.get([NOTES_KEY, INDEX_CACHE_KEY, ORDER_KEY, TAGS_KEY]).then(async (stored) => {
    notes = stored[NOTES_KEY] && typeof stored[NOTES_KEY] === "object" ? stored[NOTES_KEY] : {};
    indexCache = stored[INDEX_CACHE_KEY] && typeof stored[INDEX_CACHE_KEY] === "object"
      ? stored[INDEX_CACHE_KEY]
      : {};
    orderStore = stored[ORDER_KEY] && typeof stored[ORDER_KEY] === "object" ? stored[ORDER_KEY] : {};
    if (Array.isArray(stored[TAGS_KEY])) {
      globalTags = core.normalizeTagList(stored[TAGS_KEY]);

      // 2.1.0의 기본 태그였던 "기타"는 2.1.1부터 기본값에서 제외한다.
      // 사용자가 실제로 "기타"를 프로필에 지정했다면 사용자 태그로 간주해 보존한다.
      const legacyKeys = new Set(LEGACY_DEFAULT_TAGS.map(core.tagKey));
      const storedKeys = new Set(globalTags.map(core.tagKey));
      const miscKey = core.tagKey("기타");
      const hasLegacyDefaults = [...legacyKeys].every((key) => storedKeys.has(key));
      const miscIsAssigned = Object.values(notes).some((settings) => {
        const value = typeof settings === "string" ? {} : settings;
        return core.normalizeTagList(value?.tags).some((tag) => core.tagKey(tag) === miscKey);
      });

      if (hasLegacyDefaults && !miscIsAssigned) {
        globalTags = globalTags.filter((tag) => core.tagKey(tag) !== miscKey);
        await chrome.storage.local.set({ [TAGS_KEY]: globalTags });
      }
    } else {
      globalTags = [...DEFAULT_TAGS];
      await chrome.storage.local.set({ [TAGS_KEY]: globalTags });
    }
  });

  function post(type, payload = {}) {
    window.postMessage({ source: SOURCE_CONTENT, type, ...payload }, "*");
  }

  function isOnProfilePage() {
    return core.isProfilePage(location.href);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function normalizedSettings(profileId) {
    const value = notes[profileId];
    if (typeof value === "string") return { text: value };
    return value && typeof value === "object" ? value : {};
  }

  function memoColorFor(profileId) {
    const key = normalizedSettings(profileId).memoColor;
    return MEMO_COLOR_KEYS.has(key) ? key : "default";
  }

  function cardColorFor(profileId) {
    const key = normalizedSettings(profileId).cardColor;
    return CARD_COLOR_KEYS.has(key) ? key : "default";
  }

  function canonicalTagLabel(value) {
    const key = core.tagKey(value);
    if (!key) return "";
    return globalTags.find((tag) => core.tagKey(tag) === key) || "";
  }

  function profileTags(profileId) {
    return core.normalizeTagList(normalizedSettings(profileId).tags)
      .map(canonicalTagLabel)
      .filter(Boolean);
  }

  function cleanSettings(value) {
    const next = { ...value };
    if (!String(next.text || "").trim()) {
      delete next.text;
      delete next.updatedAt;
    }
    if (!MEMO_COLOR_KEYS.has(next.memoColor) || next.memoColor === "default") delete next.memoColor;
    if (!CARD_COLOR_KEYS.has(next.cardColor) || next.cardColor === "default") delete next.cardColor;
    const tags = core.normalizeTagList(next.tags).map(canonicalTagLabel).filter(Boolean);
    if (tags.length) next.tags = tags;
    else delete next.tags;
    return next;
  }

  function writeProfileSettings(profileId, updater) {
    settingsWriteQueue = settingsWriteQueue.then(async () => {
      const nextNotes = { ...notes };
      const current = normalizedSettings(profileId);
      const nextValue = cleanSettings(updater({ ...current }) || current);
      if (Object.keys(nextValue).length) nextNotes[profileId] = nextValue;
      else delete nextNotes[profileId];
      notes = nextNotes;
      refreshProfileVisuals(profileId);
      await chrome.storage.local.set({ [NOTES_KEY]: nextNotes });
    });
    return settingsWriteQueue;
  }

  function scheduleRender(delay = 80) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, delay);
  }

  function scheduleRefresh(reason, delay = 200, forceChatIds = []) {
    if (!isOnProfilePage()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => requestData(reason, forceChatIds), delay);
  }

  async function requestData(reason, forceChatIds = []) {
    if (!isOnProfilePage()) return;
    await storageReady;
    const requestId = crypto.randomUUID();
    activeRequestId = requestId;
    updateGlobalStatus("연결 정보를 확인하는 중…", false);
    post("CPCI_REQUEST_DATA", { requestId, reason, cache: indexCache, forceChatIds });
  }

  function findCardsHost() {
    if (!isOnProfilePage()) return null;
    const main = document.querySelector("main");
    if (!main) return null;
    const directMatch = [...main.querySelectorAll("div.flex.flex-col.gap-4.pb-4")]
      .find((candidate) => [...candidate.children].some((child) => child.classList.contains("bg-surface_tertiary")));
    if (directMatch) return directMatch;
    const cards = [...main.querySelectorAll(CARD_SELECTOR)].filter((card) => !card.closest(OWNED_SELECTOR));
    if (!cards.length) return null;
    const parent = cards[0].parentElement;
    return cards.every((card) => card.parentElement === parent) ? parent : null;
  }

  function getCards(host) {
    return [...(host?.children || [])].filter((child) =>
      !child.matches(OWNED_SELECTOR) && child.classList.contains("bg-surface_tertiary")
    );
  }

  function cardForProfile(profileId) {
    return getCards(findCardsHost()).find((card) => card.dataset.cpciProfileId === profileId) || null;
  }

  function shieldCardClick(root) {
    for (const eventName of ["click", "dblclick", "mousedown", "pointerdown", "touchstart", "keydown"]) {
      root.addEventListener(eventName, (event) => event.stopPropagation());
    }
  }

  function visibleProfileIds() {
    const host = findCardsHost();
    if (!host) return [];
    const visible = new Set(
      getCards(host)
        .filter((card) => card.dataset.cpciFilteredOut !== "true")
        .map((card) => card.dataset.cpciProfileId)
        .filter(Boolean)
    );
    return orderedIds.filter((id) => visible.has(id));
  }

  function currentFilterTags() {
    return globalTags.filter((tag) => selectedTagKeys.has(core.tagKey(tag)));
  }

  function applyFilters() {
    const host = findCardsHost();
    if (!host) return;
    const byId = new Map(profiles.map((profile) => [profile._id, profile]));
    const requiredTags = currentFilterTags();
    const visible = new Set();

    for (const card of getCards(host)) {
      const profileId = card.dataset.cpciProfileId;
      const profile = byId.get(profileId);
      const matches = Boolean(profile) && core.matchesProfileFilters(
        profile,
        normalizedSettings(profileId),
        searchQuery,
        requiredTags
      );
      card.dataset.cpciFilteredOut = String(!matches);
      if (matches) visible.add(profileId);
    }

    if (editMode) {
      for (const id of [...selectedIds]) {
        if (!visible.has(id)) selectedIds.delete(id);
      }
    }
    updateFilterUi(visible.size);
    if (editMode) updateEditUi();
  }

  function updateFilterUi(visibleCount) {
    const bar = document.querySelector(".cpci-filter-tools");
    if (!bar) return;
    const input = bar.querySelector(".cpci-profile-search");
    if (input && document.activeElement !== input && input.value !== searchQuery) input.value = searchQuery;
    const count = bar.querySelector(".cpci-filter-count");
    const shown = Number.isInteger(visibleCount) ? visibleCount : visibleProfileIds().length;
    if (count) count.textContent = `${shown} / ${profiles.length}`;

    const row = bar.querySelector(".cpci-tag-filters");
    if (!row) return;
    const all = createElement("button", "cpci-filter-chip cpci-filter-all", "전체");
    all.type = "button";
    all.setAttribute("aria-pressed", String(selectedTagKeys.size === 0));
    all.addEventListener("click", () => {
      selectedTagKeys.clear();
      applyFilters();
    });
    row.replaceChildren(all);

    for (const tag of globalTags) {
      const key = core.tagKey(tag);
      const button = createElement("button", "cpci-filter-chip", tag);
      button.type = "button";
      button.dataset.tagKey = key;
      button.title = tag;
      button.setAttribute("aria-pressed", String(selectedTagKeys.has(key)));
      button.addEventListener("click", () => {
        if (selectedTagKeys.has(key)) selectedTagKeys.delete(key);
        else selectedTagKeys.add(key);
        applyFilters();
      });
      row.append(button);
    }
  }

  function ensureFilterBar() {
    const header = findHeaderContainer();
    if (!header) return null;
    let bar = header.querySelector(":scope > .cpci-filter-tools");
    if (bar) return bar;

    bar = createElement("section", "cpci-filter-tools");
    bar.dataset.cpciOwned = "true";
    const searchRow = createElement("div", "cpci-search-row");
    const input = createElement("input", "cpci-profile-search");
    input.type = "search";
    input.placeholder = "프로필 검색...";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "프로필 검색");
    input.value = searchQuery;
    const count = createElement("span", "cpci-filter-count", `0 / ${profiles.length}`);
    const manage = createElement("button", "cpci-tag-manage-button", "+");
    manage.type = "button";
    manage.title = "태그 추가/관리";
    manage.setAttribute("aria-label", "태그 추가 및 관리");
    manage.addEventListener("click", () => openTagManager(manage.getBoundingClientRect()));
    input.addEventListener("input", () => {
      searchQuery = input.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters, 120);
    });
    searchRow.append(input, count, manage);
    const filters = createElement("div", "cpci-tag-filters");
    filters.setAttribute("aria-label", "프로필 태그 필터");
    bar.append(searchRow, filters);

    const toolbar = header.querySelector(":scope > .cpci-edit-toolbar");
    if (toolbar) header.insertBefore(bar, toolbar);
    else header.append(bar);
    updateFilterUi(0);
    return bar;
  }

  function updateProfileTags(root, profileId) {
    const container = root?.querySelector(".cpci-profile-tags");
    if (!container) return;
    const tags = profileTags(profileId);
    container.replaceChildren();
    container.hidden = tags.length === 0;
    for (const tag of tags) {
      const chip = createElement("span", "cpci-profile-tag", tag);
      chip.title = tag;
      container.append(chip);
    }
  }

  function normalizeNewTag(value) {
    return core.normalizeTagList([value])[0] || "";
  }

  function addGlobalTag(value) {
    const label = normalizeNewTag(value);
    if (!label) return Promise.resolve({ ok: false, reason: "empty" });
    const key = core.tagKey(label);
    if (globalTags.some((tag) => core.tagKey(tag) === key)) {
      return Promise.resolve({ ok: false, reason: "duplicate" });
    }
    tagWriteQueue = tagWriteQueue.then(async () => {
      if (globalTags.some((tag) => core.tagKey(tag) === key)) return { ok: false, reason: "duplicate" };
      globalTags = [...globalTags, label];
      await chrome.storage.local.set({ [TAGS_KEY]: globalTags });
      updateFilterUi();
      return { ok: true, label };
    });
    return tagWriteQueue;
  }

  function deleteGlobalTag(label) {
    const key = core.tagKey(label);
    if (!key) return Promise.resolve();
    tagWriteQueue = tagWriteQueue.then(async () => {
      if (!globalTags.some((tag) => core.tagKey(tag) === key)) return;
      globalTags = globalTags.filter((tag) => core.tagKey(tag) !== key);
      selectedTagKeys.delete(key);

      const nextNotes = {};
      for (const [profileId, rawValue] of Object.entries(notes)) {
        const settings = typeof rawValue === "string" ? { text: rawValue } : { ...(rawValue || {}) };
        if (Array.isArray(settings.tags)) {
          settings.tags = settings.tags.filter((tag) => core.tagKey(tag) !== key);
        }
        const cleaned = cleanSettings(settings);
        if (Object.keys(cleaned).length) nextNotes[profileId] = cleaned;
      }
      notes = nextNotes;
      await chrome.storage.local.set({ [TAGS_KEY]: globalTags, [NOTES_KEY]: nextNotes });
      profiles.forEach((profile) => refreshProfileVisuals(profile._id, false));
      updateFilterUi();
      applyFilters();
    });
    return tagWriteQueue;
  }

  function positionFloatingPalette(palette, anchor) {
    document.body.append(palette);
    const rect = palette.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, anchor.right - rect.width));
    const below = anchor.bottom + 6;
    const top = below + rect.height <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - rect.height - 6);
    palette.style.left = `${left}px`;
    palette.style.top = `${top}px`;
    openPalette = palette;
  }

  function openTagManager(anchor) {
    closeCardPalette();
    const palette = createElement("div", "cpci-card-palette cpci-tag-manager");
    palette.dataset.cpciOwned = "true";
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-label", "태그 관리");
    palette.append(createElement("p", "cpci-palette-title", "태그 관리"));

    const form = createElement("form", "cpci-tag-add-form");
    const input = createElement("input", "cpci-tag-name-input");
    input.type = "text";
    input.maxLength = 32;
    input.placeholder = "새 태그 이름";
    input.setAttribute("aria-label", "새 태그 이름");
    const add = createElement("button", "cpci-tag-add-button", "추가");
    add.type = "submit";
    const status = createElement("p", "cpci-tag-manager-status", "");
    form.append(input, add);
    palette.append(form, status);

    const list = createElement("div", "cpci-tag-manager-list");
    const renderList = () => {
      list.replaceChildren();
      if (!globalTags.length) {
        list.append(createElement("p", "cpci-tag-empty", "등록된 태그가 없습니다."));
        return;
      }
      for (const tag of globalTags) {
        const row = createElement("div", "cpci-tag-manager-row");
        const label = createElement("span", "cpci-tag-manager-label", tag);
        label.title = tag;
        const remove = createElement("button", "cpci-tag-delete-button", "삭제");
        remove.type = "button";
        remove.setAttribute("aria-label", `${tag} 태그 삭제`);
        remove.addEventListener("click", async () => {
          if (!window.confirm(`“${tag}” 태그를 삭제할까요?\n이 태그는 모든 프로필에서 제거됩니다.`)) return;
          remove.disabled = true;
          try {
            await deleteGlobalTag(tag);
            renderList();
          } catch {
            status.textContent = "태그를 삭제하지 못했습니다.";
          }
        });
        row.append(label, remove);
        list.append(row);
      }
    };
    renderList();
    palette.append(list);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = input.value;
      add.disabled = true;
      status.textContent = "";
      try {
        const result = await addGlobalTag(value);
        if (!result.ok) {
          status.textContent = result.reason === "duplicate" ? "이미 같은 이름의 태그가 있습니다." : "태그 이름을 입력해 주세요.";
          return;
        }
        input.value = "";
        renderList();
      } catch {
        status.textContent = "태그를 저장하지 못했습니다.";
      } finally {
        add.disabled = false;
        input.focus({ preventScroll: true });
      }
    });

    positionFloatingPalette(palette, anchor);
    input.focus({ preventScroll: true });
  }

  function openTagPaletteFor(profileId, anchor) {
    closeCardPalette();
    const palette = createElement("div", "cpci-card-palette cpci-profile-tag-palette");
    palette.dataset.cpciOwned = "true";
    palette.dataset.profileId = profileId;
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-label", "태그 설정");
    palette.append(createElement("p", "cpci-palette-title", "태그 설정"));
    const list = createElement("div", "cpci-profile-tag-options");
    const selected = new Set(profileTags(profileId).map(core.tagKey));

    if (!globalTags.length) {
      list.append(createElement("p", "cpci-tag-empty", "등록된 태그가 없습니다. 상단 + 버튼에서 태그를 추가하세요."));
    } else {
      for (const tag of globalTags) {
        const key = core.tagKey(tag);
        const label = createElement("label", "cpci-profile-tag-option");
        const checkbox = createElement("input", "cpci-profile-tag-checkbox");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(key);
        const text = createElement("span", "cpci-profile-tag-option-label", tag);
        label.append(checkbox, text);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.add(key);
          else selected.delete(key);
          const nextTags = globalTags.filter((item) => selected.has(core.tagKey(item)));
          writeProfileSettings(profileId, (settings) => ({ ...settings, tags: nextTags }))
            .catch(() => updateGlobalStatus("태그 설정을 저장하지 못했습니다.", true));
        });
        list.append(label);
      }
    }
    palette.append(list);
    positionFloatingPalette(palette, anchor);
    palette.querySelector("input, button")?.focus({ preventScroll: true });
  }

  function createMemoColorPicker(profile, root) {
    const picker = createElement("div", "cpci-memo-colors");
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "메모 글씨 색상");
    picker.append(createElement("span", "cpci-color-caption", "글씨 색"));
    for (const option of MEMO_COLORS) {
      const button = createElement("button", `cpci-color-option cpci-memo-color-${option.key}`);
      button.type = "button";
      button.dataset.memoColor = option.key;
      button.title = option.label;
      button.setAttribute("aria-label", `메모 글씨 색상: ${option.label}`);
      button.setAttribute("aria-pressed", "false");
      if (option.key === "default") button.textContent = "기본";
      button.addEventListener("click", () => {
        writeProfileSettings(profile._id, (current) => ({ ...current, memoColor: option.key }))
          .catch(() => updateGlobalStatus("메모 색상을 저장하지 못했습니다.", true));
      });
      picker.append(button);
    }
    root.append(picker);
  }

  function createTools(profile) {
    const root = createElement("section", "cpci-profile-tools");
    root.dataset.cpciOwned = "true";
    root.dataset.cpciProfileId = profile._id;
    shieldCardClick(root);

    const tagList = createElement("div", "cpci-profile-tags");
    tagList.hidden = true;

    const chatToggle = createElement("button", "cpci-row cpci-chat-toggle");
    chatToggle.type = "button";
    chatToggle.setAttribute("aria-expanded", "false");
    const chatLabel = createElement("span", "cpci-row-label");
    const chevron = createElement("span", "cpci-chevron", "›");
    chevron.setAttribute("aria-hidden", "true");
    chatToggle.append(chatLabel, chevron);

    const chatPanel = createElement("div", "cpci-panel cpci-chat-panel");
    chatPanel.hidden = true;
    chatPanel.id = `cpci-chats-${profile._id}`;
    chatToggle.setAttribute("aria-controls", chatPanel.id);

    const noteToggle = createElement("button", "cpci-row cpci-note-toggle");
    noteToggle.type = "button";
    noteToggle.setAttribute("aria-expanded", "false");
    const noteLabel = createElement("span", "cpci-row-label cpci-note-label");
    const noteChevron = createElement("span", "cpci-chevron", "›");
    noteChevron.setAttribute("aria-hidden", "true");
    noteToggle.append(noteLabel, noteChevron);

    const notePanel = createElement("div", "cpci-panel cpci-note-panel");
    notePanel.hidden = true;
    notePanel.id = `cpci-note-${profile._id}`;
    noteToggle.setAttribute("aria-controls", notePanel.id);
    createMemoColorPicker(profile, notePanel);
    const textarea = createElement("textarea", "cpci-textarea");
    textarea.placeholder = "이 프로필에 대한 개인 메모";
    textarea.setAttribute("aria-label", `${profile.name || "프로필"} 개인 메모`);
    textarea.value = normalizedSettings(profile._id).text || "";
    const saveStatus = createElement("span", "cpci-save-status", "");
    saveStatus.setAttribute("aria-live", "polite");
    notePanel.append(textarea, saveStatus);

    chatToggle.addEventListener("click", () => {
      if (editMode) return;
      const willOpen = chatPanel.hidden;
      chatPanel.hidden = !willOpen;
      chatToggle.setAttribute("aria-expanded", String(willOpen));
      chevron.textContent = willOpen ? "⌄" : "›";
      if (willOpen) closeNotePanel(root);
    });

    noteToggle.addEventListener("click", () => {
      if (editMode) return;
      const willOpen = notePanel.hidden;
      notePanel.hidden = !willOpen;
      noteToggle.setAttribute("aria-expanded", String(willOpen));
      noteChevron.textContent = willOpen ? "⌄" : "›";
      if (willOpen) {
        closeChatPanel(root);
        textarea.focus({ preventScroll: true });
      } else {
        flushNote(profile._id, textarea, saveStatus, root);
      }
    });

    textarea.addEventListener("input", () => {
      saveStatus.textContent = "저장 중…";
      clearTimeout(noteTimers.get(profile._id));
      noteTimers.set(profile._id, setTimeout(() => flushNote(profile._id, textarea, saveStatus, root), 450));
    });
    textarea.addEventListener("blur", () => flushNote(profile._id, textarea, saveStatus, root));

    root.append(tagList, chatToggle, chatPanel, noteToggle, notePanel);
    return root;
  }

  function closeChatPanel(root) {
    const panel = root.querySelector(".cpci-chat-panel");
    const toggle = root.querySelector(".cpci-chat-toggle");
    if (!panel || !toggle) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    const chevron = toggle.querySelector(".cpci-chevron");
    if (chevron) chevron.textContent = "›";
  }

  function closeNotePanel(root) {
    const panel = root.querySelector(".cpci-note-panel");
    const toggle = root.querySelector(".cpci-note-toggle");
    const textarea = root.querySelector(".cpci-textarea");
    const status = root.querySelector(".cpci-save-status");
    if (!panel || !toggle) return;
    if (!panel.hidden && textarea && status) flushNote(root.dataset.cpciProfileId, textarea, status, root);
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    const chevron = toggle.querySelector(".cpci-chevron");
    if (chevron) chevron.textContent = "›";
  }

  function flushNote(profileId, textarea, status, root) {
    clearTimeout(noteTimers.get(profileId));
    noteTimers.delete(profileId);
    const text = String(textarea.value || "").trim();
    writeProfileSettings(profileId, (current) => {
      if (text) return { ...current, text, updatedAt: new Date().toISOString() };
      const next = { ...current };
      delete next.text;
      delete next.updatedAt;
      return next;
    }).then(() => {
      status.textContent = text ? "저장됨" : "메모 없음";
      updateNoteSummary(root, profileId);
    }).catch(() => {
      status.textContent = "저장하지 못했어요";
    });
  }

  function updateMemoColor(root, profileId) {
    const key = memoColorFor(profileId);
    const option = MEMO_COLORS.find((item) => item.key === key) || MEMO_COLORS[0];
    const preview = root?.querySelector(".cpci-note-preview");
    const textarea = root?.querySelector(".cpci-textarea");
    for (const element of [preview, textarea]) {
      if (!element) continue;
      if (option.value) element.style.color = option.value;
      else element.style.removeProperty("color");
    }
    root?.querySelectorAll("[data-memo-color]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.memoColor === key));
    });
  }

  function updateNoteSummary(root, profileId) {
    const label = root?.querySelector(".cpci-note-label");
    if (!label) return;
    const text = normalizedSettings(profileId).text || "";
    const previewText = core.notePreview(text, 42);
    label.replaceChildren();
    if (previewText) {
      label.append(
        createElement("span", "cpci-note-prefix", "메모 보기/수정 — "),
        createElement("span", "cpci-note-preview", previewText)
      );
      label.title = text;
    } else {
      label.textContent = "메모 추가";
      label.title = "";
    }
    updateMemoColor(root, profileId);
  }

  function updateChatPanel(root, profile) {
    const related = profileIndex.get(profile._id) || [];
    const toggle = root.querySelector(".cpci-chat-toggle");
    const label = root.querySelector(".cpci-chat-toggle .cpci-row-label");
    const chevron = root.querySelector(".cpci-chat-toggle .cpci-chevron");
    const panel = root.querySelector(".cpci-chat-panel");
    if (!toggle || !label || !panel) return;

    if (!related.length) {
      label.textContent = "연결된 채팅 없음";
      toggle.disabled = true;
      toggle.setAttribute("aria-expanded", "false");
      panel.hidden = true;
      chevron.hidden = true;
      panel.replaceChildren();
      return;
    }

    label.textContent = `연결된 채팅 ${related.length}개`;
    toggle.disabled = false;
    chevron.hidden = false;
    const signature = related
      .map((chat) => `${chat._id}\u0000${chat.title}\u0000${chat.updatedAt || ""}\u0000${chat.lastMessage || ""}`)
      .join("\u0001");
    if (panel.dataset.cpciSignature === signature) return;
    panel.dataset.cpciSignature = signature;

    const list = createElement("ul", "cpci-chat-list");
    for (const chat of related) {
      const item = createElement("li", "cpci-chat-item");
      const button = createElement("button", "cpci-chat-link");
      button.type = "button";
      button.dataset.chatId = chat._id;
      const title = chat.title || "제목 없는 채팅";
      const timeText = core.formatChatTime(chat.updatedAt);
      const heading = createElement("span", "cpci-chat-heading");
      heading.append(createElement("span", "cpci-chat-title", title));
      if (timeText) heading.append(createElement("span", "cpci-chat-time", timeText));
      button.append(heading);
      if (chat.lastMessage) {
        button.append(createElement("span", "cpci-chat-last-message", chat.lastMessage));
      }
      button.title = [title, timeText, chat.lastMessage].filter(Boolean).join("\n");
      button.disabled = !core.routeForChat(chat);
      button.addEventListener("click", () => {
        const requestId = crypto.randomUUID();
        button.dataset.navigating = "true";
        post("CPCI_NAVIGATE", { requestId, chatId: chat._id });
      });
      item.append(button);
      list.append(item);
    }
    panel.replaceChildren(list);
  }

  function updateTools(root, profile) {
    root.dataset.cpciProfileId = profile._id;
    updateProfileTags(root, profile._id);
    updateChatPanel(root, profile);
    updateNoteSummary(root, profile._id);
  }

  function applyCardColor(card, profileId) {
    const key = cardColorFor(profileId);
    if (key === "default") delete card.dataset.cpciCardColor;
    else card.dataset.cpciCardColor = key;
  }

  function refreshProfileVisuals(profileId, reapplyFilters = true) {
    const card = cardForProfile(profileId);
    if (!card) return;
    applyCardColor(card, profileId);
    const root = card.querySelector(":scope .cpci-profile-tools");
    if (root) {
      updateNoteSummary(root, profileId);
      updateProfileTags(root, profileId);
    }
    if (reapplyFilters) applyFilters();
  }

  function createEditControls(profile) {
    const controls = createElement("div", "cpci-card-edit-controls");
    controls.dataset.cpciOwned = "true";
    controls.dataset.cpciProfileId = profile._id;
    shieldCardClick(controls);
    const checkbox = createElement("input", "cpci-profile-checkbox");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `${profile.name || "프로필"} 선택`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(profile._id);
      else selectedIds.delete(profile._id);
      updateEditUi();
    });
    const handle = createElement("button", "cpci-drag-handle");
    handle.type = "button";
    handle.setAttribute("aria-label", `${profile.name || "프로필"} 순서 변경`);
    handle.title = "드래그하여 순서 변경";
    handle.innerHTML = "<span></span><span></span><span></span>";
    bindDragHandle(handle, profile._id);
    controls.append(checkbox, handle);
    return controls;
  }

  function ensureEditControls(card, profile) {
    let controls = card.querySelector(".cpci-card-edit-controls");
    if (controls && controls.dataset.cpciProfileId !== profile._id) {
      controls.remove();
      controls = null;
    }
    if (!controls) {
      controls = createEditControls(profile);
      const header = [...card.children].find((child) => !child.matches(OWNED_SELECTOR));
      const titleGroup = header?.firstElementChild;
      if (titleGroup instanceof HTMLElement) titleGroup.prepend(controls);
      else card.prepend(controls);
    }
    return controls;
  }

  function bindDragHandle(handle, profileId) {
    let drag = null;
    const finish = (persist) => {
      if (!drag) return;
      const card = cardForProfile(profileId);
      if (card) delete card.dataset.cpciDragging;
      document.querySelectorAll("[data-cpci-drop-target]").forEach((item) => delete item.dataset.cpciDropTarget);
      try { handle.releasePointerCapture(drag.pointerId); } catch { /* no capture */ }
      const moved = drag.moved;
      drag = null;
      activeDragId = "";
      if (persist && moved) persistOrder();
    };

    handle.addEventListener("pointerdown", (event) => {
      if (!editMode || deleting || (event.button !== 0 && event.pointerType !== "touch")) return;
      event.preventDefault();
      event.stopPropagation();
      drag = { pointerId: event.pointerId, moved: false };
      activeDragId = profileId;
      handle.setPointerCapture(event.pointerId);
      const card = cardForProfile(profileId);
      if (card) card.dataset.cpciDragging = "true";
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(CARD_SELECTOR);
      if (!target || target.parentElement !== findCardsHost()) return;
      const overId = target.dataset.cpciProfileId;
      if (!overId || overId === profileId) return;
      const rect = target.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const next = core.moveProfile(orderedIds, profileId, overId, after);
      if (next.join("\u0000") !== orderedIds.join("\u0000")) {
        orderedIds = next;
        drag.moved = true;
        applyOrder();
      }
      document.querySelectorAll("[data-cpci-drop-target]").forEach((item) => delete item.dataset.cpciDropTarget);
      target.dataset.cpciDropTarget = after ? "after" : "before";
      if (event.clientY < 72) window.scrollBy({ top: -12, behavior: "auto" });
      else if (event.clientY > window.innerHeight - 72) window.scrollBy({ top: 12, behavior: "auto" });
    });
    handle.addEventListener("pointerup", () => finish(true));
    handle.addEventListener("pointercancel", () => finish(false));
    handle.addEventListener("keydown", (event) => {
      if (!editMode || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const visibleOrder = visibleProfileIds();
      const index = visibleOrder.indexOf(profileId);
      const otherIndex = event.key === "ArrowUp" ? index - 1 : index + 1;
      if (index < 0 || otherIndex < 0 || otherIndex >= visibleOrder.length) return;
      orderedIds = core.moveProfile(orderedIds, profileId, visibleOrder[otherIndex], event.key === "ArrowDown");
      applyOrder();
      persistOrder();
      handle.focus();
    });
  }

  function applyOrder() {
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    for (const card of getCards(findCardsHost())) {
      const position = rank.get(card.dataset.cpciProfileId);
      card.style.order = Number.isInteger(position) ? String(position) : "";
    }
  }

  function persistOrder() {
    if (!ownerProfileId) return;
    const saved = [...orderedIds];
    orderStore = { ...orderStore, [ownerProfileId]: saved };
    orderWriteQueue = orderWriteQueue
      .then(() => chrome.storage.local.set({ [ORDER_KEY]: orderStore }))
      .catch(() => updateGlobalStatus("프로필 순서를 저장하지 못했습니다.", true));
  }

  function findHeaderContainer() {
    const main = document.querySelector("main");
    const title = [...(main?.querySelectorAll("span") || [])]
      .find((element) => element.textContent.trim() === "대화 프로필");
    return title?.closest("div.flex.flex-col.w-full.gap-2") || title?.parentElement || null;
  }

  function ensureToolbar() {
    const header = findHeaderContainer();
    if (!header) return null;
    let toolbar = header.querySelector(":scope > .cpci-edit-toolbar");
    if (toolbar) return toolbar;
    toolbar = createElement("div", "cpci-edit-toolbar");
    toolbar.dataset.cpciOwned = "true";
    const toggle = createElement("button", "cpci-toolbar-button cpci-edit-toggle", "편집");
    toggle.type = "button";
    toggle.addEventListener("click", () => setEditMode(!editMode));
    const actions = createElement("div", "cpci-edit-actions");
    const count = createElement("span", "cpci-selection-count", "선택 0개");
    const selectAll = createElement("button", "cpci-toolbar-button", "전체 선택");
    selectAll.type = "button";
    selectAll.dataset.action = "select-all";
    selectAll.addEventListener("click", () => {
      visibleProfileIds().forEach((id) => selectedIds.add(id));
      updateEditUi();
    });
    const clearAll = createElement("button", "cpci-toolbar-button", "전체 해제");
    clearAll.type = "button";
    clearAll.dataset.action = "clear-all";
    clearAll.addEventListener("click", () => {
      selectedIds.clear();
      updateEditUi();
    });
    const remove = createElement("button", "cpci-toolbar-button cpci-delete-selected", "선택 삭제");
    remove.type = "button";
    remove.addEventListener("click", requestBatchDelete);
    actions.append(count, selectAll, clearAll, remove);
    toolbar.append(toggle, actions);
    header.append(toolbar);
    return toolbar;
  }

  function setEditMode(value) {
    editMode = Boolean(value);
    if (!editMode) selectedIds.clear();
    closeCardPalette();
    document.querySelectorAll(".cpci-profile-tools").forEach((root) => {
      closeChatPanel(root);
      closeNotePanel(root);
    });
    updateEditUi();
  }

  function updateEditUi() {
    const toolbar = ensureToolbar();
    if (toolbar) {
      toolbar.dataset.editing = String(editMode);
      const toggle = toolbar.querySelector(".cpci-edit-toggle");
      const count = toolbar.querySelector(".cpci-selection-count");
      const remove = toolbar.querySelector(".cpci-delete-selected");
      const selectAll = toolbar.querySelector('[data-action="select-all"]');
      const clearAll = toolbar.querySelector('[data-action="clear-all"]');
      if (toggle) toggle.textContent = editMode ? "완료" : "편집";
      if (count) count.textContent = `선택 ${selectedIds.size}개`;
      if (remove) {
        remove.textContent = selectedIds.size ? `${selectedIds.size}개 삭제` : "선택 삭제";
        remove.disabled = !selectedIds.size || deleting;
      }
      const visibleIds = visibleProfileIds();
      const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
      if (selectAll) selectAll.disabled = deleting || visibleIds.length === 0 || selectedVisibleCount === visibleIds.length;
      if (clearAll) clearAll.disabled = deleting || selectedIds.size === 0;
      if (toggle) toggle.disabled = deleting;
    }
    for (const card of getCards(findCardsHost())) {
      card.dataset.cpciEditing = String(editMode);
      card.dataset.cpciSelected = String(selectedIds.has(card.dataset.cpciProfileId));
      const checkbox = card.querySelector(".cpci-profile-checkbox");
      if (checkbox) {
        checkbox.checked = selectedIds.has(card.dataset.cpciProfileId);
        checkbox.disabled = deleting;
      }
      const handle = card.querySelector(".cpci-drag-handle");
      if (handle) handle.disabled = deleting;
    }
  }

  function requestBatchDelete() {
    if (!editMode || deleting || !selectedIds.size || !ownerProfileId) return;
    const selectedProfiles = orderedIds
      .filter((id) => selectedIds.has(id))
      .map((id) => profiles.find((profile) => profile._id === id))
      .filter(Boolean);
    const connectedProfiles = selectedProfiles.flatMap((profile) => {
      const related = profileIndex.get(profile._id) || [];
      return related.length ? [{ name: profile.name, chatCount: related.length }] : [];
    });
    const requestId = crypto.randomUUID();
    pendingDelete = { requestId, profileIds: selectedProfiles.map((profile) => profile._id) };
    post("CPCI_CONFIRM_DELETE", {
      requestId,
      profileIds: pendingDelete.profileIds,
      connectedProfiles
    });
  }

  async function cleanupDeleted(profileIds) {
    const removed = new Set(profileIds);
    const nextNotes = { ...notes };
    profileIds.forEach((id) => delete nextNotes[id]);
    notes = nextNotes;
    orderedIds = orderedIds.filter((id) => !removed.has(id));
    orderStore = { ...orderStore, [ownerProfileId]: [...orderedIds] };
    await chrome.storage.local.set({ [NOTES_KEY]: nextNotes, [ORDER_KEY]: orderStore });
  }

  function updateGlobalStatus(message, error) {
    const host = findCardsHost();
    if (!host?.parentElement) return;
    let status = host.parentElement.querySelector(":scope > .cpci-global-status");
    if (!message) {
      status?.remove();
      return;
    }
    if (!status) {
      status = createElement("p", "cpci-global-status");
      status.dataset.cpciOwned = "true";
      host.before(status);
    }
    status.textContent = message;
    status.dataset.error = String(Boolean(error));
  }

  function renderStatus() {
    if (statusOverride) updateGlobalStatus(statusOverride.message, statusOverride.error);
    else if (failedChatIds.length) {
      updateGlobalStatus(`일부 채팅 ${failedChatIds.length}개의 연결 정보는 확인하지 못했습니다.`, true);
    } else updateGlobalStatus("", false);
  }

  function render() {
    if (!isOnProfilePage()) return;
    ensureFilterBar();
    ensureToolbar();
    const host = findCardsHost();
    const cards = getCards(host);
    if (!host || cards.length !== profiles.length) return;

    if (!activeDragId) {
      orderedIds = core.mergeProfileOrder(profiles.map((profile) => profile._id), orderStore[ownerProfileId]);
    }
    cards.forEach((card, index) => {
      const profile = profiles[index];
      card.dataset.cpciProfileId = profile._id;
      let tools = card.querySelector(":scope > .cpci-profile-tools");
      if (tools && tools.dataset.cpciProfileId !== profile._id) {
        tools.remove();
        tools = null;
      }
      if (!tools) {
        tools = createTools(profile);
        card.append(tools);
      }
      ensureEditControls(card, profile);
      updateTools(tools, profile);
      applyCardColor(card, profile._id);
    });
    applyOrder();
    applyFilters();
    updateEditUi();
    injectColorMenuItems();
    renderStatus();
  }

  function openCardPaletteFor(profileId, anchor) {
    closeCardPalette();
    const palette = createElement("div", "cpci-card-palette");
    palette.dataset.cpciOwned = "true";
    palette.dataset.profileId = profileId;
    palette.setAttribute("role", "dialog");
    palette.setAttribute("aria-label", "카드 색상 변경");
    palette.append(createElement("p", "cpci-palette-title", "카드 색상"));
    const options = createElement("div", "cpci-card-color-options");
    const current = cardColorFor(profileId);
    for (const option of CARD_COLORS) {
      const button = createElement("button", `cpci-card-color-option cpci-card-swatch-${option.key}`);
      button.type = "button";
      button.dataset.cardColor = option.key;
      button.setAttribute("aria-label", option.label);
      button.setAttribute("aria-pressed", String(current === option.key));
      const swatch = createElement("span", "cpci-card-color-swatch");
      const label = createElement("span", "cpci-card-color-label", option.label);
      button.append(swatch, label);
      button.addEventListener("click", () => {
        writeProfileSettings(profileId, (settings) => ({ ...settings, cardColor: option.key }))
          .catch(() => updateGlobalStatus("카드 색상을 저장하지 못했습니다.", true));
        closeCardPalette();
      });
      options.append(button);
    }
    palette.append(options);
    document.body.append(palette);
    const rect = palette.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, anchor.right - rect.width));
    const below = anchor.bottom + 6;
    const top = below + rect.height <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - rect.height - 6);
    palette.style.left = `${left}px`;
    palette.style.top = `${top}px`;
    openPalette = palette;
    palette.querySelector("button")?.focus({ preventScroll: true });
  }

  function closeCardPalette() {
    openPalette?.remove();
    openPalette = null;
  }

  function injectColorMenuItems() {
    if (!menuProfileId) return;
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const items = [...menu.querySelectorAll(':scope > [role="menuitem"]')];
      const deleteItem = items.find((item) => item.textContent.trim() === "삭제하기");
      if (!deleteItem) continue;

      let colorItem = menu.querySelector(".cpci-card-color-menu-item");
      if (!colorItem) {
        colorItem = createElement("div", `${deleteItem.className} cpci-card-color-menu-item`, "카드 색상 변경");
        colorItem.dataset.cpciOwned = "true";
        colorItem.setAttribute("role", "menuitem");
        colorItem.setAttribute("tabindex", "-1");
        const activateColor = (event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = colorItem.getBoundingClientRect();
          const profileId = menuProfileId;
          openCardPaletteFor(profileId, rect);
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        };
        colorItem.addEventListener("pointerdown", (event) => event.stopPropagation());
        colorItem.addEventListener("click", activateColor);
        colorItem.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) activateColor(event);
        });
        deleteItem.after(colorItem);
      }

      if (!menu.querySelector(".cpci-tag-menu-item")) {
        const tagItem = createElement("div", `${deleteItem.className} cpci-tag-menu-item`, "태그 설정");
        tagItem.dataset.cpciOwned = "true";
        tagItem.setAttribute("role", "menuitem");
        tagItem.setAttribute("tabindex", "-1");
        const activateTags = (event) => {
          event.preventDefault();
          event.stopPropagation();
          const rect = tagItem.getBoundingClientRect();
          const profileId = menuProfileId;
          openTagPaletteFor(profileId, rect);
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        };
        tagItem.addEventListener("pointerdown", (event) => event.stopPropagation());
        tagItem.addEventListener("click", activateTags);
        tagItem.addEventListener("keydown", (event) => {
          if (["Enter", " "].includes(event.key)) activateTags(event);
        });
        colorItem.after(tagItem);
      }
    }
  }

  function handleData(message) {
    if (activeRequestId && message.requestId !== activeRequestId) return;
    activeRequestId = null;
    const data = message.data || {};
    ownerProfileId = typeof data.ownerProfileId === "string" ? data.ownerProfileId : "";
    profiles = Array.isArray(data.profiles) ? data.profiles : [];
    chats = Array.isArray(data.chats) ? data.chats : [];
    failedChatIds = Array.isArray(data.failedChatIds) ? data.failedChatIds : [];
    profileIndex = core.buildProfileIndex(chats);
    indexCache = data.cache && typeof data.cache === "object" ? data.cache : {};
    orderedIds = core.mergeProfileOrder(profiles.map((profile) => profile._id), orderStore[ownerProfileId]);
    selectedIds.forEach((id) => {
      if (!profiles.some((profile) => profile._id === id)) selectedIds.delete(id);
    });
    lastLoadedAt = Date.now();
    chrome.storage.local.set({ [INDEX_CACHE_KEY]: indexCache });
    scheduleRender(0);
  }

  function handleApiChange(message) {
    if (message.resetIndexCache) indexCache = {};
    const forceChatIds = message.chatId ? [message.chatId] : [];
    scheduleRefresh("api-change", 250, forceChatIds);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE_BRIDGE) return;
    const message = event.data;
    if (message.type === "CPCI_DATA") handleData(message);
    if (message.type === "CPCI_ERROR" && (!activeRequestId || message.requestId === activeRequestId)) {
      activeRequestId = null;
      updateGlobalStatus(message.error || "연결 정보를 불러오지 못했습니다.", true);
    }
    if (message.type === "CPCI_PROGRESS" && message.requestId === activeRequestId) {
      const suffix = message.total ? ` (${message.completed}/${message.total})` : "";
      updateGlobalStatus(`연결 정보를 확인하는 중…${suffix}`, false);
    }
    if (message.type === "CPCI_API_CHANGED") handleApiChange(message);
    if (message.type === "CPCI_ROUTE_CHANGED") {
      lastUrl = location.href;
      if (isOnProfilePage()) scheduleRefresh("route-change", 150);
    }
    if (message.type === "CPCI_NAVIGATION_ERROR") {
      updateGlobalStatus("채팅방으로 이동하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.", true);
      document.querySelectorAll(".cpci-chat-link[data-navigating]").forEach((button) => {
        delete button.dataset.navigating;
      });
    }
    if (message.type === "CPCI_DELETE_CONFIRM_RESULT" && pendingDelete?.requestId === message.requestId) {
      if (!message.confirmed) {
        pendingDelete = null;
        return;
      }
      deleting = true;
      statusOverride = { message: `프로필 ${pendingDelete.profileIds.length}개를 삭제하는 중…`, error: false };
      updateEditUi();
      renderStatus();
      post("CPCI_DELETE_PROFILES", {
        requestId: pendingDelete.requestId,
        ownerProfileId,
        profileIds: pendingDelete.profileIds
      });
    }
    if (message.type === "CPCI_DELETE_PROGRESS" && pendingDelete?.requestId === message.requestId) {
      statusOverride = { message: `프로필을 삭제하는 중… (${message.completed}/${message.total})`, error: false };
      renderStatus();
    }
    if (message.type === "CPCI_DELETE_COMPLETE" && pendingDelete?.requestId === message.requestId) {
      const deletedIds = message.deletedProfileIds || [];
      cleanupDeleted(deletedIds).finally(() => {
        statusOverride = { message: `프로필 ${deletedIds.length}개를 삭제했습니다.`, error: false };
        renderStatus();
        post("CPCI_RELOAD_PROFILE_PAGE");
      });
    }
    if (message.type === "CPCI_DELETE_ERROR" && (!pendingDelete || pendingDelete.requestId === message.requestId)) {
      const deletedIds = message.deletedProfileIds || [];
      deleting = false;
      pendingDelete = null;
      statusOverride = { message: message.error || "프로필을 삭제하지 못했습니다.", error: true };
      updateEditUi();
      renderStatus();
      if (deletedIds.length) cleanupDeleted(deletedIds).finally(() => post("CPCI_RELOAD_PROFILE_PAGE"));
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('button[aria-haspopup="menu"]') : null;
    const card = trigger?.closest(CARD_SELECTOR);
    if (card?.dataset.cpciProfileId) menuProfileId = card.dataset.cpciProfileId;
    if (openPalette && event.target instanceof Node && !openPalette.contains(event.target)) closeCardPalette();
  }, true);

  document.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element ? event.target.closest('button[aria-haspopup="menu"]') : null;
    const card = trigger?.closest(CARD_SELECTOR);
    if (card?.dataset.cpciProfileId) {
      menuProfileId = card.dataset.cpciProfileId;
      setTimeout(injectColorMenuItems, 0);
    }
    if (!editMode || !(event.target instanceof Element)) return;
    const profileCard = event.target.closest(CARD_SELECTOR);
    if (!profileCard) return;
    if (event.target.closest(".cpci-card-edit-controls") || trigger || event.target.closest(".cpci-card-palette")) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener("resize", closeCardPalette);
  window.addEventListener("scroll", (event) => {
    if (openPalette && event.target instanceof Node && openPalette.contains(event.target)) return;
    closeCardPalette();
  }, true);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[TAGS_KEY]) {
      globalTags = Array.isArray(changes[TAGS_KEY].newValue)
        ? core.normalizeTagList(changes[TAGS_KEY].newValue)
        : [];
      const validKeys = new Set(globalTags.map(core.tagKey));
      for (const key of [...selectedTagKeys]) {
        if (!validKeys.has(key)) selectedTagKeys.delete(key);
      }
      profiles.forEach((profile) => refreshProfileVisuals(profile._id, false));
      updateFilterUi();
    }
    if (changes[NOTES_KEY]) {
      notes = changes[NOTES_KEY].newValue && typeof changes[NOTES_KEY].newValue === "object"
        ? changes[NOTES_KEY].newValue
        : {};
      profiles.forEach((profile) => refreshProfileVisuals(profile._id, false));
    }
    if (changes[TAGS_KEY] || changes[NOTES_KEY]) applyFilters();
    if (changes[ORDER_KEY]) {
      orderStore = changes[ORDER_KEY].newValue && typeof changes[ORDER_KEY].newValue === "object"
        ? changes[ORDER_KEY].newValue
        : {};
      orderedIds = core.mergeProfileOrder(profiles.map((profile) => profile._id), orderStore[ownerProfileId]);
      applyOrder();
    }
  });

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (mutation.target instanceof Element && mutation.target.closest(OWNED_SELECTOR)) return false;
      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) =>
        !(node instanceof Element) || !node.matches(OWNED_SELECTOR)
      );
    });
    if (relevant) {
      scheduleRender();
      setTimeout(injectColorMenuItems, 0);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("focus", () => {
    if (isOnProfilePage() && Date.now() - lastLoadedAt > 2_000) scheduleRefresh("focus", 150);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isOnProfilePage() && Date.now() - lastLoadedAt > 2_000) {
      scheduleRefresh("visible", 150);
    }
  });

  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    closeCardPalette();
    if (isOnProfilePage()) scheduleRefresh("url-change", 150);
  }, 750);

  storageReady.then(() => {
    if (isOnProfilePage()) scheduleRefresh("initial", 50);
  });
})();
