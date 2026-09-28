#!/usr/bin/env node
/**
 * Put our own Android sources into the platform Capacitor generates.
 *
 * WHY THE PLATFORM IS NOT COMMITTED. `npx cap add android` writes a few thousand files — Gradle
 * wrappers, manifests, resource stubs, a `.gitignore` of its own — none of which anyone here would
 * review and none of which could be verified on a machine without the Android SDK. Committing that
 * would be checking in a large binary-ish artefact and calling it source.
 *
 * So the repository holds only what is genuinely ours — native Java files, two string resources, an
 * offline page, and this script — and CI regenerates the rest from a pinned Capacitor version. What
 * a reviewer reads is exactly what we wrote.
 *
 * Java rather than Kotlin, deliberately: Capacitor's template ships no Kotlin plugin, and adding one
 * drags in a Kotlin/AGP version matrix somebody would have to keep matched — on an Android surface
 * of three files that will be opened once a year by people who are not Android developers.
 *
 * Everything below is IDEMPOTENT. It is run after every `cap add`/`cap sync`, and running it twice
 * must not produce two `<service>` elements or two permission lines.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const platform = join(here, 'android')
const main = join(platform, 'app', 'src', 'main')

if (!existsSync(main)) {
  console.error('android platform missing — run `npx cap add android` first')
  process.exit(1)
}

// ── 1. our Java, into the package Capacitor already made ────────────────────────────────────────
const javaTarget = join(main, 'java', 'com', 'ashdelivery', 'driver')
mkdirSync(javaTarget, { recursive: true })
cpSync(join(here, 'native', 'java', 'com', 'ashdelivery', 'driver'), javaTarget, { recursive: true })

// ── 2. the driver-facing strings ────────────────────────────────────────────────────────────────
for (const dir of ['values', 'values-en']) {
  const target = join(main, 'res', dir)
  mkdirSync(target, { recursive: true })
  copyFileSync(join(here, 'native', 'res', dir, 'strings_tracking.xml'), join(target, 'strings_tracking.xml'))
}

// ── 3. the manifest ─────────────────────────────────────────────────────────────────────────────
const manifestPath = join(main, 'AndroidManifest.xml')
let manifest = readFileSync(manifestPath, 'utf8')

/**
 * Ordinary tracking uses only foreground (in-use) location: the service is started from the shift
 * screen, which is by definition visible. `ACCESS_BACKGROUND_LOCATION` is added ONLY so tracking can
 * come back on its own after a REBOOT — `BootReceiver` starts the service with no UI, which the
 * platform permits only with that grant. The plugin asks for it once and never gates the service on
 * it (`AshTrackerPlugin.afterForeground`), so a decline costs nothing but the post-reboot restart.
 *
 * `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` lets the app ask, once, to be exempted from OEM battery
 * killers — the biggest real cause of a stopped tracker in the field. `RECEIVE_BOOT_COMPLETED` is
 * what lets `BootReceiver` hear the reboot at all.
 */
const permissions = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  // Held only across each upload, so the CPU cannot suspend mid-POST and freeze the socket.
  'android.permission.WAKE_LOCK',
]

for (const name of permissions) {
  const line = `    <uses-permission android:name="${name}" />`
  if (!manifest.includes(`android:name="${name}"`)) {
    manifest = manifest.replace('</manifest>', `${line}\n</manifest>`)
  }
}

// `stopWithTask="false"` keeps the service alive when the driver swipes the app off the recents
// list — the single most common way tracking would otherwise die mid-shift. Remove any prior
// TrackerService element first, so an attribute change here actually takes effect on re-run rather
// than being skipped as "already present".
manifest = manifest.replace(/\s*<service\b[\s\S]*?\.TrackerService[\s\S]*?\/>/, '')
const service =
  '        <service\n' +
  '            android:name=".TrackerService"\n' +
  '            android:exported="false"\n' +
  '            android:stopWithTask="false"\n' +
  '            android:foregroundServiceType="location" />'
manifest = manifest.replace('</application>', `${service}\n    </application>`)

// The boot receiver, so tracking resumes after a reboot. Exported so the system's BOOT_COMPLETED
// broadcast can reach it; it only ever restarts the service from the saved assignment.
const receiver =
  '        <receiver\n' +
  '            android:name=".BootReceiver"\n' +
  '            android:exported="true"\n' +
  '            android:enabled="true">\n' +
  '            <intent-filter>\n' +
  '                <action android:name="android.intent.action.BOOT_COMPLETED" />\n' +
  '                <action android:name="android.intent.action.LOCKED_BOOT_COMPLETED" />\n' +
  '            </intent-filter>\n' +
  '        </receiver>'
if (!manifest.includes('.BootReceiver')) {
  manifest = manifest.replace('</application>', `${receiver}\n    </application>`)
}

writeFileSync(manifestPath, manifest)

// ── 4. Play Services location, which `FusedLocationProviderClient` comes from ────────────────────
const gradlePath = join(platform, 'app', 'build.gradle')
let gradle = readFileSync(gradlePath, 'utf8')
const dependency = "    implementation 'com.google.android.gms:play-services-location:21.3.0'"
if (!gradle.includes('play-services-location')) {
  // Anchored on the LAST `dependencies {` block so this lands in the app module's own list.
  const at = gradle.lastIndexOf('dependencies {')
  if (at === -1) {
    console.error('could not find a dependencies block in app/build.gradle')
    process.exit(1)
  }
  const insert = gradle.indexOf('\n', at) + 1
  gradle = gradle.slice(0, insert) + dependency + '\n' + gradle.slice(insert)
  writeFileSync(gradlePath, gradle)
}

const workerDependency = "    implementation 'androidx.work:work-runtime:2.10.5'"
if (!gradle.includes('androidx.work:work-runtime')) {
  const at = gradle.lastIndexOf('dependencies {')
  if (at === -1) throw new Error('could not find dependencies in app/build.gradle')
  const insert = gradle.indexOf('\n', at) + 1
  gradle = gradle.slice(0, insert) + workerDependency + '\n' + gradle.slice(insert)
}

// A monotonically increasing Android build code lets the server identify the native capability.
gradle = gradle.replace(/versionCode\s+\d+/, 'versionCode 3')
gradle = gradle.replace(/versionName\s+"[^"]+"/, 'versionName "3.0"')
if (process.env.ASH_ANDROID_DIAGNOSTIC === '1') {
  // Side-by-side install to isolate package-name collisions on one test handset.
  // Java namespace and the remote driver URL remain identical to the normal build.
  gradle = gradle.replace(/applicationId "com\.ashdelivery\.driver(?:\.diagnostic)?"/,
    'applicationId "com.ashdelivery.driver.diagnostic"')
  const stringsPath = join(main, 'res', 'values', 'strings.xml')
  let strings = readFileSync(stringsPath, 'utf8')
  strings = strings.replace(/(<string name="app_name">)[^<]*(<\/string>)/,
    '$1ASH Driver Diagnostic$2')
  strings = strings.replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/,
    '$1ASH Driver Diagnostic$2')
  strings = strings.replace(/(<string name="package_name">)[^<]*(<\/string>)/,
    '$1com.ashdelivery.driver.diagnostic$2')
  strings = strings.replace(/(<string name="custom_url_scheme">)[^<]*(<\/string>)/,
    '$1com.ashdelivery.driver.diagnostic$2')
  writeFileSync(stringsPath, strings)
  const configPath = join(main, 'assets', 'capacitor.config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.appId = 'com.ashdelivery.driver.diagnostic'
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}
writeFileSync(gradlePath, gradle)

console.log('native sources applied: Java tracker, queue and worker, resources, manifest, gradle')
