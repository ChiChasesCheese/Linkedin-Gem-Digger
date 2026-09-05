# Linkedin-Gem-Digger — design spec

Date: 2026-09-05
Status: approved in brainstorming (10-question grill, all recommendations accepted)

## Goal

A Chrome (MV3) extension that reads job postings the user is already looking at and flags
hard blockers so the user does not have to read every posting: years-of-experience (YOE)
above a threshold, US-citizenship / security-clearance requirements, no visa sponsorship,
and (on LinkedIn lists) cheap card-level signals such as seniority in the title, low
salary, "Viewed", reposted, and 100+ applicants.

Non-goals (v1): Chrome Web Store publishing, Indeed/Glassdoor list adapters, LLM
classification, any server component, any automatic background fetching.

## Guiding constraints

- **Do not abuse LinkedIn.** Nothing is fetched unless the user clicks "Scan". Requests are
  serialized, jittered (1.5 s ± 0.5 s), limited to the cards currently on the page (~25),
  cached per job id for 7 days, and stop entirely on the first 429/403 with exponential
  back-off. No request is ever made from a page the user is not on.
- **Extensible by construction.** Adding a rule = one array entry. Changing where text
  comes from = `extract.js` only. Changing how results look = `render.js` only.
- **No build step.** Plain ES modules, loaded unpacked from `chrome://extensions`.
- **Pure core.** `analyze()` never touches the DOM and is unit-tested with `node --test`.

## Architecture

```
Linkedin-Gem-Digger/
├── manifest.json            MV3; content_scripts on the whitelist below
├── src/
│   ├── rules.js             data: rule table (regex, category, severity, scope)
│   ├── analyze.js           analyze(text, config) → Finding[]           (pure)
│   ├── cards.js             analyzeCard(cardMeta, config) → Finding[]   (pure)
│   ├── extract.js           getJobText(), getCards(), getJobIdFromCard()  (DOM read)
│   ├── render.js            renderPanel(findings), markCard(el, findings) (DOM write)
│   ├── config.js            load/save config via chrome.storage.sync, defaults
│   ├── linkedin-api.js      fetchJobDetail(jobId) → {text, applies, reposted} (Voyager)
│   ├── scanner.js           scanVisibleCards(): throttle + cache + backoff
│   └── main.js              glue: observe page → extract → analyze → render
├── content.js               classic script; dynamic-imports src/main.js
├── popup/                   popup.html / popup.js: thresholds, toggles, Scan button
├── test/                    analyze.test.js, cards.test.js, scanner.test.js
├── docs/superpowers/...     this spec, the plan
├── LICENSE                  MIT
└── README.md
```

MV3 content scripts cannot be ES modules directly. `content.js` is a tiny classic script
that does `import(chrome.runtime.getURL('src/main.js'))`; everything under `src/` is a
module and `src/**` is listed in `web_accessible_resources`.

Data flow (detail page, every site):

1. `main.js` waits for the page to settle (MutationObserver + URL change, debounced
   500 ms).
2. `extract.getJobText()` returns the JD text. On LinkedIn it prefers the detail-pane
   container (`[class*="jobs-description"]`, falling back to `document.body.innerText`);
   elsewhere it is `document.body.innerText`.
3. `analyze(text, config)` returns findings.
4. `render.renderPanel(findings)` draws/updates a fixed bottom-right panel.

Data flow (LinkedIn list, cheap tier — automatic):

1. `extract.getCards()` returns `[{el, jobId, title, salaryMin, salaryMax, badges}]` read
   from each card's own text only.
2. `cards.analyzeCard(meta, config)` returns findings.
3. `render.markCard(el, findings)` greys the card and adds a reason strip. Hidden instead
   of greyed when `config.hideInsteadOfGrey` is true.

Data flow (LinkedIn list, deep tier — manual "Scan" only):

1. User clicks **Scan visible cards** in the popup. Popup sends `{type:'scan'}` to the
   content script via `chrome.tabs.sendMessage`.
2. `scanner.scanVisibleCards()` iterates the cards on screen, skips ids in cache, calls
   `linkedin-api.fetchJobDetail(id)` serially with jitter, reports progress back to the
   popup, and on each result runs `analyze(text)` plus applicant/reposted rules, then
   `render.markCard`.
3. Results go to `chrome.storage.local` keyed by job id with a timestamp (TTL 7 days).
4. Any 429/403 aborts the scan, doubles a persisted back-off interval (min 5 min), and
   shows "rate-limited, try later" in the popup.

## Rules

Rule shape:

```js
{ id, category, severity: 'red'|'yellow', scope: 'text'|'card',
  pattern: RegExp, extract?: (match) => number, defaultOn: boolean }
```

### Text rules (scope `text`, run by `analyze()`)

| id | category | matches | severity |
|---|---|---|---|
| `yoe` | experience | `3+ years`, `2-5 yrs`, `five years of`, `minimum of 4 years`, `at least 3 years` | red if min years ≥ `yoeThreshold` (default 2), else not reported |
| `citizenship` | citizenship | `U.S. citizen(ship) (required\|only)`, `must be a US citizen`, `US persons only`, `citizenship (is )?required` | red |
| `clearance` | clearance | `security clearance`, `(secret\|top secret\|TS/SCI\|public trust) clearance`, `ITAR`, `export control(led)?` | red |
| `sponsorship` | sponsorship | `no (visa )?sponsorship`, `(unable\|not able\|will not\|cannot) (to )?sponsor`, `H-?1B` | red |
| `degree` | degree | `(PhD\|Master'?s\|MS) (is )?required` | yellow, default off |
| `reposted` | freshness | `Reposted \d+ (day\|week\|month)s? ago` (detail header text) | yellow (configurable to red) |

Analyzer details:

- YOE takes the **minimum** number in a range (`2-5` → 2, `5+` → 5). Number words
  one…ten map to digits.
- **Context downgrade:** the sentence containing the match (split on `.`, `;`, newline)
  containing `preferred`, `nice to have`, `a plus`, `bonus`, `ideally` downgrades red → yellow.
- **YOE noise filter:** skip sentences containing `benefit`, `vacation`, `PTO`, `founded`,
  `history`, `ago`, `track record`, `years old`, `warranty`.
- **Dedupe:** multiple hits with the same id keep all `sentence`s but the panel headline
  shows the most severe / highest YOE.
- Output: `Finding = { id, category, severity, value?, sentence }`. Empty array = clean.

### Card rules (scope `card`, run by `analyzeCard()` — LinkedIn list only)

| id | input | rule | default |
|---|---|---|---|
| `title-seniority` | title | matches any of `titleGreylist` (default `Senior, Sr., Staff, Principal, Lead, Manager, Director, Architect, Head of`) **unless** title matches `Intern\|New Grad\|Entry\|Junior\|Early Career` | on |
| `salary-max` | salaryMax | present and `< salaryFloor` (default 130000) | on |
| `viewed` | badges | card shows `Viewed` | on |
| `promoted` | badges | card shows `Promoted` | off |
| `reposted` | badges / deep result | reposted | yellow (grey if `repostedIsRed`) |
| `applicants` | deep result | `applies ≥ applicantsMax` (default 100) | on |

Salary parsing: `$100K/yr - $120K/yr`, `$100,000 - $120,000`, `$50/hr` (hourly ×2080).
Only annual figures are compared to the floor; hourly is converted.

## Config (`chrome.storage.sync`)

```js
{
  yoeThreshold: 2, salaryFloor: 130000, applicantsMax: 100,
  titleGreylist: ['Senior','Sr.','Staff','Principal','Lead','Manager','Director','Architect','Head of'],
  rules: { yoe:true, citizenship:true, clearance:true, sponsorship:true, degree:false,
           reposted:true, 'title-seniority':true, 'salary-max':true, viewed:true,
           promoted:false, applicants:true },
  repostedIsRed: false, hideInsteadOfGrey: false,
  scan: { intervalMs: 1500, jitterMs: 500, cacheTtlDays: 7, backoffMs: 0, backoffUntil: 0 }
}
```

## Sites (manifest `matches`)

- `https://www.linkedin.com/jobs/*` (search, collections, view)
- `https://jobs.ashbyhq.com/*`, `https://*.ashbyhq.com/*`
- `https://boards.greenhouse.io/*`, `https://job-boards.greenhouse.io/*`
- `https://jobs.lever.co/*`
- `https://*.myworkdayjobs.com/*`
- `https://jobs.smartrecruiters.com/*`
- `https://wellfound.com/*`
- `https://apply.workable.com/*`
- `https://jobs.jobvite.com/*`
- `https://*.icims.com/*`
- `https://ats.rippling.com/*`

Permissions: `storage`, `activeTab`. Host permissions are implied by `content_scripts`
matches; the Voyager call is same-origin from the LinkedIn content script, so no extra
host permission is needed.

## LinkedIn deep fetch (`linkedin-api.js`)

- Endpoint: `GET https://www.linkedin.com/voyager/api/jobs/jobPostings/{id}`
- Headers: `csrf-token` = `JSESSIONID` cookie value with quotes stripped,
  `accept: application/json`, `x-restli-protocol-version: 2.0.0`, `x-li-lang: en_US`;
  `credentials: 'include'`.
- Read: `description.text`, `applies`, `listedAt`, `originalListedAt`
  (reposted = `listedAt !== originalListedAt`).
- Fallback on non-429/403 failure: guest endpoint
  `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}` (HTML fragment;
  description from `.show-more-less-html__markup`, applicants from
  `.num-applicants__caption`, reposted from `.posted-time-ago__text`).
- Never called outside a user-initiated scan.

## UI

- **Panel** (all sites): fixed bottom-right, 280 px wide, collapsible. Header colour =
  worst severity (red / yellow / green "No red flags"). One row per finding: category
  badge, value (e.g. `3+ yrs`), and the matched sentence in small text. Close button
  hides it for this job id until the URL changes.
- **Card marking** (LinkedIn list): `opacity: .45` + 4 px left border (red/yellow) + a
  one-line reason strip under the title, e.g. `Senior · $ < 130K · 120 applicants`.
  `hideInsteadOfGrey` sets `display:none`.
- **Popup**: thresholds (YOE, salary floor, applicants), rule toggles, title greylist
  textarea, grey/hide switch, **Scan visible cards** button with progress `n / total`,
  status line (idle / scanning / rate-limited until hh:mm), "Clear cache" button.

## Error handling

- Extractor finds no text → panel not rendered (no false "clean").
- Voyager returns 401/403/429 → abort scan, persist back-off, show status. Never retry
  automatically.
- Voyager returns other error → try guest endpoint once; if that fails, mark card
  "scan failed" and move on.
- DOM selectors miss (LinkedIn redesign) → card tier silently does nothing; detail tier
  falls back to `body.innerText`.

## Testing

- `node --test test/` covers `analyze()`, `analyzeCard()`, salary/YOE parsers, and the
  scanner's throttle/cache/back-off logic with a fake fetch. Real JD snippets as fixtures.
- DOM layer verified manually in Chrome (user's profile), only once the unit-tested build
  is complete. E2E on LinkedIn limited to: open a search page, check card marking, open
  one detail, check panel, run **one** manual scan of ≤ 10 cards. No repeated scans.

## Phasing

1. **v0.1** — text rules, panel on all whitelisted sites, popup thresholds/toggles.
2. **v0.2** — LinkedIn card tier (title, salary, viewed/promoted), grey/hide.
3. **v0.3** — manual deep scan (Voyager + cache + back-off), applicants, reposted.
4. Later (not planned): auto-scan-on-scroll toggle, Indeed/Glassdoor adapters, LLM
   second-opinion.
