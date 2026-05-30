const FACULTY_CELL_SELECTOR = 'td[id^="pg0_V_rptCourses_"][id$="_litFacultyValue"]';
const INJECTED_ATTR = "data-rmp-injected";
const CACHE_PREFIX = "prbr:rmp:";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

const pendingLookups = new Map();
let scanTimer = null;

console.info("[PRBR] content script loaded");
showLoadedMarker();
scanAndInject();
observePageChanges();

function observePageChanges() {
  if (!document.body) return;

  const observer = new MutationObserver(() => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanAndInject, 250);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
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
  if (element.getAttribute(INJECTED_ATTR) === "true") return;

  const byuiName = getOwnText(element);
  const professorName = normalizeByuiName(byuiName);
  console.info("[PRBR] instructor text", { byuiName, professorName, element });
  if (!professorName || isPlaceholderName(professorName)) {
    console.info("[PRBR] skipped instructor cell", { byuiName, professorName });
    return;
  }

  element.setAttribute(INJECTED_ATTR, "true");
  injectShell(element, professorName);
}

function injectShell(item, professorName) {
  ensurePageStyles();

  const host = document.createElement("span");
  host.className = "prbr-host";
  host.style.cssText = "display:inline-block;margin-left:8px;vertical-align:baseline;";
  host.append(createBadge("loading", "RMP ...", "Looking up Rate My Professors rating"));
  item.append(host);
  console.info("[PRBR] injected loading badge", { professorName, item });

  getProfessorRating(professorName)
    .then((rating) => {
      host.replaceChildren(createRatingView(rating, professorName));
    })
    .catch(() => {
      host.replaceChildren(createBadge("unavailable", "RMP unavailable", "Could not load Rate My Professors"));
    });
}

async function getProfessorRating(professorName) {
  const cacheKey = `${CACHE_PREFIX}${professorName.toLowerCase()}`;
  const cached = readCache(cacheKey);
  if (cached !== undefined) return cached;

  if (pendingLookups.has(cacheKey)) {
    return pendingLookups.get(cacheKey);
  }

  const lookup = chrome.runtime
    .sendMessage({ type: "RMP_LOOKUP", name: professorName })
    .then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error ?? "RMP lookup failed");
      }

      writeCache(cacheKey, response.result);
      return response.result;
    })
    .finally(() => {
      pendingLookups.delete(cacheKey);
    });

  pendingLookups.set(cacheKey, lookup);
  return lookup;
}

function createRatingView(rating, professorName) {
  if (!rating) {
    return createBadge("missing", "No RMP", `No Rate My Professors result found for ${professorName}`);
  }

  const container = document.createElement("span");
  container.className = "rating-wrap";

  const link = document.createElement("a");
  link.className = `badge ${ratingClass(rating.avgRating)}`;
  link.href = rating.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `RMP ${formatNumber(rating.avgRating)}`;
  link.title = "Open Rate My Professors";

  const tooltip = document.createElement("span");
  tooltip.className = "tooltip";
  tooltip.innerHTML = `
    <strong>${escapeHtml(rating.name || professorName)}</strong>
    <span>${escapeHtml(rating.department || "Department unknown")}</span>
    <span>Rating: ${formatNumber(rating.avgRating)} / 5</span>
    <span>Difficulty: ${formatNumber(rating.avgDifficulty)} / 5</span>
    <span>Reviews: ${rating.numRatings ?? 0}</span>
    <span>Would take again: ${formatPercent(rating.wouldTakeAgainPercent)}</span>
  `;

  container.append(link, tooltip);
  return container;
}

function createBadge(state, text, title) {
  const badge = document.createElement("span");
  badge.className = `badge ${state}`;
  badge.textContent = text;
  badge.title = title;
  return badge;
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
      min-height: 18px;
      padding: 1px 6px;
      border-radius: 4px;
      border: 1px solid #b9c1cc;
      background: #f4f6f8;
      color: #1f2933;
      font-size: 11px;
      font-weight: 700;
      line-height: 16px;
      text-decoration: none;
      white-space: nowrap;
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

    .prbr-host .badge.loading {
      color: #3f5f8f;
    }

    .prbr-host .tooltip {
      display: none;
      position: absolute;
      left: 0;
      top: 24px;
      z-index: 2147483647;
      min-width: 190px;
      padding: 8px 10px;
      border-radius: 4px;
      background: #1f2933;
      color: #fff;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      font-size: 12px;
      line-height: 1.35;
    }

    .prbr-host .tooltip strong,
    .prbr-host .tooltip span {
      display: block;
      margin: 2px 0;
    }

    .prbr-host .rating-wrap:hover .tooltip,
    .prbr-host .rating-wrap:focus-within .tooltip {
      display: block;
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
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
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
