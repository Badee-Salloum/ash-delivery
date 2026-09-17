// @ash/domain — the pure money core. No I/O, no framework, no clock, no dependencies.
// Every rule that decides where money goes lives here and nowhere else.

export * from './money/minor.ts'
export * from './money/currency.ts'
export * from './money/allocate.ts'
export * from './br1/equation.ts'
export * from './br1/diagnose.ts'
export * from './tier/rules.ts'
export * from './tier/split.ts'
export * from './time/civil.ts'
export * from './attendance/checkin.ts'
export * from './rbac/can.ts'
export * from './ledger/recipes.ts'
export * from './ledger/company.ts'
export * from './settlement/statement.ts'
export * from './treasury/restoration.ts'
export * from './shift/page-overlap.ts'
export * from './shift/superseded.ts'
export * from './shift/state.ts'
export * from './shift/worked-time.ts'
export * from './shift/shape.ts'
export * from './fx/rate.ts'
export * from './week/close.ts'
export * from './fleet/documents.ts'
export * from './fleet/numbering.ts'
export * from './auth/totp.ts'
export * from './text/visible.ts'
export * from './text/party-key.ts'

// P2 — the shared time filter and the range read model's reporting rules.
export * from './time/range.ts'
export * from './reporting/profit.ts'
export * from './reporting/treasury-flow.ts'
export * from './reporting/ledger-range.ts'

// P3 — kilometres per shift, behind the dashboard's fleet table (P6 extends it).
export * from './fleet/odometer.ts'

// P4 — recurring («ثابتة») expenses: when one falls due. Computed on read; nothing posts itself.
export * from './expenses/recurrence.ts'
