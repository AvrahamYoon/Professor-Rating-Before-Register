const FACULTY_ITEM_SELECTOR = 'td[id^="pg0_V_rptCourses_"][id$="_litFacultyValue"] li';
const INJECTED_ATTR = "data-rmp-injected";
const CACHE_PREFIX = "prbr:rmp:";
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;

const pendingLookups = new Map();
let scanTimer = null;

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
  const facultyItems = document.querySelectorAll(FACULTY_ITEM_SELECTOR);

  for (const item of facultyItems) {
    if (!(item instanceof HTMLElement)) continue;
    if (item.getAttribute(INJECTED_ATTR) === "true") continue;

    const byuiName = item.textContent ?? "";
    const professorName = normalizeByuiName(byuiName);
    if (!professorName || isPlaceholderName(professorName)) continue;

    item.setAttribute(INJECTED_ATTR, "true");
    injectShell(item, professorName);
  }
}

function injectShell(item, professorName) {
  const host = document.createElement("span");
  host.className = "prbr-host";
  host.style.marginLeft = "8px";

  const shadow = host.attachShadow({ mode: "open" });
  shadow.append(createStyles(), createBadge("loading", "RMP ...", "Looking up Rate My Professors rating"));
  item.append(host);

  getProfessorRating(professorName)
    .then((rating) => {
      shadow.replaceChildren(createStyles(), createRatingView(rating, professorName));
    })
    .catch(() => {
      shadow.replaceChildren(createStyles(), createBadge("unavailable", "RMP unavailable", "Could not load Rate My Professors"));
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

function createStyles() {
  const style = document.createElement("style");
  style.textContent = `
    :host {
      display: inline-block;
      position: relative;
      font-family: Arial, sans-serif;
      vertical-align: baseline;
    }

    .rating-wrap {
      display: inline-block;
      position: relative;
    }

    .badge {
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

    .badge.good {
      border-color: #248a45;
      background: #e8f6ed;
      color: #176233;
    }

    .badge.ok {
      border-color: #b7791f;
      background: #fff4d6;
      color: #7a4d00;
    }

    .badge.low,
    .badge.unavailable,
    .badge.missing {
      border-color: #b8b8b8;
      background: #f5f5f5;
      color: #555;
    }

    .badge.loading {
      color: #3f5f8f;
    }

    .tooltip {
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

    .tooltip strong,
    .tooltip span {
      display: block;
      margin: 2px 0;
    }

    .rating-wrap:hover .tooltip,
    .rating-wrap:focus-within .tooltip {
      display: block;
    }
  `;

  return style;
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
