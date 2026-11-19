export const gpsPreviewUser = 'gps-preview-manager'
export const gpsPreviewBranches = [
  { id: 'gps-demo-branch-1', code: 'DEMO1', nameAr: 'فرع تجريبي أول', nameEn: 'Demo branch one' },
  { id: 'gps-demo-branch-2', code: 'DEMO2', nameAr: 'فرع تجريبي ثان', nameEn: 'Demo branch two' },
]
export const gpsPreviewDirectory = { drivers: [
  { id: 'gps-demo-driver-1', fullNameAr: 'سائق تجريبي أول', fullNameEn: 'Demo driver one' },
  { id: 'gps-demo-driver-2', fullNameAr: 'سائق تجريبي ثان', fullNameEn: 'Demo driver two' },
] }
export function gpsPreviewData(offset = 0) {
  const stamp = new Date().toISOString()
  return { drivers: [
    { driverId: 'gps-demo-driver-1', shiftId: 'gps-demo-shift-1', lat: 33.52 + offset, lng: 36.28 + offset, accuracyM: 10, capturedAt: stamp, receivedAt: stamp },
    { driverId: 'gps-demo-driver-2', shiftId: 'gps-demo-shift-2', lat: 33.50 + offset, lng: 36.30 + offset, accuracyM: 15, capturedAt: stamp, receivedAt: stamp },
  ], silent: [], health: [] }
}
