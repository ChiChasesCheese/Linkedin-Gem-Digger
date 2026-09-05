# Linkedin Gem Digger

Chrome extension that flags the deal-breakers in a job posting before you read it:
years-of-experience above your threshold, US-citizenship / security-clearance
requirements, "no sponsorship", and (on LinkedIn search results) seniority in the title,
low salary, already-viewed, reposted and 100+ applicants.

Works on LinkedIn Jobs and on Ashby, Greenhouse, Lever, Workday, SmartRecruiters,
Wellfound, Workable, Jobvite, iCIMS and Rippling posting pages. Everything runs locally;
nothing leaves your browser.

## Install (unpacked)

1. `git clone https://github.com/ChiChasesCheese/Linkedin-Gem-Digger`
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the repo folder.
3. Open any job posting. A panel appears bottom-right with the flags it found (green = clean).

## LinkedIn list pages

Cards are greyed automatically from what the card itself shows (title, salary, Viewed…).
Click the extension icon → **Scan visible cards** to also fetch each visible posting
(one at a time, ~1.5 s apart, cached for 7 days) for YOE / citizenship / applicant count.
If LinkedIn ever answers 429/403 the scan stops and backs off for at least 5 minutes.

## Configure

Extension icon → thresholds, rule toggles, title greylist, grey-vs-hide.

## Develop

- `npm test` — pure logic (`analyze`, `analyzeCard`, salary parser, scanner throttle/cache/back-off).
- Add a rule: one entry in `src/rules.js`. Change where text comes from: `src/extract.js`. Change how it looks: `src/render.js`.
- Design: `docs/superpowers/specs/`, plan: `docs/superpowers/plans/`.

Not affiliated with LinkedIn. MIT.
