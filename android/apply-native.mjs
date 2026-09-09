#!/usr/bin/env node
/**
 * Put our own Android sources into the platform Capacitor generates.
 *
 * WHY THE PLATFORM IS NOT COMMITTED. `npx cap add android` writes a few thousand files — Gradle
 * wrappers, manifests, resource stubs, a `.gitignore` of its own — none of which anyone here would
 * review and none of which could be verified on a machine without the Android SDK. Committing that
 * would be checking in a large binary-ish artefact and calling it source.
 *
 * So the repository holds only what is genuinely ours — three Java files, two string resources, an
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
 * Deliberately NOT `ACCESS_BACKGROUND_LOCATION`.
 *
 * A `location`-typed foreground service started while the app is visible does not need it, and
 * asking for it shows the driver the much more alarming «allow all the time» dialog — a scarier
 * prompt for a capability we do not use. The service is started from the shift screen, which is by
 * definition visible.
 */
const permissions = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
]

for (const name of permissions) {
  const line = `    <uses-permission android:name="${name}" />`
  if (!manifest.includes(`android:name="${name}"`)) {
    manifest = manifest.replace('</manifest>', `${line}\n</manifest>`)
  }
}

const service =
  '        <service\n' +
  '            android:name=".TrackerService"\n' +
  '            android:exported="false"\n' +
  '            android:foregroundServiceType="location" />'
if (!manifest.includes('.TrackerService')) {
  manifest = manifest.replace('</application>', `${service}\n    </application>`)
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

console.log('native sources applied: 3 Java files, 2 string resources, manifest, gradle')
