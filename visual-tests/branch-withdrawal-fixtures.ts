/** Synthetic GET responses shared by the sealed local preview and browser interaction tests. */
export function branchWithdrawalPreview(path: string): unknown | undefined {
  if (path === '/api/treasury/balances') return { cash: '120000.00', wallet: '40000.00' }
  if (path === '/api/company-fund') return { total: '90000.00', branches: [] }
  if (path === '/api/drivers') return { drivers: [] }
  if (path === '/api/treasury/receivables/events') return { events: [] }
  if (path === '/api/treasury/receivables') return { drivers: [], cashTotal: '0.00', walletTotal: '0.00', grandTotal: '0.00', ordinaryCashTotal: '0.00', ordinaryWalletTotal: '0.00', shiftFundingCashTotal: '0.00', shiftFundingWalletTotal: '0.00' }
  if (path === '/api/advances') return { advances: [], outstanding: [], outstandingCash: '0.00', outstandingWallet: '0.00', total: '0.00', parties: [] }
  if (path === '/api/treasury/restoration/preview') return { businessDate: '2026-10-17', source: 'live_ledger', alreadyRestored: false, runsToday: 0, legs: [], netToCompany: '0.00', feasible: false, refusals: [] }
  return undefined
}
