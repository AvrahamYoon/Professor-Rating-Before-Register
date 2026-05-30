const FACULTY_CELL_SELECTOR = 'td[id^="pg0_V_rptCourses_"][id$="_litFacultyValue"]';
const INJECTED_ATTR = "data-rmp-injected";
const INJECTED_NAME_ATTR = "data-rmp-professor-name";
const CACHE_PREFIX = "prbr:rmp:";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const EMPTY_CACHE_TTL_MS = 1000 * 60 * 20;
const MESSAGE_TIMEOUT_MS = 10000;
const LOOKUP_RETRY_DELAY_MS = 2500;
const UI_LOADING_NOTICE_MS = 5000;
const LOADING_SYNC_INTERVAL_MS = 1000;

const pendingLookups = new Map();
let scanTimer = null;
let loadingSyncTimer = null;
let popoverEventsBound = false;
let popoverFrame = null;
let nextLookupId = 0;

console.info("[PRBR] content script loaded");
showLoadedMarker();
scanAndInject();
observePageChanges();
startLoadingSync();

function observePageChanges() {
  if (!document.body) return;

  const observer = new MutationObserver((mutations) => {
    if (mutations.every(isPrbrMutation)) return;
    scheduleScan();
  });

  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });

  window.addEventListener("pageshow", scheduleScan);
  window.addEventListener("focus", scheduleScan);
}

function isPrbrMutation(mutation) {
  const target = mutation.target;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(".prbr-host") || target.id === "prbr-styles" || target.id === "prbr-loaded-marker");
}

function scheduleScan() {
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(scanAndInject, 250);
}

function scanAndInject() {
  const facultyCells = getFacultyTargets();
  console.info(`[PRBR] found ${facultyCells.length} instructor cells`);

  for (const cell of facultyCells) {
    if (!(cell instanceof HTMLElement)) continue;

    const nameElements = cell.querySelectorAll("li");
    if (nameElements.length > 0) {
      for (const item of nameElements) {
        injectForElement(item);
      }
      continue;
    }

    injectForElement(cell);
  }
}

function getFacultyTargets() {
  const visibleTargets = getVisibleInstructorCells();
  if (visibleTargets.length > 0) return visibleTargets;

  return Array.from(document.querySelectorAll(FACULTY_CELL_SELECTOR));
}

function getVisibleInstructorCells() {
  const table = document.querySelector("#tableCourses");
  if (!(table instanceof HTMLTableElement)) return [];

  const headers = Array.from(table.querySelectorAll("thead tr.footable-header th"));
  const visibleHeaders = headers.filter(isVisibleElement);
  const instructorIndex = visibleHeaders.findIndex(
    (header) => normalizeText(header.textContent).toLowerCase() === "instructor",
  );

  if (instructorIndex < 0) return [];

  return Array.from(table.tBodies)
    .flatMap((body) => Array.from(body.rows))
    .filter((row) => !row.classList.contains("footable-detail-row"))
    .map((row) => Array.from(row.cells).filter(isVisibleElement)[instructorIndex])
    .filter((cell) => cell instanceof HTMLElement);
}

function showLoadedMarker() {
  if (document.getElementById("prbr-loaded-marker")) return;

  const marker = document.createElement("div");
  marker.id = "prbr-loaded-marker";
  marker.textContent = "PRBR loaded";
  marker.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "padding:6px 8px",
    "border-radius:4px",
    "background:#1f2933",
    "color:#fff",
    "font:12px Arial,sans-serif",
    "box-shadow:0 2px 8px rgba(0,0,0,.25)",
  ].join(";");

  document.documentElement.append(marker);
  window.setTimeout(() => marker.remove(), 4000);
}

function injectForElement(element) {
  if (!(element instanceof HTMLElement)) return;

  const byuiName = getOwnText(element);
  const professorName = normalizeByuiName(byuiName);
  console.info("[PRBR] instructor text", { byuiName, professorName, element });
  if (!professorName || isPlaceholderName(professorName)) {
    console.info("[PRBR] skipped instructor cell", { byuiName, professorName });
    return;
  }

  if (element.getAttribute(INJECTED_ATTR) === "true") {
    const injectedName = element.getAttribute(INJECTED_NAME_ATTR);
    if (injectedName === professorName) return;

    element.querySelectorAll(":scope > .prbr-host").forEach((host) => host.remove());
    element.removeAttribute(INJECTED_ATTR);
    element.removeAttribute(INJECTED_NAME_ATTR);
    console.info("[PRBR] reinjecting changed instructor cell", { injectedName, professorName });
  }

  element.setAttribute(INJECTED_ATTR, "true");
  element.setAttribute(INJECTED_NAME_ATTR, professorName);
  injectShell(element, professorName);
}

function injectShell(item, professorName) {
  ensurePageStyles();
  ensurePopoverEvents();

  const host = document.createElement("span");
  host.className = "prbr-host";
  host.dataset.professorName = professorName;
  host.style.cssText = "display:inline-block;margin-left:8px;vertical-align:baseline;";
  host.append(createBadge("loading", "RMP ...", "Looking up Rate My Professors rating"));
  item.append(host);
  console.info("[PRBR] injected loading badge", { professorName, item });

  renderRatingIntoHost(host, professorName, 0);
}

function renderRatingIntoHost(host, professorName, attempt, options = {}) {
  const lookupId = String(++nextLookupId);
  host.dataset.rmpLookupId = lookupId;

  const lookup = getProfessorRating(professorName, options);
  let settled = false;

  window.setTimeout(() => {
    if (settled || !isCurrentLookup(host, lookupId)) return;
    console.info("[PRBR] RMP lookup still waiting; keeping current request alive", { professorName, attempt });
    host.replaceChildren(createBadge("loading", "RMP ...", "Still waiting for Rate My Professors"));
  }, UI_LOADING_NOTICE_MS);

  lookup
    .then((rating) => {
      if (!isCurrentLookup(host, lookupId)) return;
      settled = true;
      console.info("[PRBR] RMP result received; refreshing badge", { professorName, rating });
      host.replaceChildren(createRatingView(rating, professorName));
      refreshLoadingBadgesForProfessor(professorName, rating);
    })
    .catch((error) => {
      if (!isCurrentLookup(host, lookupId)) return;
      settled = true;

      if (attempt < 1) {
        console.info("[PRBR] retrying RMP lookup", {
          professorName,
          error: error instanceof Error ? error.message : String(error),
        });

        window.setTimeout(() => {
          if (!host.isConnected) return;
          host.replaceChildren(createBadge("loading", "RMP ...", "Retrying Rate My Professors rating"));
          renderRatingIntoHost(host, professorName, attempt + 1, { bypassPending: true });
        }, LOOKUP_RETRY_DELAY_MS);
        return;
      }

      host.replaceChildren(createBadge("unavailable", "RMP unavailable", "Could not load Rate My Professors"));
    });
}

function isCurrentLookup(host, lookupId) {
  return host.isConnected && host.dataset.rmpLookupId === lookupId;
}

function startLoadingSync() {
  if (loadingSyncTimer !== null) return;

  loadingSyncTimer = window.setInterval(syncLoadingBadgesFromCache, LOADING_SYNC_INTERVAL_MS);
}

function syncLoadingBadgesFromCache() {
  const loadingHosts = document.querySelectorAll(".prbr-host");
  for (const host of loadingHosts) {
    if (!(host instanceof HTMLElement)) continue;
    if (!host.querySelector(".badge.loading")) continue;

    const professorName = host.dataset.professorName;
    if (!professorName) continue;

    const cached = readCache(getCacheKey(professorName));
    if (cached === undefined) continue;

    console.info("[PRBR] refreshing loading badge from cache", { professorName, cached });
    host.replaceChildren(createRatingView(cached, professorName));
  }
}

function refreshLoadingBadgesForProfessor(professorName, rating) {
  for (const host of document.querySelectorAll(".prbr-host")) {
    if (!(host instanceof HTMLElement)) continue;
    if (host.dataset.professorName !== professorName) continue;
    if (!host.querySelector(".badge.loading")) continue;

    console.info("[PRBR] refreshing matching loading badge", { professorName, rating });
    host.replaceChildren(createRatingView(rating, professorName));
  }
}

async function getProfessorRating(professorName, options = {}) {
  const cacheKey = getCacheKey(professorName);
  const cached = readCache(cacheKey);
  if (cached !== undefined) return cached;

  if (!options.bypassPending && pendingLookups.has(cacheKey)) {
    return pendingLookups.get(cacheKey);
  }

  const lookup = sendMessageWithTimeout({ type: "RMP_LOOKUP", name: professorName }, MESSAGE_TIMEOUT_MS)
    .then((response) => {
      console.info("[PRBR] RMP message response received", { professorName, response });
      if (!response?.ok) {
        throw new Error(response?.error ?? "RMP lookup failed");
      }

      writeCache(cacheKey, response.result);
      return response.result;
    })
    .finally(() => {
      if (pendingLookups.get(cacheKey) === lookup) {
        pendingLookups.delete(cacheKey);
      }
    });

  pendingLookups.set(cacheKey, lookup);
  return lookup;
}

function getCacheKey(professorName) {
  return `${CACHE_PREFIX}${professorName.toLowerCase()}`;
}

function sendMessageWithTimeout(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("RMP lookup timed out"));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      window.clearTimeout(timeoutId);

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response);
    });
  });
}

function createRatingView(rating, professorName) {
  if (!rating) {
    return createMissingView(professorName);
  }

  const container = document.createElement("span");
  container.className = "rating-wrap prbr-popover-root";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = `badge ${ratingClass(rating.avgRating)}`;
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = `RMP ${formatNumber(rating.avgRating)}`;
  trigger.title = "View Rate My Professors summary";

  const card = document.createElement("span");
  card.className = "rmp-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", `Rate My Professors summary for ${rating.name || professorName}`);
  card.innerHTML = `
    <span class="card-header">
      <span>
        <strong>${escapeHtml(rating.name || professorName)}</strong>
        <span class="department">${escapeHtml(rating.department || "Department unknown")}</span>
      </span>
      <span class="score ${ratingClass(rating.avgRating)}">${formatNumber(rating.avgRating)}</span>
    </span>
    <span class="metrics">
      ${createMetric("Difficulty", `${formatNumber(rating.avgDifficulty)} / 5`)}
      ${createMetric("Reviews", String(rating.numRatings ?? 0))}
      ${createMetric("Would take again", formatPercent(rating.wouldTakeAgainPercent))}
    </span>
    <a class="rmp-link" href="${escapeAttribute(rating.url)}" target="_blank" rel="noopener noreferrer">Open on RMP</a>
  `;

  container.append(trigger, card);
  return container;
}

function createMissingView(professorName) {
  const container = document.createElement("span");
  container.className = "rating-wrap prbr-popover-root";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "badge missing";
  trigger.textContent = "No RMP";
  trigger.title = `No Rate My Professors result found for ${professorName}`;
  trigger.setAttribute("aria-expanded", "false");

  const card = document.createElement("span");
  card.className = "rmp-card missing-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", `No Rate My Professors result for ${professorName}`);
  card.innerHTML = `
    <span class="card-header">
      <span>
        <strong>${escapeHtml(professorName)}</strong>
        <span class="department">No matching RMP profile found</span>
      </span>
    </span>
    <span class="missing-note">Try clearing the page session cache if this professor recently appeared on RMP.</span>
  `;

  container.append(trigger, card);
  return container;
}

function createBadge(state, text, title) {
  const badge = document.createElement("span");
  badge.className = `badge ${state}`;
  badge.textContent = text;
  badge.title = title;
  return badge;
}

function createMetric(label, value) {
  return `
    <span class="metric">
      <span class="metric-label">${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

function ensurePopoverEvents() {
  if (popoverEventsBound) return;
  popoverEventsBound = true;

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;

    const trigger = event.target.closest(".prbr-popover-root .badge");
    if (trigger) {
      const root = trigger.closest(".prbr-popover-root");
      if (root instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        console.info("[PRBR] RMP badge click captured", { root, trigger });
        togglePopover(root);
      }
      return;
    }

    if (event.target.closest(".prbr-popover-root")) return;
    closeOpenPopovers();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOpenPopovers();
    }
  });

  window.addEventListener("resize", scheduleOpenPopoverUpdate);
  window.addEventListener("scroll", scheduleOpenPopoverUpdate, true);
}

function togglePopover(container) {
  const isOpen = container.classList.contains("open");
  closeOpenPopovers();

  if (!isOpen) {
    container.classList.add("open");
    container.querySelector(".badge")?.setAttribute("aria-expanded", "true");
    positionPopover(container);
    console.info("[PRBR] opened RMP card", { container });
  }
}

function closeOpenPopovers() {
  for (const root of document.querySelectorAll(".prbr-popover-root.open")) {
    closePopover(root);
  }
}

function positionPopover(container) {
  const card = container.querySelector(".rmp-card");
  const trigger = container.querySelector(".badge");
  if (!(card instanceof HTMLElement)) return;
  if (!(trigger instanceof HTMLElement)) return;

  container.classList.remove("align-right");
  const triggerRect = trigger.getBoundingClientRect();
  if (!isRectInViewport(triggerRect)) {
    closePopover(container);
    return;
  }

  const cardWidth = Math.min(280, window.innerWidth - 32);
  const cardHeight = Math.min(card.offsetHeight || 0, window.innerHeight - 32);
  const preferredTop = triggerRect.bottom + 8;
  const top =
    preferredTop + cardHeight > window.innerHeight - 16
      ? Math.max(16, triggerRect.top - cardHeight - 8)
      : preferredTop;
  const left = triggerRect.left;

  card.style.setProperty("--prbr-card-top", `${top}px`);
  card.style.setProperty("--prbr-card-left", `${left}px`);
  card.style.setProperty("--prbr-card-right", "auto");

  if (left + cardWidth > window.innerWidth - 16) {
    container.classList.add("align-right");
    card.style.setProperty("--prbr-card-left", "auto");
    card.style.setProperty("--prbr-card-right", "16px");
  }
}

function scheduleOpenPopoverUpdate() {
  if (popoverFrame !== null) return;

  popoverFrame = window.requestAnimationFrame(() => {
    popoverFrame = null;
    updateOpenPopovers();
  });
}

function updateOpenPopovers() {
  for (const root of document.querySelectorAll(".prbr-popover-root.open")) {
    if (root instanceof HTMLElement) {
      positionPopover(root);
    }
  }
}

function closePopover(root) {
  root.classList.remove("open");
  root.classList.remove("align-right");
  root.querySelector(".badge")?.setAttribute("aria-expanded", "false");
}

function isRectInViewport(rect) {
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

function ensurePageStyles() {
  if (document.getElementById("prbr-styles")) return;

  const style = document.createElement("style");
  style.id = "prbr-styles";
  style.textContent = `
    .prbr-host {
      display: inline-block;
      position: relative;
      font-family: Arial, sans-serif;
      vertical-align: baseline;
    }

    .prbr-host .rating-wrap {
      display: inline-block;
      position: relative;
    }

    .prbr-host .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 18px;
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid #b9c1cc;
      background: #f4f6f8;
      color: #1f2933;
      cursor: pointer;
      font-size: 11px;
      font-weight: 700;
      line-height: 16px;
      font-family: inherit;
      text-decoration: none;
      white-space: nowrap;
    }

    .prbr-host .badge:focus-visible,
    .prbr-host .rmp-link:focus-visible {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
    }

    .prbr-host .badge.good {
      border-color: #248a45;
      background: #e8f6ed;
      color: #176233;
    }

    .prbr-host .badge.ok {
      border-color: #b7791f;
      background: #fff4d6;
      color: #7a4d00;
    }

    .prbr-host .badge.low,
    .prbr-host .badge.unavailable,
    .prbr-host .badge.missing {
      border-color: #b8b8b8;
      background: #f5f5f5;
      color: #555;
    }

    .prbr-host .badge.loading,
    .prbr-host .badge.unavailable {
      cursor: default;
    }

    .prbr-host .badge.loading {
      color: #3f5f8f;
    }

    .prbr-host .rmp-card {
      display: none;
      position: fixed;
      left: var(--prbr-card-left, 16px);
      right: var(--prbr-card-right, auto);
      top: var(--prbr-card-top, 16px);
      z-index: 2147483647;
      width: 280px;
      max-width: min(280px, calc(100vw - 32px));
      padding: 12px;
      border: 1px solid #d7dde5;
      border-radius: 8px;
      background: #fff;
      color: #1f2933;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.22);
      font-size: 12px;
      line-height: 1.35;
    }

    .prbr-host .open .rmp-card {
      display: block;
    }

    .prbr-host .align-right .rmp-card {
      right: var(--prbr-card-right, 16px);
      left: var(--prbr-card-left, auto);
    }

    .prbr-host .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }

    .prbr-host .card-header strong,
    .prbr-host .department,
    .prbr-host .missing-note {
      display: block;
    }

    .prbr-host .card-header strong {
      color: #111827;
      font-size: 13px;
      line-height: 1.25;
    }

    .prbr-host .department,
    .prbr-host .missing-note,
    .prbr-host .metric-label {
      color: #5b6776;
    }

    .prbr-host .score {
      min-width: 42px;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 800;
      line-height: 1;
      text-align: center;
    }

    .prbr-host .score.good {
      background: #e8f6ed;
      color: #176233;
    }

    .prbr-host .score.ok {
      background: #fff4d6;
      color: #7a4d00;
    }

    .prbr-host .score.low,
    .prbr-host .score.missing {
      background: #f5f5f5;
      color: #555;
    }

    .prbr-host .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }

    .prbr-host .metric {
      display: block;
      min-width: 0;
      padding: 8px;
      border: 1px solid #e6eaf0;
      border-radius: 6px;
      background: #f8fafc;
    }

    .prbr-host .metric strong {
      display: block;
      margin-top: 2px;
      color: #111827;
      font-size: 12px;
      line-height: 1.2;
    }

    .prbr-host .metric-label {
      display: block;
      min-height: 28px;
      font-size: 10px;
      line-height: 1.2;
    }

    .prbr-host .rmp-link {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      border-radius: 6px;
      background: #111827;
      color: #fff;
      font-weight: 700;
      text-decoration: none;
    }

    .prbr-host .missing-card {
      width: 240px;
    }
  `;

  document.documentElement.append(style);
}

function normalizeByuiName(rawName) {
  const cleaned = String(rawName ?? "")
    .replace(/\s+/g, " ")
    .replace(/\bRMP\s+(\d+(\.\d)?|unavailable|No RMP|\.\.\.)\b/i, "")
    .trim();

  if (!cleaned.includes(",")) return cleaned;

  const [last, ...firstParts] = cleaned.split(",");
  const first = firstParts.join(",").trim();
  return `${first} ${last.trim()}`.replace(/\s+/g, " ").trim();
}

function getOwnText(element) {
  const textParts = [];

  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      textParts.push(node.textContent ?? "");
    }
  }

  const ownText = textParts.join(" ").trim();
  return ownText || element.textContent || "";
}

function isVisibleElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isPlaceholderName(name) {
  return /^(tba|staff|instructor|none|unknown)$/i.test(name.trim());
}

function ratingClass(avgRating) {
  const rating = Number(avgRating);
  if (!Number.isFinite(rating)) return "missing";
  if (rating >= 4) return "good";
  if (rating >= 3) return "ok";
  return "low";
}

function formatNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toFixed(1) : "N/A";
}

function formatPercent(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? `${Math.round(numberValue)}%` : "N/A";
}

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;

    const entry = JSON.parse(raw);
    const ttl = entry.value === null ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - entry.createdAt > ttl) {
      sessionStorage.removeItem(key);
      return undefined;
    }

    return entry.value;
  } catch {
    return undefined;
  }
}

function writeCache(key, value) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        createdAt: Date.now(),
        value,
      }),
    );
  } catch {
    // Cache failures should not break the extension UI.
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
