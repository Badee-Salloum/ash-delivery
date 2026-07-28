# PROGRESS

## 2026-07-29 — upper-level override for a stuck shift (void + force-close) + a live-map fix

**All suites green (306 API tests incl. 4 new money-critical override cases + a new live-map case),
6 guards green, migration 0012 applied to Neon, API redeployed.** A driver can leave a shift open
forever (bike breaks, phone lost). `shift.approve` holders (branch manager + GM + sysadmin) now get
two escape hatches, and using them surfaced — and fixed — a live-map defect.

**Void (→ `cancelled`).** Reverses the float + top-up via the return recipes and discards the shift's
orders; for a shift that produced no real deliveries. Money nets to zero (driver + office funds back
to 0), every posted entry still balances. New terminal `cancelled` state + `manager_force_cancel`
action; migration 0012 adds the enum value.

**Force-close (→ `approved`).** Settles like a normal close using `postingsForApproval` over the
*computed* closing balances, then books any declared-vs-expected gap to a `shift_variance` cost
centre the driver still owes. Leaving a figure blank accepts the expected close (no variance) — this
is how an admin closes "without the needed data". A 10,000 cash shortfall books exactly 1,000,000
minor to variance; verified.

**UI.** Void + Force-close panels on «النوبات الجارية», gated `canApprove` (ar/en), force-close
takes an optional cash / wallet / odometer plus a recorded reason.

**Live-map fix (SRS K).** `/gps/live` returned the latest ping per driver with no shift-state filter,
so a driver whose shift had ended lingered on the map forever (gps_pings is append-only) — voiding
the real stranded shift left him stuck on the map. Now filtered to drivers whose latest ping belongs
to their **current live shift** (new `ShiftRepo.listLiveForBranch`); a ping from an already-ended
shift is dropped even if the driver has opened a fresh one that has not pinged yet.

**See it in 2 minutes.** Admin → «النوبات الجارية» → on a stuck open shift press **إغلاق قسري**
(force-close) or **إلغاء النوبة** (void); the row leaves the live set and, for void, its driver drops
off «الخريطة الحية». (In this session a real stranded shift — driver1, business date 2026-07-28 —
was voided through the deployed API; `/gps/live` went from one lingering pin to `[]`.)

---

## 2026-07-28 (later) — a testable platform: the 3 missing Bundle-1 UIs + live GPS tracking

**310 domain + 297 API + 63 driver + 21 client tests green, 6 guards green, migration 0011 applied
to Neon, all three projects redeployed.** An audit found three in-scope Bundle-1 sections were
backend-complete but had **no admin UI** — reachable only by raw API call. All three are now
screens, and live GPS tracking (SRS K) is built end to end, so the whole platform is manually
testable.

**F — tier admin.** The engine is money-critical (close pay resolves the configured rule) but a
sysadmin couldn't publish a table or flip whole/marginal, so close silently ran the default F-1
fallback. Now `Tiers.tsx` (sysadmin-only): list active/superseded tables, a bands editor (share as
%, converted to bps), effective-dated publish, withdraw, and the read-only what-if simulator
(per-driver Δ + company impact).

**G — expenses.** An entire priced section with no way to use it. Now `Expenses.tsx`: a create form
(category · cost-centre · vehicle · amount · description) gated to BM+GM, a date-range list + total,
and a sysadmin-only category manager.

**E-3 — manual entry + BR7 correction.** Folded into Treasury: a manual journal entry with a
fund/side/amount line editor and a live D-vs-C running total (bigint string math, never `Number()`
on money) that gates the post; and the visible dated reversal (`POST /journal/:id/reverse`).

**K — live GPS tracking.** While the shift is open the driver's phone streams its location: a
`use-gps-beacon` hook runs `watchPosition` + a Screen Wake Lock and POSTs the latest fix every **15
s** to `/shifts/:id/gps` (server stamps `received_at`, so a skewed phone can't rewrite when it was
seen). Migration 0011 adds `gps_pings` (audit-exempt telemetry); the manager watches a **Leaflet +
OpenStreetMap live map** (`/gps/live`, latest fix per driver, polled every 10 s). Foreground-only —
a PWA can't track in the background; true pocket/screen-off tracking is the deferred native-wrapper
or hardware-tracker route. `gps.view` (already in the matrix) gets its first consumer.

**Honest status.** GPS is foreground-only by the PWA's nature. The BR1-vs-Yallago-wallet calibration
(one real shift) and the production-hardening items (Neon guard run, MFA-at-rest, backups, A-4
ceilings) remain the next phase before relying on this for daily cash.

---

## 2026-07-28 — Section D: the D-3 loop finished, plus wallet (D-2) and order-list (D-1) OCR

**311 domain + 297 API + 63 driver + 21 client + 30 adapters tests green, 6 guards green, migration
0010 applied to Neon, all three projects redeployed.** Section D is Bundle-2/deferred; the assisted
on-device reader already over-delivered on the «drivers type, photos are evidence» bridge (D-5). This
round makes **D-3** real end to end and adds two readers the client's real screenshots unblocked.

**D-3 — «any manual edit is logged with its difference from the OCR reading» (acceptance #10).** The
BMS packs already captured that baseline (`ocr_raw`, preserved across retakes) but it was **never
shown**. Now a pure `ocrReadingDelta` (in `@ash/client`) drives an «مُعدّل يدوياً» badge + per-field
«OCR → confirmed» lines on the manager's review, for the BMS packs and — newly trailed — the start
odometer/battery, the close wallet, and each order fee. Migration 0010 adds the four nullable
baseline columns (`shifts.odo_start_ocr`/`battery_start_ocr`/`end_wallet_declared_ocr_minor`,
`shift_orders.fee_ocr_minor`); the odometer/battery are plain integers, the wallet and fee are money
that crosses the wire as decimal strings (wire-money guard clean).

**D-2 — wallet OCR at close.** Given the real Yallago wallet screen (76,509.55 SYP, white on orange,
Arabic-Indic digits), `readWallet` + a pure `parseWallet` pre-fill `walletDeclared` from the wallet
screenshot. The money 2-dp rule (a separator + 1–2 trailing digits is the fraction; grouping is
dropped) and Arabic-digit folding are pinned to that exact sample. String ops only — never `Number()`.

**D-1 — order-list OCR.** The «Recent orders» screen (owner-confirmed: the `NNN SYP` figure is the
delivery fee, BR1's number) is scanned by `readOrders`/`parseOrders`: it anchors each order on a
`NNN SYP` amount with the time on the same row, tracks the «Monday, 27 July» day headers, and drops a
row with no readable fee. A «مسح الطلبات» button on the order screen turns the screenshot into
pre-filled fee rows (auto key `YAL-YYYYMMDD-HHMM`, pay-mode = cash); the driver sets pay-mode, drops
other-day rows and confirms — the existing dup detection, live BR1 preview and submit path unchanged.
The screen carries no order-id or pay-mode, so those stay the driver's; OCR fills only the fees. This
activates the long-dormant `shift_orders.source` seam and adds the fee's D-3 baseline, so a silently
lowered OCR'd fee is now visible to the manager.

**Honest status.** The parsers are pinned to the owner's real screenshots; on-device *recognition*
accuracy on live phones is still the manual calibration the SRS D-4 asks for — the readers degrade to
manual entry on any failure, exactly as D-5 guarantees. Only the wallet + «Recent orders» samples
exist, so odometer/dashboard recognition calibration, per-field confidence (D-4) and server-side OCR
stay out of scope.

**See it in 2 minutes**

```bash
pnpm check
pnpm --filter @ash/driver test -- ocr.test.ts     # parseWallet + parseOrders on the real samples
pnpm --filter @ash/api test -- ocr-trail.test.ts   # the D-3 baselines reaching the review
```

---

## 2026-07-27 — Section C closed: the six modeled-but-unwired gaps in the shift cycle

**311 domain + 291 API + 56 driver + 15 client + 30 adapters tests green, 6 guards green, i18n 21
sections. No migration — every table already existed. Three projects to redeploy.**

Section C's happy path was fully built and tested; six things were modeled in the domain/DB but
never wired end to end (plus one new capability the product owner asked for). All six are now live,
each its own commit with `pnpm check` green.

**Tier at close paid the wrong rate — the single biggest money defect.** `approveClose` hardcoded
`DEFAULT_BANDS` and never called the resolver, so a published / per-vehicle-type / effective-dated /
marginal tier table had **no effect on real driver pay**. Now the configured rule is resolved by the
shift's vehicle type (`resolveTierRule`, sharing one `asDomainRule`+`ruleInForceOn` with the
simulator), and `alreadyPosted`/`trueUp` use that same rule — so a mid-day band crossing and both
whole/marginal modes settle correctly. Falls back to the F-1 default if none is in force, so the
default seed reproduces today's numbers (the canonical §2.3 and every lifecycle test stay green); a
published 50% table now genuinely pays 50%.

**The manager could not review the evidence.** The whole point of C-7 is matching ground photos to
numbers, but the review discarded the media ids. It now carries them, and the approval screen shows
the start/end photos inline with a click-to-enlarge lightbox.

**The manager could only approve.** No retake, no reject, no notes, no log — though the domain
transitions, the `requestRetake` string and the `shift_decisions` table all existed. Wired:
`request-rephoto` and `reject-close` return the shift to the driver with a logged, notified reason;
`approve` writes an `approved` row; the review shows the «سجل القرارات»; the driver sees WHY his
shift bounced instead of a silent reset.

**«معلقة» never triggered.** A manager now suspends a live shift for a mid-shift incident (C-1);
the driver resumes it from his phone, or it closes directly under the **same BR1** — a suspension is
never a way around the zero equation. The driver can't suspend himself (domain: `suspend` =
`shift.approve`), so he «بلاغ حادثة» rings the branch bell and a manager acts. A new «النوبات
الجارية» panel is the manager's home for live shifts.

**No second float/top-up mid-day.** The tranche arrays and the
`(shift_id, event_type, occurrence_key)` idempotency existed, but funds were set once at open and
never appended — so cash handed over mid-day left the office with no ledger entry. Now a tranche
posts ONE balanced entry under its own occurrence key (`existingCount + 1`, never re-posting from
1); BR1's expected end cash/wallet move automatically because the equation sums the arrays.

**Manual orders (new).** A missing order is a cause BR1 ranks at close, but only the operating driver
could add one and only while `open`. Now a higher-level manager adds a manual order to reconcile a
shift through `pending_review` — which moves the orders hash, so the staleness guard forces a
re-review before approval — and a driver past the open window requests one via the branch bell.

**See it in 2 minutes**

```bash
pnpm check                 # 6 guards + every suite, no Docker
pnpm --filter @ash/api test -- suspend.test.ts tranche.test.ts decisions.test.ts manual-orders.test.ts
```

**Honest status:** all code + tests on the memory harness; the Pg paths reuse existing adapters
under the shared conformance suite. Not yet exercised against Neon in this batch, and the live-shift
manager flows (suspend, tranche) have not been clicked through a browser here.

---

## 2026-07-23 (latest) — the BMS reader: a profile per battery, and two confirmed faults fixed

**309 domain + 246 API + 27 driver tests green, 6 guards green, migration 0008 applied, all three
projects redeployed.**

The diagnostics added the round before paid for themselves immediately: the driver's phone reported
**two different failures**, and they were two different faults rather than one mystery.

**«تعذّر تشغيل القارئ» — the reader died once and was never rebuilt.** `getWorker()`'s catch only
ever covered *creation*; once created, the cached promise stayed resolved for the whole session, so
a worker killed later by a wasm abort or an OOM was handed out again on every call and OCR reported
`unavailable` **forever**. Pressing «إعادة القراءة» could not recover it. The worker is now
terminated and dropped on any failure — including a timeout, which leaves it chewing on an
abandoned job — and rebuilt once automatically.

**«لم نتعرّف على أي حقل» — the Arabic app is a CARD GRID and the parser could only read a list.**

```
   81.48V        0A        0.00W       1        ← one recognised line
إجمالي الجهد    التيار      الطاقة     الدورات    ← the next
```

The label and its value are never in the same cell there, so «الدورات» and «إجمالي الجهد» found no
number at all. `parseBms` now takes real line boxes and pairs a caption with the value on the line
**above** it by column overlap, which reads the cards and leaves the inline English table working
unchanged. The screenshot is also white text on saturated cyan, and Tesseract thresholds before it
recognises — `prepareForOcr` converts to luminance and stretches the 5th–95th percentile, which
pulls those apart and leaves an already-black-on-white page untouched. `PSM 3` now leads: a card
grid with a gauge and a nav bar is not the uniform block `PSM 6` assumes.

**A profile per battery**, at the product owner's direction. The packs do not ship with the same
app and the apps agree on nothing, so a battery records which one it uses: `BMS_PROFILES` in the
driver app owns the label spellings, layout rule and segmentation; `batteries.bms_profile`
(migration 0008 — TEXT and unconstrained, so a new profile needs no migration) records the choice;
the admin fleet screen has a picker. `NULL` means `auto` — every label, both layouts, both modes —
which works but is the slowest and least certain path.

**One more bug, caught by the new tests rather than in production:** with three labelled values on
one line (`MOS: 36.9℃  T1: 33.7℃  T2: 33.6℃`) the number search started at the beginning of the
cell, so T1 read 36.9. It now cuts at the label and looks forward, then backward for the RTL case —
and it cannot simply delete the label first, because with spaces stripped «t1» and «33.7» fuse into
`t133.7`.

Also shipped: **«ما قرأه النظام»**, a collapsed disclosure under a failed read showing the text the
reader actually produced. Any future report of "it didn't fill" now arrives as a diagnosis.

**Honest status:** this is the third round on the BMS reader, and on-device OCR of a coloured,
right-to-left, card-grid phone UI is at the hard end. Manual entry of all eight figures works and
the screenshot is the evidence either way — which is exactly what SRS D-5 guarantees.

---

## 2026-07-23 (latest) — a driver could never finish a shift

**309 domain + 246 API + 15 driver tests green, 6 guards green, all three projects redeployed.**

Reported as "stuck on the vehicle picker". It was three stacked defects, two of them total blockers
on the core flow — together they mean **the driver app had never been able to complete a shift end
to end in production.**

**1. The driver polled an endpoint he is forbidden to read.** After submitting his start package
the app polled `GET /shifts/:id/review` every 4 s waiting for the manager. That route is
`shift.approve` — branch manager, sysadmin, GM; **never `driver`**, who holds only `shift.operate`
at scope `own`. Every poll was a 403, the client swallowed it, and the phone sat on
«بانتظار اعتماد البداية» forever: the manager approved, the shift really opened server-side, and
the driver never found out. He could never record an order or close a shift.

The root cause was structural — of every shift route, `shift.operate` reached **only writes**.
There was no endpoint at all by which a driver could read the state of his own shift. Now
`GET /shifts/:id/state`, scoped by the existing `shiftSubject` so `own` means his and nobody
else's. It deliberately carries no BR1 causes: that ranked diagnosis is the manager's approval tool
(BR8). Both screens are now built from one shared snapshot so they cannot drift apart about what a
shift contains.

**2. A live shift was never resumed.** `/me/assignment` has always reported `liveShiftId` and
`liveShiftState`; **nothing read either**, and `StartPackage` could only ever *create*. So a driver
who closed the app, refreshed, or was thrown out by the 403 loop came back to a picker whose every
option `createShift` refuses with `driver_already_on_shift` — his shift existed, held its bike, and
was unreachable by the one person who could finish it. The app now resumes: the phase is derived
from the live state, and the evidence, odometer, the manager's float/top-up and the orders already
recorded all come back.

**3. His own shift made his own bike look taken.** `busy` ignored whose shift it was, so the driver
was told «على نوبة الآن» about his own bike with no way to tell and nothing to do. Now `busyByMe`,
and when every bike genuinely is out the screen says so instead of offering buttons that do
nothing.

Also: **a driver may discard his own shift while it is still `draft` or `awaiting_open_approval`**
— nothing has posted to the ledger at those states, and without it every stuck driver waits for
someone at the office. From `open` onward it stays manager-only, enforced by the same `cancelShift`.

And order entry survives a resume: `provider_order_no` is **globally unique**, so a retyped order is
a 409 — and `submitOrders` had **no catch at all**, so one rejection took the promise down, the
phase never advanced, and «تم» silently did nothing. It now posts only what is new and names what
would not save.

---

## 2026-07-23 — the fleet is modelled as machines, not as rows called "vehicle"

**309 domain + 229 API + 15 driver tests green, 6 guards green, migration 0007 applied to
production, all three projects redeployed.**

The schema described a *vehicle* but not a **machine**. It could not say where a bike sits in the
organisation, could not say that it carries two battery packs, and had nowhere to put what the
driver reads off a pack.

**«رقم الآلية»** is now `<governorate>-<branch>-<type>-<machine>` — the first motorbike of the
first branch in Damascus is `1-1-1-1`. Governorate did not exist anywhere in the repo; branches had
a text code but no number; `vehicle_types` had neither, and no route, no port method and no UI.
`vehicles.code` becomes the **written** result of `formatVehicleNumber` — deliberately not a
generated column, since the expression reaches across `branches` and `governorates`, the same
reason `business_date` is written. Renumbering a type restates every one of its vehicles' codes in
one transaction, which is why `vehicle_types` moved from `AUDIT_EXEMPT` to audited.

**Battery packs are rows, not columns.** They are the expensive consumable, they move between
bikes, and the BMS app shows a serial. How many packs a bike carries is `COUNT(*)` of the packs
fitted — never a number someone typed, so it cannot disagree with reality, and the BR5 gates read
the same fact: a two-pack bike cannot open or close on one screenshot.

**Per-shift BMS readings** hold percent, pack voltage, cycle count, capacities and three
temperatures per pack per end of the shift, as scaled integers (millivolts, deci-Ah, deci-°C),
never floats. `ocr_raw` keeps what the OCR read before correction, which is what finally makes
**SRS D-3** — the manual edit *and its difference from the OCR reading* — computable.

**Three things were already broken, and are fixed:**

1. **Adding a vehicle was impossible in production.** The console sent the literal string
   `'e_motorbike'` for a `uuid` foreign key (Postgres `22P02`), the UI swallowed the 500 and
   cleared the form as if it had worked, and the production bootstrap never created a
   `vehicle_types` row at all — that insert lived only in the demo seed, which refuses to run
   against production. No test caught it because the test adapter is a `Map` with no foreign keys.
2. **The end-of-shift battery was never gated**, and a blank field reached the server as
   `Number('') === 0` — "the driver did not answer" was indistinguishable from "the pack is flat".
   The manager was never shown it either.
3. **OCR was being fed the compressed image.** `compressImage` caps the long edge at 1280 px and
   drops quality to 0.4, putting a screenshot's body text under the LSTM's recognition floor. That
   was the single largest accuracy lever in the whole feature, and it sat upstream of every
   Tesseract parameter. Also fixed while there: a cached *rejected* worker promise that disabled
   OCR for a whole session after one transient failure; a 20 s timeout that exceeded the SRS's
   15 s budget and never cleared its timer; and `compressImage` returning its **largest** encode
   whenever the 300 KB budget was unreachable.

The BMS reader is genuinely hard and the tests say so: the English app is two-column, so one row
carries two label/value pairs; the Arabic app prints the value *before* its label; and several
labels carry a digit of their own — «Battery T2: 32.5C» was being read as 2 °C until the value was
taken from what remains after removing the label.

**Still open:** OCR accuracy on real phones is a calibration question no unit test answers. The
parser is pinned against transcriptions of both apps; the recognition itself needs a morning with
real screenshots on real drivers' handsets.

---

## 2026-07-23 (later) — the two roles that own the business could not use the app

**207 API tests + 290 domain green, 6 guards green, redeployed.**

Reported as "the dashboard is stuck on جارِ التحميل and there is nowhere to add a deposit". One
root cause, much wider than the screen.

The GM and the system admin have `branchId === null` **by design** — the §3 matrix grants them
scope **'all'**, so the session deliberately cannot pick a branch for them. But every branch-scoped
route read the branch from the request **body**, and a GET has no body. Scope 'all' was therefore a
permission nobody could exercise: `/dashboard`, `/drivers`, `/vehicles`, `/assignments`, `/shifts`,
`/treasury/balances`, `/documents/expiring` and `/expenses` all answered 422 `branch_required` to
exactly those two roles — which, on a fresh production install, are **the only two accounts that
exist**. Authorization said yes; the handler said no.

The console hid it: a failed fetch left state `null`, the same value as "not fetched yet", so the
screen rendered "loading" forever and the real HTTP error never surfaced.

**Worse, found by the same sweep:** `week.close` is system-admin-only, and a system admin never has
a branch — so **BR7's Sunday close was unperformable by any real account**, the moment a week's
entries become immutable. `closeWeekRequest` had no `branchId` field either, so not even a body
escape hatch. The console rendered the refusal as *silence*: the catch stored the error but the JSX
knew only `weekStart` and `blockers`, so an error carrying neither fell through to `null`.

**The suite was green throughout** because every test in `week-close.test.ts` seeded a system admin
*with a branch* — a shape `bootstrap.ts` and `POST /users` both refuse to create — and said so in a
comment. That is the failure mode worth remembering: a test that constructs an impossible actor
proves nothing about the system that exists.

Fixed: one `branch-scope.ts` resolver reading `?branchId=` as well as the body (replacing five
near-identical copies); the RBAC subject is what the caller *asked for*, so a branch manager
reaching across the fence is refused rather than quietly served his own; a branch picker in the
admin side rail for organisation-wide roles; screens show the error and a retry, and refetch on
branch change; the treasury states *why* the system admin has no deposit box rather than rendering
an empty card. 17 new tests, one per endpoint in both directions, plus four pinning the real
production-shaped admin through the Sunday close.

---

## 2026-07-23 — bikes are assigned, not chosen; and a stranded bike can be released

**190 API tests + 290 domain green, 6 guards green, all three Vercel projects redeployed.**

The driver no longer picks his bike from a menu. The branch manager binds driver ↔ vehicle for a
business date (SRS B-3 / س34) on the fleet screen; from then on `/me/assignment` returns that bike
alone, and `createShift` refuses any other. A bike assigned to somebody else is off limits even to
an unassigned driver. Where no assignment exists the old free choice still stands, so a branch that
has not started assigning is not locked out of its own shifts — the rule is enforced server-side,
because a driver with the API can post any vehicle id.

The `assignments` table has existed since migration 0003, with both UNIQUE constraints, and had
**zero code references**. This wires it end to end.

**The trap it exposed.** A driver who backs out of the start screen leaves a shift in `draft`. That
shift still holds its bike, and a draft shift notifies nobody — so the bike became unusable for the
rest of the day with no route back short of a DBA. Now: `DELETE /shifts/:id` releases it, refuses
anything from `open` onward (money may already have posted), and is audited; `GET /shifts` surfaces
the stranded shift the approval queue never sees; and the fleet screen shows a **release** button on
exactly those vehicles.

Also: the treasury nav read «الجرد اليومي», which hid the branch cash box + wallet deposits behind a
label about counting. Renamed to «خزينة الفرع».

**Still open:** approval ceilings per role (A-4) and attendance (B-4) — both tables exist, neither is
wired. OCR accuracy still needs calibrating against the client's real dashboard photos.

---

## 2026-07-21 (later) — Phase A + B complete: Bundle 1a is feature-complete

**471 tests + 6 CI guards green, both front-ends build.** See [STATUS.md](STATUS.md).

**Phase B — the remaining backend**
- Tier admin (F-3…F-6): effective-dated publishing that supersedes rather than deletes, band
  validation at publish time, and a what-if simulation that reads-only (a test asserts the ledger
  is untouched after simulating).
- 2FA / TOTP (§7): RFC 6238 verified against the spec's own vectors, the deterministic parts pure
  in the domain with the HMAC injected. Password → code; an enrolled admin is blocked from every
  permissioned route until the second factor clears.
- Notification bell (A-6), branch-addressed and dedupe-keyed.
- The minimal ops dashboard (I-1), with total profit a GM-only endpoint.

**Phase A — the front-ends**
- `packages/client`: the typed API client, i18n catalogs (ar default + en, parity type-enforced),
  and the order-entry model — duplicate detection, one-tap mode cycling, and a live BR1 preview
  that reproduces the §2.3 numbers. All tested without a DOM.
- Driver PWA: RTL-first, 70 KB gzip, prompt-mode service worker. The order-entry screen with its
  live BR1 footer, and camera capture that compresses to ~300 KB and retries idempotently.
- Admin console: 2FA login, the C-7 approval review (BR1 panel pinned first with ranked causes,
  start-vs-end odometer compare), the dashboard, fleet CRUD, and treasury (cash count + close).
- Two new guards, both negative-tested: physical-CSS (RTL logical properties only) and i18n parity.

**What's left** is operational, not code — the go-live checklist in STATUS.md. The one caveat
worth repeating: the UIs typecheck and build but have not been run in a browser here.

---

## 2026-07-21 (late) — Bundle 1a backend complete

**415 tests green, no Docker.** See [STATUS.md](STATUS.md) for the full picture.

Every SRS section in Bundle 1a now has working, tested endpoints — 34 of them. All twelve ports
have both an in-memory and a PostgreSQL implementation, proven by one shared conformance suite.

**Closed this session**

- **Photo evidence (C-6)** — was entirely absent. Real upload, content-addressed dedupe,
  magic-byte sniffing, RBAC-checked serving. Critically, the BR5 gates now read *uploaded media*
  rather than a list of slot names the client asserted.
- **The last three PostgreSQL adapters**, so the API can actually run against a database.
- **Fleet management (B)** — drivers, vehicles, documents, expiry board.
- **Expenses (G)** — an entire priced section that was at zero.
- **Cash count (E-5) and manual entries (E-3)**, completing section E, and the Sunday close now
  actually verifies every day was counted.
- **Vercel + Neon deployment path**, with a durability guard that refuses to boot production
  against storage that would lose evidence on redeploy.

**Six bugs the tests found**, each invisible to reading — see STATUS.md. The two worth repeating:
a manual entry naming `office_cash` moved nothing at all, and the API could not start because
TypeScript parameter properties are not strippable by Node while every test passed.

**Next, in order**

1. Send `docs/client-request-samples.md` — still the highest-value hour in the project.
2. Prove `verify-guards.sql` against Neon (run against stock Postgres 17, not Neon).
3. Choose object storage for evidence photos.
4. Build the two front-ends (~7 days). Nothing can be *used* until then.

---

## 2026-07-21 — deployable backend: Postgres adapters, Docker, release pipeline, seed

**319 tests green, ~4 s, no Docker needed on this machine.**

| Package | Covers | Tests |
| --- | --- | --- |
| `domain` | money, BR1, tier, ledger recipes, shift gates, RBAC, dates, FX, week close, fleet | 260 |
| `adapters` | port conformance, in-memory | 10 |
| `db` | port conformance, PostgreSQL | *skipped locally, runs in CI* |
| `api` | lifecycle over HTTP, auth/RBAC, config, seed guard | 49 |

**What became real since the last entry**

- **PostgreSQL adapters + migration runner.** Held to the *same* conformance suite as the
  in-memory ones — a behaviour that differs between the two is a bug in one of them, and a shared
  suite is the only place that surfaces. The load-bearing line is the int8 → `BigInt` parser:
  node-postgres returns bigint columns as strings by default and other drivers return Numbers,
  which silently loses precision above 2^53. `assertBigIntParser()` proves at boot that it took
  effect, and a `numeric` column reaching the driver throws rather than handing back a lossy float.
- **The migration runner** is forward-only, one transaction per file, advisory-locked so two
  replicas starting together cannot both migrate, and it **refuses** if an already-applied
  migration's checksum has changed — the database and the repo disagreeing about history is not
  something to paper over.
- **Production deployment**: Dockerfile (Node 24, runs as `node`, healthcheck on Fastify's own
  `/health`), two-project compose so staging cannot reach production data, Caddy with same-origin
  `/api` and a self-only CSP, and a release pipeline that runs the full PR gate first, pins by
  **digest** not tag, takes a pre-migration dump, smoke-tests, and rolls back automatically.
- **The demo seed** is the SRS §2.3 shift posted through the *same recipes the API uses*, and the
  CLI asserts the resulting BR1 difference is exactly zero — the demo data proves itself.

**A real crash-on-boot the tests could not have caught**

The server would not start: Node runs TypeScript in strip-only mode and cannot erase **parameter
properties** (`constructor(private readonly x: T)`). Nine of them across three packages, all
failing at *load* time — i.e. a crash-looping container on deploy, with 33 API tests passing the
whole time. Running the thing is not the same as testing the thing. Fixed, and
`scripts/check-strippable.mjs` now gates the repo.

**Four guards, all negative-tested** — domain purity, SQL statics, wire-money, strippability. Each
was verified to actually fail on an injected violation, because a guard nobody has watched fail is
decoration.

**What is NOT done**

1. **No UI.** Neither the admin console nor the driver PWA exists. The API is driven by HTTP calls
   today, so there is nothing a driver or branch manager can log into.
2. **Nothing has touched a real database or a real server.** The migrations, their guards, and the
   entire deploy pipeline are written and unexecuted. CI proves the first two on the first push.
3. **The client samples are still unsent** (`docs/client-request-samples.md`), and BR1's calibration
   still depends on them.

**To deploy, I need from you**

- The GitHub repo URL (to push, and to let CI prove the database guards).
- VPS host + SSH key, and the domain names for staging and production.
- Backblaze B2 (or equivalent) credentials for restic, plus a repository password held separately
  from the SOPS age key.

---

## 2026-07-21 — M0/M3: the API, and the §2.3 shift running over real HTTP

**Done and VERIFIED — 293 tests, ~3 s, still no Docker**

The whole shift lifecycle now runs end to end through the actual HTTP surface a driver and a
branch manager will use. `apps/api/test/lifecycle.test.ts` drives the client's own §2.3 example:
float 100,000 + top-up 50,000 → 20 orders (12 cash / 6 electronic / 2 free) → close at 160,000
cash and 70,000 wallet → «الفرق: ٠» → manager approves → the ledger shows Yallago 20,000, driver
40,000, company 40,000, `fee_earned` closed to zero, and both driver funds back at zero.

This works without a database because every dependency is a **port**:

- `packages/contracts` — the port interfaces and the Zod wire schemas.
- `packages/adapters/memory` — in-memory implementations that enforce the *same* invariants the
  database does: the `(shiftId, eventType, occurrenceKey)` idempotency key, the double-entry
  balance check, and the global uniqueness of `provider_order_no`. They are not stubs that
  always say yes, so a test passing here is testing real behaviour.
- `apps/api` — Fastify, with the PostgreSQL adapters dropping in later one file at a time.

**Security properties now enforced at the HTTP layer**

- Sessions are opaque and DB-backed, 30-minute *idle*-sliding — tested by advancing the clock
  past the window, and by polling every 29 minutes to prove a manager mid-review is not kicked out.
- Account locks after exactly 5 failed attempts, and even the correct password is then refused.
- **The lockout write is audited with `actor_kind='anonymous'`** — it happens on the
  unauthenticated path where no actor exists, and a trigger that raised there would make the
  lockout impossible to implement and turn every failed login into a 500.
- Login failures are indistinguishable between "wrong password" and "no such user", including a
  dummy hash comparison so the response time does not enumerate usernames.
- **Every route declares the permission it needs, and the app refuses to boot if one forgot.**
  A test asserts the public list is exactly `/health`, `/me`, `/auth/login`, `/auth/logout`.

**A third guard, negative-tested like the others**

`scripts/check-wire-money.mjs` — money crosses HTTP as a decimal string, never a JSON number.
`JSON.stringify` throws on a bigint and the tempting fix is `Number(amount)`, which is the single
most likely way a defect ever enters this system. The guard bans `z.number()` on money-shaped
fields, `Number(...)` on money-shaped identifiers, and `parseFloat` outright. Verified to fail on
an injected violation, then pass again.

**Notable behaviours proven over HTTP**

- Approving twice does not double-post — the state machine refuses, and the idempotency key would
  have stopped the postings even if it hadn't.
- A stale `reviewedOrdersHash` returns **409**, so approval cannot land on numbers nobody reviewed.
- A non-zero BR1 returns **422** *and* names the likely cause; no `share_split` is written.
- The pay-mode blind spot survives the round trip: difference `"0.00"`, `cashDifference`
  `"5000.00"`, `walletDifference` `"-5000.00"`, cause `pay_mode_misclassified`. Advisory lets it
  through, strict blocks it.
- A duplicate Yallago order number is caught as it is typed (409).
- A branch manager reaching another branch gets 403 `outside_branch`; a driver touching another
  driver's shift gets 403 `not_owner`.

**Next**

1. **Send `docs/client-request-samples.md`** — still the highest-value hour in the project.
2. Swap the in-memory adapters for PostgreSQL ones (`packages/db`), which also runs the guard
   harness for real. This is the step that needs Docker.
3. The two front-ends: the admin console and the driver PWA.
4. bcrypt for the production hasher (the port exists; only the test implementation is wired).

**Still true, and worth repeating:** no UI exists, and the SQL migrations have never been
executed. What is real is the arithmetic and the HTTP contract.

---

## 2026-07-21 — M0 in progress: RBAC, schema, and the guard harness

**Done and VERIFIED** (green on this machine)

- **RBAC as data** — `packages/domain/src/rbac/can.ts`. The SRS §3 matrix is stored as grants
  (A-2 requires it be sysadmin-editable), evaluated by a pure `can(actor, permission, subject)`.
  The test transcribes the Arabic table a *second* time, independently, and sweeps every role ×
  every permission: **93 tests**, so the grant table is checked against the spec rather than
  against a copy of itself. Scope handling denies rather than widens — a branch-scoped grant
  checked against a subject with no branch returns `subject_missing_branch`, not everything.
- **Static SQL checker** — `scripts/check-sql.mjs`, 8 rules, **negative-tested**: an injected
  migration with every violation produces exactly 7 findings, then passes again once removed.
  It catches the CHECK-subquery bug the design review found in unverified DDL, money declared as
  a float, `STABLE` expressions in generated columns, `date_trunc('week')`, an idempotency index
  missing `occurrence_key`, an undeferred balance trigger, and any table that is neither
  consciously audited nor consciously exempt.
- **158 tests green in ~870 ms**, no Docker. `pnpm check` runs typecheck + domain purity + SQL
  checks + tests in one command.

**Done but NOT VERIFIED** (written without a database — say so out loud)

- **Six SQL migrations** covering SRS A, B, C, E, F, G: 36 tables, 18 audited, 18 consciously
  exempt with stated reasons. **None has been executed.** This machine has no Docker and no
  `psql`; every migration file says so at the top.
- **`packages/db/verify-guards.sql`** — the proof harness. It attempts every illegal write and
  fails if the database *allows* one: unbalanced entry, `app_user` UPDATE/DELETE on the ledger,
  a Monday week start, a locked-week edit to an entry *and to a line*, a duplicate posting, a
  second float tranche (which must SUCCEED), and an actorless audit write.
- **CI** (`.github/workflows/pr.yml`) runs the migrations against a real Postgres 17 service and
  then the harness — **so the guards get proven on the first push**. It also drops a trigger and
  asserts verification then fails, because a harness that cannot fail is decoration.
- `scripts/db-verify.sh` does the same locally in one command, `RUNBOOK.md` §1 has the procedure.

**Two bugs I found reviewing my own SQL** (both would have failed on first run)

- `ROLLBACK` inside a `DO` block that has an `EXCEPTION` handler is illegal in plpgsql.
  Transaction control moved to the psql level around each block.
- The week-lock trigger used `COALESCE(OLD, NEW)`, which made sealing **order-dependent**:
  `fin_seal_week()` stamps `week_lock_id` onto entries *before* setting `closed_at`, so a
  NEW-based check would pass or fail depending on statement order. Now `OLD` only.

**Also done and VERIFIED — the ledger and the shift gates**

- **Posting recipes** (`ledger/recipes.ts`) — pure and balanced. All three payment modes share
  one shape: `order_fee` debits whichever asset received the fee, `yalago_cut` always debits
  `yalago_share` and credits the wallet (BR2's instant deduction), and `share_split` closes the
  whole of `fee_earned` into driver + company + Yallago. It balances *by construction*, because
  `splitBlock()` already guarantees the three shares exhaust the fee total exactly — acceptance
  criterion #5 falls out of the arithmetic instead of being checked afterwards.
  The §2.3 example now walks the ledger end to end and lands on 20,000 / 40,000 / 40,000 with
  `fee_earned` closing to zero and both driver funds at zero after the daily returns.
- **Shift state machine** (`shift/state.ts`) — BR5's two gates as pure transitions, 30 tests.
  Every refusal carries a machine-readable reason and package gaps come back as a *checklist*,
  not a boolean. Covers: the driver's confirmation as the first signature and the manager's as
  the second, re-shoot requests, `suspended` closing under the same equation, the
  `br1_split_gate` advisory→strict switch, the orders-hash check that stops an approval landing
  on numbers nobody reviewed, and RBAC on every transition.
- **210 tests green in ~1.0 s**, still no Docker.

**A real bug the property tests found**

The random-event-stream property failed with `driver_wallet` at −1. Every cash order takes 20%
*out* of the wallet while putting nothing in, so a thin top-up plus many cash orders drives it
negative — twenty 5,000 fees against a 1,000 top-up leaves −19,000. My first `walletReturn`
skipped the posting when the balance was negative, silently leaving money unaccounted for.

This is the negative-wallet scenario the design review flagged as a blocker, reproduced
independently by a generator. Two consequences: the return posting now runs the other way (the
office covers the shortfall, the fund still lands on zero), and `minWalletBalance()` is a
**separate** check — because **BR1 evaluates to exactly zero throughout**, so the zero equation
genuinely cannot detect it. Logged as A-26, and it raised a new question for the client.

**Also done and VERIFIED — FX, week close, fleet rules**

- **Daily FX** (BR6, AC #6) — rates stored as SYP *minor units per USD*, because USD-per-SYP is a
  fraction and there is no honest way to hold a fraction in an integer. Conversion is half-up
  because it is a display figure only; the ledger is SYP minor units end to end. A missing rate
  carries forward flagged `provisional` rather than failing — a broken cron must never freeze the
  business — and the Sunday close then refuses to seal a week that still contains one.
- **Sunday-close pre-flight** (BR7, AC #9) — reports *every* blocker at once rather than one
  refusal at a time. Closing on Sunday the 26th seals the 19th–25th; a shift worked on the 26th
  belongs to the new week. The Yallago reconciliation gate reports `deferred_to_bundle_2` instead
  of silently reading as satisfied.
- **Fleet rules** (B-1/B-2/B-3) — expiry alerts fire once per threshold (T-30/14/7/0), not daily
  for a month; an *expired* document blocks assignment, one merely expiring does not.

**Where the domain stands**

| Module | Covers | Tests |
| --- | --- | --- |
| `money/` | minor units, residual 80% block, exhaustive split | 10 |
| `br1/` | the zero equation, split components, cause breakdown | 14 |
| `tier/` | bands, whole + marginal, day true-up, effective dating | 27 |
| `ledger/` | posting recipes, balance invariant, corrections | 22 |
| `shift/` | BR5 gates, state machine, RBAC on transitions | 30 |
| `rbac/` | the SRS §3 matrix as data | 93 |
| `time/` | Damascus business dates, Sunday weeks | 14 |
| `fx/` | daily rate, carry-forward, USD equivalence | 11 |
| `week/` | close pre-flight, lock coverage | 15 |
| `fleet/` | document expiry, vehicle state, assignment | 24 |
| | **total** | **260 in ~1.3 s** |

**Next**

1. **Send `docs/client-request-samples.md`.** Still the highest-value hour in the project. It now
   carries a second question: what does Yallago do when its 20% cut exceeds the wallet balance?
2. `./scripts/db-verify.sh` — install Docker, or just push and let CI prove the guards. Until that
   runs green, every claim in `packages/db/migrations/0006` is unproven.
3. `packages/contracts` (Zod + ports), then `apps/api` with the route-permission registry and
   its boot-time completeness assertion, then the admin/driver shells.
4. The photo-legibility spike, once a real dashboard screenshot exists.

**Honest status against the plan:** the *arithmetic* of Bundle 1 is done and green — M2's and
M3's hardest logic both exist as pure, tested code. What does not exist yet is anything a human
can log into: no API, no UI, no running database. M0's "log in as four roles" demo is not
reachable yet.

---

## 2026-07-21 — Day 1 (pre-M0): the money core

**Done**

- Read SRS v1.0 and the kickoff brief in full. No blocking brief-vs-SRS conflict; ~16 binding SRS
  details the brief omits are captured in the plan.
- Stack chosen and approved: TypeScript / Fastify 5 / PostgreSQL 17 / Drizzle / React 19 + a
  separate driver PWA / Vitest + fast-check. Four independent proposals, three judges.
- Seven product decisions confirmed and recorded in `CLAUDE.md` and `ASSUMPTIONS.md`.
- **`packages/domain` is written, pure, and green — 65 tests, 732 ms, no Docker.**
  - `money/minor.ts` — branded `bigint` minor units (1 minor = 1/100 new SYP = 1 old lira)
  - `money/allocate.ts` — the residual 80% block, `yalagoCut`, exhaustive `splitBlock`
  - `br1/equation.ts` — BR1 with `cashDiff` / `walletDiff`, not just the scalar
  - `br1/diagnose.ts` — ranked cause breakdown with distinguishable arithmetic signatures
  - `tier/rules.ts` + `tier/split.ts` — band validation, whole + marginal, day-level true-up
  - `time/civil.ts` — Asia/Damascus business dates, Sunday→Saturday weeks, no `Date`/`Intl`
- `scripts/check-domain-pure.mjs` enforces domain purity — and is **negative-tested**: it genuinely
  fails on an injected violation.
- `CLAUDE.md`, `ASSUMPTIONS.md`, `TESTS.md` written and current.

**See it in 2 minutes**

```bash
pnpm install
pnpm -r test                                  # 65 green
npx vitest run test/br1/canonical.test.ts     # the client's own §2.3 example, verbatim
node scripts/check-domain-pure.mjs
```

The canonical test reproduces the SRS §2.3 table row for row — end cash 160,000, end wallet 70,000,
230,000 == 150,000 + 0.80×100,000, difference zero — then splits it at approval into Yallago 20,000
/ driver 40,000 / company 40,000.

**Next**

1. **Send `docs/client-request-samples.md`** — one real shift's dashboard + wallet screenshots and
   the manager's counted ground truth. Blocking for M2; see Risks.
2. The two remaining Day-1 spikes: photo legibility at ~300 KB, and the three Postgres guards
   (deferred balance trigger, `REVOKE` on the ledger, locked-week rejection).
3. M0 — auth, RBAC-as-data, audit, i18n/RTL shell, CI, staging live.

**Risks**

- 🔴 **BR1 is measured against a number Yallago produces and we do not control.** If their wallet
  figure carries tips, promo credits, cancellation reversals, a pending/settled split, or a
  different rounding direction, every shift is unclosable on day one. Mitigation: get one real
  shift before M2; pilot with `br1_split_gate = advisory`; only then make the gate strict.
- 🟠 **The 19-day contract.** Realistic estimate is 40 days (merged plan) to 56 (independent
  review). Re-cut into Bundle 1a + 1b agreed with the PO — **still needs saying to the client in
  writing, this week.**
- 🟠 **The two screens nobody itemised** — driver order entry (20 rows typed on a cheap Android,
  twice a day, with OCR deferred) and the C-7 approval screen. ~2 days each, now budgeted in M3.
- 🟡 Local Node is 25.8; the project targets Node 24 LTS. `.nvmrc` pins 24 and `engines` warns.
  Harmless for the pure domain, but CI and the Dockerfile must pin 24.
- 🟡 Docker is not on PATH in this shell — needed for the M2 Testcontainers work and the DB spike.
