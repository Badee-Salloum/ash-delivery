# ASSUMPTIONS

Every default taken instead of blocking the product owner, per kickoff brief §7.5. Each row says
what was assumed, why, and **how expensive it is to reverse** — that last column is the one that
matters when an answer finally arrives.

**Reversal cost:** `cheap` = a setting or one data row · `moderate` = a migration or a recipe ·
`structural` = re-shapes the ledger or the equation.

---

## Confirmed by the product owner (no longer assumptions)

| # | Decision | Date |
| --- | --- | --- |
| D-1 | Financial week = Sunday 00:00 → Saturday 23:59 Asia/Damascus, closed the *following* Sunday. A shift worked on the closing Sunday belongs to the new week. | 2026-07-21 |
| D-2 | GitHub org, VPS and domain already exist → staging goes live in M0, not M6. | 2026-07-21 |
| D-3 | Old Syrian lira is schema-ready only; all Bundle-1 UI is new SYP + USD equivalent. | 2026-07-21 |
| D-4 | ~~The wallet is returned/zeroed each day exactly like the cash float.~~ **SUPERSEDED for unapproved shifts by D-13:** the full signed actual wallet balance is swept at every shift close. | 2026-07-21 |
| D-5 | ~~Manual entries and expenses: branch manager ✓ + general manager ✓, sysadmin ✗ (SRS §3 matrix over E-3 prose).~~ **SUPERSEDED by D-9.** | 2026-07-21 |
| D-6 | ~~Tier band computed over the whole day, with a visible day true-up restating earlier shifts.~~ **SUPERSEDED by D-13.** Retained only to reproduce already-approved history. | 2026-07-21 |
| D-7 | Commercial scope re-cut into Bundle 1a (SRS A–G, as priced) + Bundle 1b (production readiness, separately priced). | 2026-07-21 |
| D-8 | Pay mode is no longer collected at the driver's screen; `pay_mode` stays in the schema and on the wire defaulted to `cash`. | 2026-08-05 |
| D-9 | **The system admin holds every permission at scope `all`** — «اعطي صلاحية وصول لكل شيء لمدير النظام و صلاحية لفعل كل شيء», given twice. **Supersedes D-5** and amends BR8's visibility line. Sanctioned by SRS §3 / A-2, which make the matrix sysadmin-customisable with every change logged. `DEFAULT_GRANTS` seeds only a fresh database, so migration `0024` carries it to production, which was measured holding 11 of 16. The SRS transcription in `matrix.test.ts` is untouched; the deviation is the named constant `OWNER_OVERRIDE_2026_08_12` beside it. | 2026-08-12 |
| D-10 | **الترميم, الذمم, صندوق الشركة** — office capital remains a fixed target per box (`كاش المكتب 4,000,000`, `محفظة المكتب 1,000,000`) and historical الذمم remain part of restoration. ~~A new shift shortfall is refused by BR1 and may be carried as a receivable.~~ **SUPERSEDED by D-13:** the variance is settled with the employee immediately and creates no new receivable. | 2026-08-12 |
| D-11 | **نافذة عمليات النوبة** تبدأ من دقيقة اعتماد المدير للفتح وتنتهي بدقيقة تسليم الإغلاق، شاملتين، بحسب المنطقة الزمنية للفرع وعبر منتصف الليل. العملية ذات التاريخ/الوقت غير القابل للحسم تبقى مشمولة ومحذّرة، وتمنع الاعتماد حتى يتخذ المدير قراراً مسبباً ومدقّقاً. لا يستطيع السائق استبعاد عملية مؤكدة داخل النافذة. | 2026-08-14 |
| D-12 | **السطر السالب في «الطلبات الحديثة» حسم كاش مستقل**: لا يُعد طلباً ولا يدخل حصة يلاغو أو المحفظة، وتُطابق مشاهده الآلية بالتاريخ المطبوع عند توفره + الدقيقة + مبلغ OCR؛ المسار دليل إثراء فقط وليس هوية. ~~ما يتجاوز الحصة يصبح ذمّة، وسوالب سجل المدفوعات حركات محفظة.~~ **SUPERSEDED by D-13:** لا تنشأ ذمة جديدة، وسجل المدفوعات كله أرشيفي لا يدخل أي حساب. | 2026-08-14 |
| D-13 | **تسوية النوبة بالمحفظة والكاش:** كل نوبة غير معتمدة عند إطلاق القرار تستخدم حصة سائق ثابتة `floor(40% × أجور توصيل يلاغو المشمولة)` بلا شرائح أو تجميع يومي، وتضاف إليها حصص الطلبات اليدوية التي يحددها المدير. `الحصة الأساسية = الحصة الإجمالية − الحسومات النقدية`، و`الفرق = (الكاش الفعلي + المحفظة الفعلية) − المتوقع`، و`تسوية الموظف = الحصة الأساسية + الفرق`. يُحوّل كامل رصيد المحفظة الفعلي ثم يكون `الكاش إلى الفرع = الكاش الفعلي − تسوية الموظف`: الموجب استلام من الموظف والسالب دفع له. يستطيع الموظف طلب الإغلاق مع أي فرق؛ يحتاج اعتماد المدير إلى تأكيد تحويل المحفظة وتأكيد معاملة الكاش وسبب مدقّق عند فرق غير صفري. تُصفّر أرصدة كاش ومحفظة وحصة النوبة ولا تنشأ ذمة، وسجل المدفوعات اختياري وأرشيفي فقط. تستخدم المعاينة والاعتماد والإغلاق الاستثنائي الحساب نفسه، ويحميها `settlementHash` من اعتماد أرقام تغيّرت. | 2026-08-14 |
| D-14 | **اعتماد فتح النوبة مسبقاً:** يحدد المدير السائق وتواريخ محلية مخصصة ونافذة بدء شاملة لطرفيها في اليوم نفسه، مع مبلغ عهدة الكاش وشحن المحفظة. لا تلغي القاعدة حزمة البداية أو تأكيد السائق؛ بل تنفذ توقيع المدير المسبق عبر بوابة وقيود الفتح العادية، وتُستهلك مرة واحدة فقط وبذريّة مع حركة الأموال. | 2026-08-24 |
| D-15 | **حصة السائق من مال النوبة المعاد وليست من رأس مال الشركة:** عند الإغلاق يحتفظ السائق بتسويته أو تُدفع له من الكاش الفعلي المعاد، ويستلم المكتب المتبقي فقط. لا تنشئ التسوية حركة سحب من رأس مال الشركة ولا يحسبها الترميم كنقص رأس مال. هذا توضيح لـ D-13 لا استبدال له. | 2026-08-24 |

---

## Open assumptions

### Money and the equation

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-01 | **BR1 is fee-only.** Goods value does not appear in the equation, because for a cash order the driver pays the merchant out of the float and collects the same amount back, netting to zero. | SRS §2.1 states the round-trip explicitly for cash orders. | `structural` if the round-trip does not hold |
| A-02 | **The 80% block is a residual**, `Σfees − Σ(per-order 20% cuts)`, never `0.80 × Σfees`. | Even though variance no longer blocks close, multiplying the aggregate would manufacture a false employee variance. Proven by `allocate.test.ts` → "the naive formula really does diverge". | not reversible — this is correctness |
| A-03 | **Yallago floors its own 20% cut.** | We do not control this arithmetic; it happens inside their app. Rounding mode is a parameter (`yalagoCut(fee, rounding)`), not a constant. | `cheap` — one argument |
| A-04 | **The company absorbs every rounding remainder**, never the driver, never Yallago. | D-13 fixes the driver calculation at `floor(fees × 4,000 / 10,000)` and leaves the residual to the company. | `moderate` |
| A-05 | **م-3 — for electronic orders, the goods value round-trips to the wallet.** `goods_value_minor` and the per-order goods flags ship **inactive**. | The brief instructs isolating this behind a strategy seam. BR1 is fee-only under either branch *provided* the round-trip holds. | `cheap` — a setting, not a migration |
| A-26 | **A driver's wallet may legitimately go NEGATIVE, and the office covers the shortfall.** The full-wallet settlement action reverses to `fund` when the closing balance is below zero. | Every cash order takes 20% of its fee *out* of the wallet (BR2) while putting nothing in, so a thin top-up plus many cash orders can drive it below zero. BR1 alone cannot identify that position; D-13 requires an explicit signed wallet direction instead of blocking the employee's close request. | `moderate` |

### Historical tier engine — superseded for unapproved shifts

D-13 retires the tier editor, daily banding, and true-up for active settlement. A-06 through A-09
remain here only to explain and reproduce shifts approved before the fixed-share launch; they are
not selectable rules for a new or pending shift.

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-06 | **Marginal mode = each order is paid at the rate of its own ordinal position.** With a per-order-*count* band table and varying fees, no other reading is well-defined. | SRS F-2 keeps marginal as a config switch; the client's default is `whole`. | `cheap` |
| A-07 | **Free-delivery orders count toward the daily tier band** and earn a tier share. | SRS §2.1 gives all three modes the same "+80% of fee" net effect, so excluding free orders would make the tier basis inconsistent with the money. | `cheap` |
| A-08 | **A suspended shift completed on a later day is banded against its ORIGINAL business date.** | The driver did the work that day; re-banding it into a later day would corrupt both days' counts. | `moderate` |
| A-09 | **Tier tables are resolved with `status IN ('active','superseded')`.** | Filtering on `'active'` alone silently restates every historical day the first time the table is edited. | not reversible — this is correctness |

### Ledger and period control

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-10 | **Idempotency key = `(shift_id, event_type, occurrence_key)`**, overriding the kickoff brief's `(shift_id, event_type)`. | SRS C-5 permits multiple float/top-up tranches per day. Under the brief's key the second tranche cannot post and is silently swallowed — cash leaves the office unrecorded. **Escalated to the PO as a correction to the brief.** | not reversible — this is correctness |
| A-11 | **م-1 — the future accounting bridge aggregates at one daily entry per fund.** Unbuilt; recorded only. | Kickoff brief §7.6 instructs exactly this and says not to block. | `cheap` — section N is Bundle 3 |
| A-12 | **م-2 — opening balances are schema-ready and imported before go-live**, not during development. | SRS §10 says section E cannot go live productively without them; the file has not arrived. Added to M6's Definition of Done, with `Σ funds = 0` verified. | `moderate` |
| A-13 | **Funds creatable from settings are limited to `cost_center` type.** | A new fund that needs new *posting behaviour* needs a recipe, and a recipe is code. This is a real narrowing of SRS E-1's "add funds from settings without development", recorded so the PO sees it. | `moderate` |
| A-14 | **The Sunday-close pre-flight omits the H reconciliation gate** (SRS BR7/H-4 require zero-matching against the Yallago weekly PDF, which is Bundle 2). A permanently-satisfied placeholder check holds its place. | Section H is explicitly deferred. | `cheap` |
| A-15 | **A missing daily FX rate must never block posting.** The rate row is created by a race-safe lazy upsert in the posting path, not by a cron that can fail. | A failed 00:05 cron must not make the whole system unable to accept a write. | `cheap` |

### People, roles, scope

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-16 | **No driver salaries, advances or penalties.** Honoured by deliberate omission. | SRS B-1 / س35 / س38–40: the relationship is «نسبة فقط» — share only. Recorded so a future session does not "helpfully" add them. | `moderate` |
| A-17 | **The optional accountant role («محاسب») is seeded inactive** with an empty grant set. | SRS §3 and س77 name it for later. Seeding it as data means enabling it is a row, not a migration. | `cheap` |
| A-18 | **`shift_no` is capped at 2 by a setting, not by a DB constraint.** | SRS س23 says "up to two shifts daily", but a hard constraint would block a legitimate third shift on an exceptional day. | `cheap` |
| A-19 | ~~Tier editing is system-admin only.~~ **Historical only after D-13:** tier data remains readable to reproduce approved entries, while active editing and publication are disabled. | The old SRS §3/F rule is retained as provenance, not as an active permission. | `cheap` |

### Engineering

| # | Assumption | Rationale | Reversal |
| --- | --- | --- | --- |
| A-20 | **The no-float rule is scoped to money.** `double precision` remains legal for GPS coordinates, battery percentages and odometer readings. | Applying it dogmatically to physical measurements would be cargo-cult. | `cheap` |
| A-21 | **Asia/Damascus is UTC+3 year-round** (Syria abolished DST in October 2022). The offset is injected as a value, so pre-2022 backfilled data can still be handled correctly. | Keeps the domain deterministic and free of `Intl`. | `cheap` |
| A-22 | **A night shift's `business_date` is the date it OPENED.** A shift running 23:50 → 00:30 belongs to the opening day. | Keeps reporting and week ownership stable across midnight; operation inclusion itself uses D-11's timestamp window. | `moderate` |
| A-23 | **`provider_order_no` is globally unique**, not unique per shift. | It is Yallago's own key and doubles as the Bundle-2 reconciliation seam (SRS H-2, س17). Duplicate entry is a data-entry error worth catching immediately. | `moderate` |
| A-24 | **م-4 — the four real samples arrive mid-development.** Fake dashboard data and battery CSV live behind ports (`DashboardSource`, `BatteryFileParser`) so swapping the real ones in touches zero domain code. | Kickoff brief §5 requires exactly this. | `cheap` |
| A-27 | **Fleet management (creating drivers, vehicles and documents) is `fleet.manage`: branch_manager (own branch) + sysadmin + GM.** | The SRS §3 matrix has NO row for it. Guarding it with «إدارة المستخدمين والصلاحيات» (sysadmin + GM) would mean **nobody could create a driver**: both holders are organisation-wide roles with no branch, and a driver must belong to one. The person who onboards a driver is the branch manager who works with him daily. Stored as data. | `cheap` — one row |
| A-28 | **Organisation-wide roles must name a `branchId` explicitly on a fleet write**; branch-scoped roles may not name any branch but their own. | A GM has no branch, so defaulting would be a guess about where a driver works. | `cheap` |
| A-29 | **A driver cannot be deactivated, and a vehicle cannot leave `ready`, while a shift is live on them.** | Otherwise the shift and its required employee settlement are stranded. | `moderate` |
| A-25 | **Node 24 LTS is the target runtime**, though the current dev machine has Node 25. `.nvmrc` and the Dockerfile pin 24; `engines` warns on mismatch. | Node 24 is maintained to April 2028, covering the three-year horizon. Node 25 is not an LTS line. | `cheap` |
| A-30 | **Evidence photographs leave the country, and as of 2026-08-19 they go to a BROKER.** The screenshots carry real customer addresses, named businesses, metre-level GPS and Plus Codes. The path is now driver → Vercel (`iad1`) → **OpenRouter** → **Google `gemini-3.7-flash`**. **Owner-directed**, twice: «switch the ocr on our side… the ocr should run on the vercel so we shouldn't need to run vpn», then the 2026-08-19 decision to move to the measured reader. **The old mitigation does not transfer and was replaced, not inherited.** It used to read "the **paid** OpenAI API does not train on submitted content by default"; OpenRouter is an intermediary that fans out to upstream hosts with their own retention terms, so that sentence would have been false here. Two controls replace it, and they are NOT in the same state. **In code and verified:** every request pins `provider: { data_collection: 'deny' }` (`chat-completions.ts`). That is a real server-side control, not a hopeful field name — OpenRouter rejects a wrong value with `400 provider.data_collection: Invalid option: expected one of "deny"|"allow"`, checked 2026-08-21 — and it also constrains which upstreams may serve the request. **Owner action, NOT yet confirmed:** prompt logging/training must also be turned off on the OpenRouter account itself. Until someone confirms that setting, the account default applies to anything the request-level flag does not cover, and this row must not be read as saying the path is fully closed. Accepting that this excludes some upstreams was the owner's explicit choice. **Disclosed rather than buried:** the model-selection runs of 2026-08-17/18 sent all 66 corpus screenshots through OpenRouter BEFORE either control existed — `scripts/vision-bench.mjs` did not pin the denial until `4dc76ca`, and `provider` also constrains which upstreams may serve a request, so those runs both measured a different pool than production will use and travelled without the retention denial. That data cannot be recalled; the controls bind everything from here. | Measured, not assumed: over 66 real screens and 319 asserted rows, `gemini-3.7-flash` misreads 5 where `gpt-5.4` misreads 26–34, and across three passes it never disagrees with itself on money while gpt-5.4 disagrees on 14 of 48 images — once reading `-16500` where its own other pass read `-165.50`. The on-device reader manages 136 of 311. | `cheap` to reverse — `OCR_DRIVER=none`, one env var, no code change; automatic monetary prefill stops and the driver types the values. `OCR_DRIVER=openai` returns to gpt-5.4, and the provider is part of the cache signature so neither reader can be served the other's rows. |
| A-31 | **Cloud AI is the only automatic authority for values read from screenshots.** A faster phone/Tesseract guess may be retained as a training/diagnostic sample, but it must never appear as a fee, deduction, movement, wallet balance, odometer, or BMS reading before AI finishes, nor become the fallback after AI fails. AI failure leaves retry/manual entry; an explicit human edit always outranks a late AI answer. | **Owner-directed after the Thaer incident:** the phone published wallet `214` while AI was still reading the correct `279.50`, and mixed partial sightings counted the `-50` deduction twice. | `moderate` — changing authority changes field provenance, recovery, and close gating. |
| A-32 | **A pre-approved window is same-day and inclusive at both minute edges.** It is attached to a driver/date, not a vehicle or client-selected shift number, and the first matching complete confirmation consumes it. A window crossing midnight is represented as two explicit dated rules. | The owner named a driver, custom dates and a time window but did not define edge or midnight semantics. Inclusive minute precision matches the existing operation-window convention and keeps each advance signature tied to one written business date. | `cheap` — request and matching semantics |
| A-33 | **Completed-shift history means `approved` and `week_locked`; `cancelled` is shown separately.** The default view is seven dates and a custom query is bounded to 31 dates. | A cancelled shift is ended operationally but has no completed financial settlement. A bounded date-scoped read reuses the existing audited branch API without creating an unbounded browser fan-out. | `cheap` — history filter/range UI |
| A-34 | **A deferred close collection is next-shift funding, not an ordinary debt.** It posts to `driver_shift_funding_cash`/`driver_shift_funding_wallet`, so the driver's next open consumes it as a carried tranche BR1 then expects. The ordinary `driver_receivable_*` funds keep their 0036 meaning: an office asset cleared only by an explicit later collection command. | The money is physically in the driver's pocket and his Yallago app, and he spends it on the next shift's per-order cuts — which is what `driver_shift_funding_*` is documented to be. Booked as an ordinary debt it was invisible to the next open, so BR1 read it as a surplus and decision 13 paid the driver his own debt. `shifts.kept_as_receivable_minor` has promised «Cleared when he opens his next shift» since 0025; 0036 moved that behaviour to the new fund names and this posting was left behind. Owner-confirmed 2026-08-25 over the alternative (keep it a debt and block the next open). | `moderate` — a new migration must replace `shift_close_journals_match` again, and 0041 refuses to apply if any deferral is already booked to the ordinary funds. |
| A-35 | **`unavailable` may accompany a charge figure only when `source = 'manager'`.** A driver declaring «تطبيق البطارية لا يعمل على جهازي» has no figure by definition; a manager who read the pack on his own device legitimately has one and no screenshot. | The two halves of BR5 disagreed: `requiredPhotoSlots` waived the `bms_N` photo on `unavailable` alone while `batteryGaps` raised the compensating gap only while the percent was null, so a reading carrying both passed both gates with no evidence at all — and a driver holds `shift.operate` on his own shift. The combination could not simply be refused: production holds 18 legitimate manager-completed rows. | `cheap` — the CHECK in 0042 and one predicate; the exception is already named in the constraint. |
| A-36 | **«A reason was given» means at least one character survives stripping whitespace and the Unicode `Cf` set** — `ash_has_visible_text`, and its JavaScript twin `hasVisibleText` in the domain. One definition for the wire, the service, every UI copy, the CHECK constraints and the audit script. | Three definitions were in play (JS `.trim()`, one-argument `btrim()`, `ash_has_visible_text`) and they disagreed about the same column, so a fee could enter BR1 with an unreadable audit trail while the release blocker reported that settlement as wrong. In an Arabic-first product U+200F rides along in pasted text constantly and `'‏'.trim()` is truthy. The rule is «something survives», so a genuine Arabic reason carrying bidi marks is unaffected. Owner-confirmed 2026-08-25 over fixing only the checker. | `cheap` — one predicate and the 0043 constraints. |

---

## Escalated to the product owner rather than assumed

These were genuine conflicts or real-money questions, and were asked, not defaulted:

1. Financial week boundary → **answered** (D-1).
2. Wallet returned vs. carried forward — SRS §1.4/C-5 contradict the §2.3 example → **answered** (D-4).
3. Manual entries: SRS E-3 vs. the §3 matrix — an internal SRS conflict → **answered** (D-5).
4. Two shifts in one day: whole-day band vs. per-shift → **answered** (D-6).
5. The 19-day contract vs. a realistic 40–56 days → **answered** (D-7).
6. **SRS BR3 — pay mode per order.** The SRS mandates capturing `cash`/`electronic`/`free` on every
   delivery; the owner asked for it to be removed from the driver's screen → **answered** (D-8):
   remove it, and record the change rather than let the SRS and the code disagree in silence.

   What was weighed before implementing it: BR1's scalar equation is blind to pay mode *by
   construction* — flip an order cash↔electronic and `scalarDiff` stays exactly zero while
   `cashDiff` and `walletDiff` move by ±fee, which is precisely why the code returns three
   differences and not one. So the mode buys the ability to PREDICT the split between the driver's
   cash and his wallet, and nothing else. Both halves are already evidenced independently: the
   wallet by a photographed Yallago balance, the cash by a count at the branch. The split was
   corroboration, not a control.

   Cost accepted: a driver who has money in the wrong place is no longer contradicted by the
   equation, only by the two photographs. Kept cheap to reverse — `pay_mode` remains in the schema
   and on the wire, defaulted to `cash`, so nothing migrates and restoring the split is a UI change.
   `br1_split_gate` stayed `advisory` under that decision. D-13 later made the split diagnostic and
   replaced the close gate with the two physical settlement confirmations.

## Answered question raised by the code

6. **What happens when the actual wallet balance is negative?** The provider behaviour still needs
   field calibration, but D-13 answers the close semantics: the signed full-wallet action is `fund`,
   its direction is shown explicitly, and a negative wallet does not by itself prevent the driver
   from requesting close.

## Still to escalate before M2

**Get one real shift's ground truth**: a dashboard screenshot, the matching wallet screenshot, and
the branch manager's counted cash and wallet figures for that *same* shift. The variance and signed
cash instruction are measured against a number produced by Yallago, whose semantics we do not
control. Tips, promo credits, cancellation reversals, pending-vs-settled differences, or a different
rounding direction could transfer money to the wrong side even though the manager is allowed to
settle the shift. See `docs/client-request-samples.md`.
