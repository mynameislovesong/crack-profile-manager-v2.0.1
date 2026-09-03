(() => {
  "use strict";

  const ROOT_KEY = "__crackProfileManagerTampermonkeyStorageV1";
  const CSS_URL = "https://raw.githubusercontent.com/mynameislovesong/crack-profile-manager-v2.0.1/main/content.css";
  const listeners = new Set();

  function readAll() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ROOT_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function storageGet(keys) {
    const source = readAll();
    if (keys == null) return Promise.resolve({ ...source });

    if (typeof keys === "object" && !Array.isArray(keys)) {
      const result = {};
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : fallback;
      }
      return Promise.resolve(result);
    }

    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : [];
    const result = {};
    for (const key of list) {
      if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
    }
    return Promise.resolve(result);
  }

  function emitChanges(changes) {
    if (!Object.keys(changes).length) return;
    for (const listener of listeners) {
      try {
        listener(changes, "local");
      } catch (error) {
        console.error("[Crack Profile Manager] storage listener error", error);
      }
    }
  }

  function storageSet(items) {
    const before = readAll();
    const next = { ...before, ...(items && typeof items === "object" ? items : {}) };
    const changes = {};

    for (const [key, newValue] of Object.entries(items || {})) {
      const oldValue = before[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes[key] = { oldValue, newValue };
      }
    }

    try {
      localStorage.setItem(ROOT_KEY, JSON.stringify(next));
      emitChanges(changes);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  const storageApi = {
    local: {
      get: storageGet,
      set: storageSet
    },
    onChanged: {
      addListener(listener) {
        if (typeof listener === "function") listeners.add(listener);
      }
    }
  };

  try {
    const chromeObject = window.chrome || {};
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", {
        configurable: true,
        enumerable: false,
        value: chromeObject
      });
    }
    if (!chromeObject.storage) {
      Object.defineProperty(chromeObject, "storage", {
        configurable: true,
        enumerable: false,
        value: storageApi
      });
    }
  } catch (error) {
    console.error("[Crack Profile Manager] chrome.storage shim 설치 실패", error);
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== ROOT_KEY) return;
    let before = {};
    let after = {};
    try { before = JSON.parse(event.oldValue || "{}") || {}; } catch {}
    try { after = JSON.parse(event.newValue || "{}") || {}; } catch {}
    const changes = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const oldValue = before[key];
      const newValue = after[key];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes[key] = { oldValue, newValue };
      }
    }
    emitChanges(changes);
  });

  if (!document.getElementById("cpci-tampermonkey-style")) {
    fetch(CSS_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`CSS HTTP ${response.status}`);
        return response.text();
      })
      .then((css) => {
        if (document.getElementById("cpci-tampermonkey-style")) return;
        const style = document.createElement("style");
        style.id = "cpci-tampermonkey-style";
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      })
      .catch((error) => console.error("[Crack Profile Manager] CSS 로드 실패", error));
  }
})();
