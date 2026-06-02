# Professor Rating Before Register

Minimal Chrome MV3 extension that injects Rate My Professors badges into BYU-Idaho registration search results.

This is currently an MVP. It has no build step and can be loaded directly as an unpacked Chrome extension.

## Tech Stack

[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![Chrome Extension MV3](https://img.shields.io/badge/Chrome%20Extension-MV3-4285F4?style=flat&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![GraphQL](https://img.shields.io/badge/GraphQL-E10098?style=flat&logo=graphql&logoColor=white)](https://graphql.org/)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)](https://developer.mozilla.org/docs/Web/CSS)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)](https://developer.mozilla.org/docs/Web/HTML)
[![Rate My Professors](https://img.shields.io/badge/Rate%20My%20Professors-API-111827?style=flat)](https://www.ratemyprofessors.com/)

## Install Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open a BYU-Idaho registration search result page.

## Current Behavior

- Scans the BYU-Idaho course results table.
- Finds the visible `Instructor` column, including pages where Footable hides the original instructor cell.
- Normalizes BYU-Idaho names such as `Example, Jane` to `Jane Example`.
- Looks up professor ratings through Rate My Professors GraphQL from the extension background service worker.
- Injects a small badge next to each professor name:
  - `RMP 4.2` when a rating is found.
  - `No RMP` when no matching professor is returned.
  - `RMP unavailable` when the lookup fails or times out.
- Opens a compact professor card when an RMP badge is clicked, with rating, difficulty, review count, department, would-take-again percentage, and an RMP profile link.
- Caches successful lookup results in `sessionStorage` for 6 hours and empty results for 20 minutes.

## Project Structure

- `manifest.json` configures the Chrome MV3 extension.
- `src/content.js` scans the BYU-Idaho page and injects rating badges.
- `src/background.js` performs RMP GraphQL requests.

## BYU-Idaho DOM Targeting

The original BYU-Idaho instructor cells use ids like:

```css
td[id^="pg0_V_rptCourses_"][id$="_litFacultyValue"]
```

However, the registration table may use Footable and hide those original cells. The content script therefore first locates the visible `Instructor` column from `#tableCourses`, and only falls back to the original id-based cells when needed.

## Known Issues

- RMP does not provide a stable public API. The extension uses an unofficial GraphQL endpoint.
- Some professors that exist on RMP may not be returned by the current search query.
- RMP school-scoped search may have incomplete recall. The MVP tries both BYUI-scoped search and all-school search filtered back to BYUI.
- Name matching is still heuristic and may miss professors with unusual RMP names, nicknames, or changed names.
- Debug logging is still enabled with the `[PRBR]` prefix in the page console and background service worker console.

## Development Notes

After editing extension files:

1. Go to `chrome://extensions`.
2. Click the refresh button on this extension.
3. Refresh the BYU-Idaho registration page.

Useful console checks:

```js
document.querySelectorAll(".prbr-host").length
document.querySelectorAll('td[id^="pg0_V_rptCourses_"][id$="_litFacultyValue"]').length
```

To inspect RMP lookup logs, open the extension's service worker console from `chrome://extensions`.
