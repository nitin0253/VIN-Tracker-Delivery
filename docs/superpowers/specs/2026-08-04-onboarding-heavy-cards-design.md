# Design: Onboarding + Heavy Vehicles & Exceptions cards

**Date:** 2026-08-04
**Project:** VIN-Tracker-Delivery (QC Pendency dashboard)
**Author:** Nitin (with Claude Code)
**Status:** Approved — ready to implement

## 1. Background

The dashboard (`index.html`, single-file frontend + `api/data.js` Vercel function
that pulls Metabase card 12497) shows **QC Pending** VINs by default and has one
clickable **QC Hold** card that swaps the whole dashboard to the `rb === 'QC Hold'`
slice via a single `_activeStatus` state.

We want to further segment the **QC Pending** pool so that two groups of accounts are
pulled out of the normal pendency view into their own cards, each behaving exactly like
the QC Hold card (click → hourly breakdown, type filter, distribution charts, enterprise
& team tables, and drawer all scope to that segment).

## 2. Requirements

1. Add two cards next to QC Hold:
   - **Onboarding** — QC-Pending VINs belonging to enterprises whose `stage` is `"onboarding"`.
   - **Heavy Vehicles & Exceptions** — QC-Pending VINs belonging to a fixed list of exception enterprises.
2. Clicking a card scopes every section (Hourly Breakdown, Filter by Type, Distribution,
   Enterprise Breakdown, Team Breakdown, VIN drawer) to that segment — same UX as QC Hold.
3. Onboarding and Heavy VINs are **removed from the default pendency view** and its cards/tables.

## 3. Decisions (resolved with user)

- **Carve-out scope:** QC Pending only. QC Hold stays exactly as-is (still counts ALL hold
  VINs, including those from onboarding/heavy enterprises). Onboarding/Heavy cards count
  **QC-Pending** VINs only.
- **Overlap priority:** If an enterprise is both onboarding-stage AND in the Heavy list,
  **Heavy wins** (explicit ID list is checked first).
- **Onboarding match:** enterprise `stage` equals `"onboarding"` exactly (case-insensitive,
  trimmed) — NOT a loose `"onboard"` substring.
- **Layout:** three cards in a row on the right of the metric strip (QC Hold red,
  Onboarding amber, Heavy & Exceptions purple).
- **Backend:** no change to `api/data.js`. All required fields (`eid`, enterprise `stage`,
  `rb`) are already in the API response, so segmentation is purely client-side.

### Heavy Vehicles & Exceptions enterprise IDs (6 unique)

The list the user shared contained 11 tuple entries, but 5 were exact duplicates; the
distinct set is 6 enterprises:

| enterprise_id | name |
|---------------|------|
| `80dbe5fe1` | Seth Wadley Ford of Pauls Valley |
| `0eee6a3c0` | Yoder Family of Companies |
| `29e9aa6d6` | KASS Bladel-Reusel BV |
| `f2e953679` | Altawkilat |
| `a9fcbfff7` | Bush trucks Leasing |
| `0c519f5f2` | SI Vallett Auto Sales |

(Heavy vehicle accounts with a committed 24–48 hr TAT.)

## 4. Segmentation model

For every row where `rb === 'QC Pending'`:

```
segment(row) =
  'heavy'       if row.eid ∈ HEAVY_IDS            // checked first — Heavy wins
  'onboarding'  else if stageOf(row) === 'onboarding'
  'pending'     otherwise                          // default "pendency" view
```

- `HEAVY_IDS` = Set of the 6 IDs above, defined at the top of the `<script>` with name
  comments (single-point edit).
- `stageOf(row)` = `(_entMap[row.eid]?.stage || row.entStage || '').trim().toLowerCase()`.
- Invariant: `count(pending) + count(onboarding) + count(heavy) === count(all QC Pending)`.

QC Hold is independent: `rb === 'QC Hold'`, unchanged.

## 5. View state → downstream

Replace the single `_activeStatus` with **`_activeView`** taking one of:
`'pending'` (default) | `'hold'` | `'onboarding'` | `'heavy'`.

Introduce one helper that returns the base slice for the active view; the existing
sub-filter chain (type, hour bucket, customer segment, hold reason) stacks on top
unchanged:

```js
function viewRows(){
  const v = _activeView || 'pending';
  if (v === 'hold') return _rows.filter(r => (r.rb||'').trim() === 'QC Hold');
  const pend = _rows.filter(r => (r.rb||'').trim() === 'QC Pending');
  return pend.filter(r => segOf(r) === v);   // v ∈ pending|onboarding|heavy
}
```

`f()` becomes `viewRows()` + the existing sub-filters. All render functions
(`renderHours`, `renderTypeCards`, `renderCharts`, `renderEntTbl`, `renderTeamTbl`,
drawer) already consume `f()` / a recomputed base, so they follow the active view with
minimal edits (swap the `_activeStatus||'QC Pending'` base for `viewRows()`).

Touch points for the rename/rewire:
- `_activeStatus` declaration → `_activeView`
- `f()`, `lbl()` / new `viewLabel()`
- `renderMetrics` → delegate card rendering to new `renderStatusCards()`
- `renderTypeCards` base → `viewRows()`
- `renderCharts` base → `viewRows()`; hold-reason click sets `_activeView='hold'`
- `toggleHoldFilter` → generalized `setView(v)`; overview card onclick → `setView('hold')`
- `resetAllFilters`, `anyFilterActive`, `processData`

## 6. UI

Replace the lone `#hold-card` with a 3-card container, unified via a new `.stat-card`
class whose accent is a `--sc` CSS variable (border, value color, active ring all derive
from it). Each card sets `--sc`, `--sc-border`, `--sc-bg` inline; JS only toggles `.active`.

| id | label | accent | value |
|----|-------|--------|-------|
| `hold-card` | QC Hold | red `--red` | `rb='QC Hold'` count (unchanged) |
| `onb-card` | Onboarding | amber `--amber` | QC-Pending onboarding count |
| `heavy-card` | Heavy & Exceptions | purple `--purple` | QC-Pending heavy count |

`setView(v)` toggles the view (re-click → back to `pending`), clears sub-filters, rerenders
— same reset behavior as today's `toggleHoldFilter`. The "Overview" tag reflects the
active view label.

Responsive: under ~900px the overview stacks and the 3 cards become a full-width 3-across
row.

## 7. Files touched

- `index.html` — markup (3 cards) + `.stat-card` CSS + `<script>` segmentation/view logic.
- `api/data.js` — **no change**.
- `.gitignore` — add `.DS_Store`. (No unused repo files to remove; all 4 tracked files are in use.)

## 8. Verification

Serve `index.html` locally, inject mock `_rows` via `processData()` covering: an
onboarding-stage enterprise, a Heavy-list enterprise, a normal pending enterprise, and a
QC Hold row. Confirm:
- The 3 card counts are correct and reconcile (pending+onboarding+heavy = all QC Pending).
- Clicking each card scopes hourly/type/charts/tables/drawer to that segment.
- Default pendency excludes onboarding & heavy VINs.
- QC Hold count is unaffected by the new segments.
- Re-clicking the active card returns to the default view; Reset Filters clears everything.

## 9. Out of scope

- Server-side segmentation (rejected — needs redeploy/creds for no functional gain).
- Any change to QC Hold semantics or the Metabase queries.
- Making the Heavy list editable from the UI (it's a top-of-file constant).
