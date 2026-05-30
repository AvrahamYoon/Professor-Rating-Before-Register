# Professor Rating Before Register

Minimal Chrome MV3 extension that injects Rate My Professors badges into BYU-Idaho registration search results.

## Local install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open a BYU-Idaho registration search result page.

The MVP targets instructor cells that match:

```css
td[id^="pg0_V_rptCourses_"][id$="_litFacultyValue"] li
```

BYU-Idaho names such as `Smith, Brigham` are normalized to `Brigham Smith` before searching RMP.
