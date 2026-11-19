# Company-finance reports

## Direct-operation actions — published 2026-10-20

`POST /company/operations/:id/actions` supports deposits, withdrawals, income and FX only.
An edit atomically records the exact inverse, replacement and immutable operation receipt;
a deletion records the exact inverse and receipt. Expected journal identity and request fingerprint
protect stale tabs and idempotent retries. New entries use the current open business day; source
journals remain immutable. Calendar/FX lookups occur before holding the writer connection.
Expenses retain their canonical correction/deletion path. Linked branch/restoration/custody/debt/
purchase/depreciation workflows do not gain one-sided generic actions.

Current reports resolve repeated direct edits to one original identity with the latest effective
values. Current movement/history views omit cancelled operations; audit keeps the original,
inverse and replacement. Deleting a documentary expense payment atomically releases its
asset allocation and cancels dependent schedules with history retained. Corrections refresh
allocation evidence without creating cash payments; currency changes or reductions below
explicit allocations fail. Recognized/sold asset and debt links remain guarded.

Deployed Admin and API artifacts passed public hash/health/authentication checks. Ten browser
scenarios used synthetic data against the exact compiled Admin artifact; four real PostgreSQL
checks used a dedicated test database and rolled back fixtures. Authenticated production visual
inspection was unavailable because the computer-use tool failed to initialize. No production
financial action, shift write, migration or Driver release was performed during this verification.

`GET /company/reports` is a read-only addition. Existing `/company/movements` behavior is preserved. Access requires `company_fund.manage`.

Query parameters: `from`, `to` (calendar dates from 2000 through the current business date), `view=as_booked|current_corrected`, and `dateBasis=posting|occurrence`. Defaults are today's range, original journals, and posting dates.

## Two intentionally different views

- **As booked:** every immutable HQ journal and every money line, including all reversal/replacement legs. Original occurrence evidence, original posting date, and frozen FX are retained. Posting-period totals are not replaced with the latest expense snapshot.
- **Current corrected:** one canonical expense with its latest confirmed values; correction legs are linked, not independently counted. Deleted expenses and their technical cancellations are absent from current rows, totals, exports and operational dashboards, including a range containing only their original day. The original amount and cancellation remain in **as booked**, annotated `auditState=deleted_expense|expense_deletion` and linked by journal identity. Each confirmed restoration source leg appears once at its latest confirmed amount; pending proposals do not count as cash. Cancelled commands of every kind and their technical reversals are excluded from current rows. Supported direct-operation edits resolve to one canonical original identity with their latest replacement values. Other financial journals remain explicitly marked `journal_only`; their booked classifications are not invented or changed.

The current view is a present-day operational snapshot, **not** an as-of-period trial balance. Its posting filter uses the canonical event's **first posting date**, so the same corrected event is not repeated in every correction period. Occurrence filtering uses the current corrected occurrence date. To inspect correction-period accounting, select **as booked + posting**.

Occurrence grouping never changes posting dates or reopens a closed period. Month-only evidence overlaps the chosen month range and remains marked `month`; missing evidence is explicitly marked `posting_fallback`, never presented as a known historical day. Original raw occurrence dates are not overwritten by metadata corrections.

In raw occurrence mode, a reversal's actual correction date may differ from the replacement expense's historical occurrence date. Such date-grouped journal totals are **not** effective historical business costs: use current-corrected + occurrence for that operational question, and as-booked + posting for accounting-period net movements.

## Money, references, and owner funding

Currencies are never added together. Totals include journal debits/credits, signed company-cash effect, existing income/expense classifications, expense payment-source split, and other book costs. An expense paid outside the company by the owner has zero company-cash effect. Existing non-cash debt/writeoff costs are not relabeled as a cash payment.

The owner information panel reads `/company/owner-payments` separately using occurrence dates. It distinguishes direct expenses, capital/debt payments, and verified branch funding. Its totals must not be added to HQ cash totals. Existing motorcycle cards create neither a payment nor GL recognition merely by registration.

**Historical book-cost reclassification remains unresolved and is not implemented or claimed by this report.** Reports preserve existing book facts, including owner-funded book costs where the current recipes recognize them. They do not silently change those recipes or previous reports.

## CSV and UI

The reports tab defaults to this month, current-corrected values, and occurrence dates. Period choices are this month, last month, all available history, or a custom range. All-history starts at the earliest available report event or eligible effective owner-payment source, including an older source linked to a branch deposit; month-only sources use their month anchor. Expanding this read range does not turn administrative sources into GL rows, cash, or profit, and does not change custom/month boundaries. The advanced audit section contains the view/date-basis selectors and accounting semantics. A cash-only summary separates receipts, payments, and net movement per currency; it is not profit or an ending cash balance. The page hides stale report data and disables export until the response matches all selected parameters. Audit details expand on demand and expose every financial line.

CSV exports one row per financial line (or one evidence row for a confirmed zero), including view, date basis, period semantics, original/latest posting dates, occurrence precision/source, gross/net amounts, debit/credit side, signed net, raw frozen minor-rate unit, canonical audit reference, receipt reference, canonical command, entry IDs, linked corrections, and branch-source identity. Formula-like user text is neutralized; negative decimal amounts remain numeric. Exchange exports retain both actual currencies and their gross/effective amounts. CSV does not create or modify any accounting record.

Financial writers still serialize under the HQ command lock. Multi-query financial GETs use `mode: read_snapshot`: PostgreSQL `REPEATABLE READ READ ONLY` on one transaction-bound connection, without the exclusive writer advisory lock. Readers therefore cannot combine old commands with new corrections, cannot write, and no longer queue behind one another on the HQ lock. The pure projection and routes contain no journal, FX-day, balance-reset, or recosting writes.

## Current consistency update — 2026-10-15 (local, not deployed)

Dashboard HQ income/costs now use the same current-corrected occurrence projection as finance, including confirmed expense corrections, immutable FX rates and existing debt P&L lines. Outside-owner evidence remains in its own panel and is excluded from the dashboard's company-profit costs, matching the income/cost report filter. A deletion is not new income. Branch settlement calculations and approved shifts are untouched. The dashboard drill preserves range and selects `report=cost_income&view=current_corrected&dateBasis=occurrence`; original books remain an explicit advanced audit choice with a visible warning.

Overview period income/expense and payment-source subtotals use current occurrence semantics (`expenseSourceBasis=current_corrected_occurrence`). Current cash positions still sum the immutable ledger, not a filtered expense list. The raw report default is retained for older API clients; the user interface always explicitly selects the current view unless audit is requested.

Financial lists share the existing responsive table/card primitives and a single pagination control. Current report rows sort newest first; raw audit preserves journal chronology. Field-specific all-category/source/currency/status labels replace the ambiguous repeated “all operations”. HQ labels use “صندوق الشركة”; branch cash, outside-owner payments and company custody remain separate. A busy-database load failure is a readable retry state, not a failed payment message or apparent zero balance. No schema migration is required.

## Finance workspace update — 2026-10-08

The first tab now separates current HQ cash from period transfers. It reads the current overview independently from the corrected all-history report and the restoration review feed. Assets, debt, recurring and historical-entry resources load only in their relevant sections; their failures cannot blank the overview or reports. Tab/branch read keys and request sequences prevent a previous section's data from being submitted in a new context.

Transfers are grouped only by persisted provenance: reviewed proposal identity, historical restoration links, or legacy mirror identity. Approved historical groups expose their immutable branch source legs and variance through an additive `historicalGroups` field on `GET /company/restoration-reviews`. Equal dates/amounts are never treated as proof of matching. Reclassification journals have no cash and are excluded. An opposing-direction zero-net proposal remains visible but contributes no confirmed cash. An approved zero retains its actual confirmation date without fabricating a cash journal. A group spanning multiple days retains every source day; period totals include only company legs inside the range. Approved variances remain disclosed in the register, not relabeled as pending approvals.

The all-period review queue remains distinct from the selected transfer period. Specific pending and unlinked items open their existing guarded review/adoption flow directly. Known historical matches open source details, not a new payment form. Owner payments are at the bottom, use the selected occurrence period and retain separate direct-payment and branch-funding subtotals. Expanding their full filter list fetches the newly chosen period, rather than filtering an incomplete previously loaded period.

Reports have a plain-language selector for cash, transfers, company income/costs, owner information, asset/debt payments and audit. Currency filtering operates on money lines; summary totals, drill-down rows and both exports use exactly those lines, not the unfiltered server total. Company income/cost filtering excludes external owner expenses from its operating-cost rows without rewriting any journal. The raw report still preserves those book facts and the separate owner information panel remains authoritative for owner funding. Runtime parity tests compare client aggregation with server totals in both raw and corrected modes, including source-aware expense reversals.

`cashBalances` adds opening and closing cash for each report's existing view/date semantics. Opening + period receipts − period payments = closing. These balances describe the entire period, not an arbitrary narrowed subset of its rows. Current-corrected balances are restated operational balances, never presented as an immutable historical close. Month-only evidence uses the same overlap semantics as the report rows. Pending counts now use the requested financial-day range.

The default CSV is a translated, readable table of all filtered results, across pagination. A separate audit CSV retains the prior detailed financial schema plus explicit currency, branch and direction filters. Existing asset cards remain non-financial; their add form moves into a short dialog. Existing edit, depreciation and documentary-sale safeguards are unchanged. Commitments show due items before optional creation forms; due is explicitly not paid.

Verification: 434 admin unit tests, 59 API report/matching/restoration tests, 6 new desktop/mobile browser tests, workspace TypeScript, admin production build and translation/design guards. Browser and API fixtures are synthetic/in-memory; no production database, deployment, migration or accounting write was performed for this update. Vite's existing large-bundle warning remains non-blocking and is separate from the section-level data loading work.
