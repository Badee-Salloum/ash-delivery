# Historical HQ import — 2026-10-03

Reviewed source: `outputs/01a0f40c-21a1-7382-ab61-aa10c490101f/ledger-update-20261002/صندوق محدث.xlsx`, SHA-256 `3b0f827ffadf8a86695b0233cbfdf5be68d97562963a8be02c269f23df9f9d47`.

The production database was backed up before writing to `C:\Users\Badee Salloum\Desktop\ash-backups\historical-import-20261003-pre\2026-10-03T07-23-52-767Z` (103 tables, 249,813 rows, 85 migrations). Migrations `0090`–`0093` then applied. The source-bound atomic batch `6e3c2c7d-9ee9-5331-9332-1b35f5659530` committed 96 immutable source receipts, comprising 67 HQ journals and 29 owner-direct records outside HQ cash and company P&L. It includes 54 HQ↔branch historical transfers, 8 HQ expenses, 4 FX exchanges, and 1 expense reversal. Existing branch restorations and the two confirmed owner-to-branch deposits were linked, not rerun.

The independent row-by-row production verifier passed. Company cash at the source cutoff exactly matched the reviewed workbook in each currency after old-SYP conversion. Exact balances remain in the private operational evidence. The branch journal count remained unchanged; the branch `company_box` balance was not added to HQ cash. Original dates are financial posting dates in the new HQ journals. Source descriptions and exchange rates remain attached to the immutable receipt/journal evidence.

A post-import logical backup completed at `C:\Users\Badee Salloum\Desktop\ash-backups\historical-import-20261003-post\2026-10-03T07-40-20-414Z` (106 tables, 250,825 rows, 89 migrations). Ordinary live activity continued while the backup ran, so the backup is not a quiescent snapshot; the historical batch itself committed atomically and was separately verified.

Production deployments: API `dpl_4gNnG6uFcmT1rn4tHFH1BoUvwFtq` at `https://ash-api-xi.vercel.app`; Admin `dpl_HBB8ecmULiUQs4mwY2Rj8F4TukaS` at `https://ash-admin-eta.vercel.app`. Both were promoted after staging. API health and Admin `/api/health` returned 200; the new `/api/company/historical-imports` endpoint returned the expected 401 without a session. The Driver deployment was unchanged.

The isolated 96-row import rehearsal and production verifier both passed. Type checking, SQL checks, builds, domain and database unit tests passed. The full API run completed 1,151 passing tests and one unrelated ten-second setup-hook timeout under parallel test load; that file passed immediately in isolation. An earlier full run had four unrelated five-second timeouts during concurrent backup/build work, and those files also passed in isolation. No assertion failed.

The owner-direct USD receipts carry explicitly estimated reference rates for review, not claimed documented rates. They do not affect HQ cash. Source row `71` is a booked USD HQ expense with an explicitly marked estimated historical rate; this remains visible for audit follow-up.

## Completion audit

The reviewed XLSX was independently reopened using the spreadsheet runtime. All 1,666 source/header cells exactly match the read-only source extraction; the six trailing worksheet rows contain summaries and notes, not additional movements. The source has 97 numbered rows and 96 effective rows after excluding the user-confirmed duplicate `5`. The workbook closing cells and formulas agree with the private verification record in both currencies.

The verifier was strengthened to compare all 96 stored JSON evidence records byte-for-value against the reviewed manifest, receipt positions/dates/types/funding/branch identities, journal dates/types/UUIDs/descriptions/actors, and batch hash/counts/cutoff. It also independently recomputes all HQ cash through the cutoff, scopes command counts to this batch, and checks that no branch journal was created in the import transaction. Both isolated-test and production runs passed with exact closing cash. No additional financial writes were performed during this completion audit.

Production visual inspection could not be completed with the existing authenticated browser tabs because their browser focus commands timed out. A new tab reached the real production login page. Database/read-model evidence and the previously verified deployment/health checks are complete; this is not a claim of a successful authenticated visual check. Completion evidence: `outputs/historical-completion-audit-20261003/completion-evidence.json`.
