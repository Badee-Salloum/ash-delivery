import { type ReactNode, useEffect, useState } from 'react'
import { useApp } from '../app-context.tsx'
import { Badge, Button, Card, Table, TextInput } from '../ui.tsx'

interface Driver {
  id: string
  code: string
  fullNameAr: string
  active: boolean
  blockedByDocuments: boolean
  documents: Array<{ id: string; kind: string; expiresOn: string | null; status: string }>
}
interface Vehicle {
  id: string
  code: string
  state: 'ready' | 'charging' | 'maintenance' | 'stopped'
  active: boolean
}

const docTone: Record<string, 'green' | 'amber' | 'red' | 'slate'> = {
  valid: 'green',
  expiring_soon: 'amber',
  expires_today: 'amber',
  expired: 'red',
  no_expiry: 'slate',
}
const vehTone: Record<string, 'green' | 'sky' | 'amber' | 'slate'> = {
  ready: 'green',
  charging: 'sky',
  maintenance: 'amber',
  stopped: 'slate',
}

/** Drivers & vehicles (SRS B). Each driver carries his document status; an expired doc blocks him. */
export function Fleet(): ReactNode {
  const { api, t } = useApp()
  const [drivers, setDrivers] = useState<Driver[]>([])
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [newDriver, setNewDriver] = useState({ code: '', fullNameAr: '' })
  const [newVehicle, setNewVehicle] = useState({ code: '', vehicleTypeId: 'e_motorbike' })

  const load = (): void => {
    void api.get<{ drivers: Driver[] }>('/drivers').then((r) => setDrivers(r.drivers)).catch(() => setDrivers([]))
    void api.get<{ vehicles: Vehicle[] }>('/vehicles').then((r) => setVehicles(r.vehicles)).catch(() => setVehicles([]))
  }
  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title={t.fleet.drivers}>
        <div className="mb-3 flex gap-2">
          <TextInput placeholder={t.fleet.code} value={newDriver.code} onChange={(e) => setNewDriver({ ...newDriver, code: e.target.value })} className="w-28" />
          <TextInput placeholder={t.fleet.name} value={newDriver.fullNameAr} onChange={(e) => setNewDriver({ ...newDriver, fullNameAr: e.target.value })} className="flex-1" />
          <Button
            onClick={async () => {
              await api.post('/drivers', newDriver).catch(() => undefined)
              setNewDriver({ code: '', fullNameAr: '' })
              load()
            }}
            disabled={!newDriver.code || !newDriver.fullNameAr}
          >
            +
          </Button>
        </div>
        <Table head={[t.fleet.code, t.fleet.name, t.fleet.documents]}>
          {drivers.map((d) => (
            <tr key={d.id}>
              <td className="px-3 py-1 num">{d.code}</td>
              <td className="px-3 py-1">
                {d.fullNameAr}
                {d.blockedByDocuments ? <span className="ms-2"><Badge tone="red">{t.fleet.blocked}</Badge></span> : null}
              </td>
              <td className="px-3 py-1">
                <div className="flex flex-wrap gap-1">
                  {d.documents.map((doc) => (
                    <Badge key={doc.id} tone={docTone[doc.status] ?? 'slate'}>
                      {doc.kind}
                    </Badge>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title={t.fleet.vehicles}>
        <div className="mb-3 flex gap-2">
          <TextInput placeholder={t.fleet.code} value={newVehicle.code} onChange={(e) => setNewVehicle({ ...newVehicle, code: e.target.value })} className="flex-1" />
          <Button
            onClick={async () => {
              await api.post('/vehicles', newVehicle).catch(() => undefined)
              setNewVehicle({ code: '', vehicleTypeId: 'e_motorbike' })
              load()
            }}
            disabled={!newVehicle.code}
          >
            +
          </Button>
        </div>
        <Table head={[t.fleet.code, t.fleet.state, '']}>
          {vehicles.map((v) => (
            <tr key={v.id}>
              <td className="px-3 py-1 num">{v.code}</td>
              <td className="px-3 py-1">
                <Badge tone={vehTone[v.state] ?? 'slate'}>{t.fleet.vehicleStates[v.state]}</Badge>
              </td>
              <td className="px-3 py-1">
                <select
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                  value={v.state}
                  onChange={async (e) => {
                    await api.patch(`/vehicles/${v.id}`, { state: e.target.value }).catch(() => undefined)
                    load()
                  }}
                >
                  {(['ready', 'charging', 'maintenance', 'stopped'] as const).map((st) => (
                    <option key={st} value={st}>
                      {t.fleet.vehicleStates[st]}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  )
}
