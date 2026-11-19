import { type ReactNode, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Button, Card, Field, Money, Pending, Select } from '../ui.tsx'
import { explainError } from '../errors.ts'
import { FinanceActionForm, useResource } from './CompanyFinanceReview.tsx'
import type { Mutate } from './CompanyFund.tsx'

/** Only actual live transfers. Historical missing HQ halves require source matching elsewhere. */
export function CompanyBranchTransfer({ today, mutate }: { today: string; mutate: Mutate }): ReactNode {
  const { t, branches, branchId, session } = useApp(), r = t.financeReview
  const [linking, setLinking] = useState(false)
  const { data: readiness } = useResource<{ branches: Array<{ branchId: string; cutOver: boolean }> }>('/company-fund', 0)
  const directions = [
    { value: 'company_to_branch', label: r.transferCompanyToBranch },
    { value: 'branch_to_company', label: r.transferBranchToCompany },
    { value: 'owner_to_branch', label: r.transferOwnerToBranch },
  ]
  return <><div className="mb-3 flex flex-wrap gap-2"><Button variant={!linking ? 'primary' : 'ghost'} onClick={() => setLinking(false)}>{t.financeWorkspace.newTransfer}</Button><Button variant={linking ? 'primary' : 'ghost'} onClick={() => setLinking(true)}>{t.financeWorkspace.linkPastTransfer}</Button></div>{linking ? <HistoricalTransferLink mutate={mutate} /> : <Card title={r.branchTransfer} subtitle={r.branchTransferHint}>
    <FinanceActionForm path="/company/branch-transfers" title={t.companyFinance.submit} mutate={mutate}
      fields={[
        { key: 'mode', label: r.transferRoute, value: 'company_to_branch', options: directions },
        { key: 'branchId', label: t.accounts.branch, value: branchId ?? session?.branchId ?? '',
          options: [{ value: '', label: '—' }, ...branches.map(branch => ({ value: branch.id, label: branch.nameAr }))] },
        { key: 'channel', label: r.transferChannel, value: 'cash', options: [
          { value: 'cash', label: t.treasury.cashBox }, { value: 'wallet', label: t.treasury.wallet }] },
        { key: 'amount', label: `${t.companyFinance.amount} (${t.currency.SYP_NEW})`, type: 'money' },
        { key: 'occurredOn', label: t.companyFinance.occurredOn, type: 'date', value: today },
        { key: 'description', label: t.companyFinance.description },
        { key: 'historyChecked', label: t.financeWorkspace.transferHistoryCheck, value: '', optional: true, options: [{ value: '', label: '—' }, { value: 'yes', label: t.financeWorkspace.notRecordedTransfer }] },
      ]}
      build={values => ({ branchId: values.branchId, direction: values.mode === 'branch_to_company' ? 'from_branch' : 'to_branch',
        source: values.mode === 'owner_to_branch' ? 'owner_outside' : 'company', channel: values.channel,
        currency: 'SYP_NEW', amount: values.amount, occurredOn: values.occurredOn, description: values.description,
        ...(values.occurredOn !== today && values.historyChecked === 'yes' ? { notPreviouslyRecorded: true } : {}) })}
      preview={values => <>
        <p className="font-semibold">{directions.find(direction => direction.value === values.mode)?.label}</p>
        <p>{branches.find(branch => branch.id === values.branchId)?.nameAr ?? values.branchId} · {values.channel === 'wallet' ? t.treasury.wallet : t.treasury.cashBox}</p>
        <p>{r.transferAmountPreview}: <Money value={values.amount ?? ''} currency="SYP_NEW" /></p>
        <p>{values.mode === 'owner_to_branch' ? r.transferOwnerEffect : values.mode === 'branch_to_company' ? r.transferInEffect : r.transferOutEffect}</p>
        <p>{values.occurredOn} · {t.companyFinance.postedOn}: {values.occurredOn}</p><p>{values.description}</p>
        {values.mode !== 'owner_to_branch' && readiness && !readiness.branches.find(branch => branch.branchId === values.branchId)?.cutOver
          ? <p role="alert" className="text-danger-ink">{r.transferCutoverBlocked}</p> : null}
        {values.occurredOn !== today ? <p role="alert" className={values.historyChecked === 'yes' ? 'text-warning-ink' : 'text-danger-ink'}>{values.historyChecked === 'yes' ? t.financeWorkspace.pastTransferEffect : r.transferHistoricalBlocked}</p> : null}
      </>} />
  </Card>}</>
}

type PastTransfer = { sourceEntryId: number; occurredOn: string; description: string; direction: string; amount: string }
function HistoricalTransferLink({ mutate }: { mutate: Mutate }): ReactNode {
  const { t, branches, branchId, session } = useApp(), w = t.financeWorkspace
  const [selectedBranch, setSelectedBranch] = useState(branchId ?? session?.branchId ?? '')
  const [revision, setRevision] = useState(0)
  const feed = useResource<{ sources: PastTransfer[]; companyReceipts: Array<{companyEntryId:number;occurredOn:string;amount:string;description:string;direction:string}> }>(selectedBranch ? `/company/branch-transfers/historical-sources?branchId=${encodeURIComponent(selectedBranch)}` : null, revision)
  return <Card title={w.linkPastTransfer} subtitle={w.pastLinkHint}>
    <Field label={t.accounts.branch}><Select value={selectedBranch} onChange={event => setSelectedBranch(event.target.value)}><option value="">—</option>{branches.filter(branch=>branch.code !== 'HQ').map(branch=><option key={branch.id} value={branch.id}>{branch.nameAr}</option>)}</Select></Field>
    {!selectedBranch ? null : !feed.data ? <Pending error={feed.error} loadingLabel={t.common.loading} errorLabel={explainError(feed.error,t)} onRetry={feed.load} retryLabel={t.common.retry} /> : !feed.data.sources.length ? <p className="my-3">{w.noPastTransferSources}</p> : <FinanceActionForm key={`${selectedBranch}:${revision}`} path="/company/branch-transfers/historical-link" storageScope={selectedBranch} title={t.companyFinance.submit} mutate={mutate} onSaved={()=>setRevision(value=>value+1)}
      fields={[{key:'sourceEntryId',label:w.existingBranchReceipt,options:[{value:'',label:'—'},...feed.data.sources.map(source=>({value:String(source.sourceEntryId),label:`${source.occurredOn} · ${source.amount} ${t.currency.SYP_NEW} · ${source.direction === 'to_company' ? t.financeReview.toCompany : t.financeReview.fromCompany} · ${source.description}`}))]},
        {key:'companyEntryId',label:w.existingCompanyReceipt,value:'',optional:true,options:[{value:'',label:w.createMissingCompanySide},...feed.data.companyReceipts.map(row=>({value:String(row.companyEntryId),label:`${row.occurredOn} · ${row.amount} ${t.currency.SYP_NEW} · ${row.description}`}))]},
        {key:'reason',label:t.companyFinance.reason}]}
      build={values=>({branchId:selectedBranch,sourceEntryId:Number(values.sourceEntryId),companyEntryId:values.companyEntryId ? Number(values.companyEntryId):null,reason:values.reason,acknowledged:true})}
      preview={values=>{const source=feed.data!.sources.find(row=>String(row.sourceEntryId)===values.sourceEntryId);return <><p>{w.pastLinkHint}</p><p>{source?.occurredOn} · {source?.description}</p><Money value={source?.amount ?? ''} currency="SYP_NEW"/><p>{values.companyEntryId ? w.linkWithoutCash : w.onlyCompanyCash}</p><p>{values.reason}</p></>}} />}
  </Card>
}
