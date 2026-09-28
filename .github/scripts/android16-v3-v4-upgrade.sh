#!/usr/bin/env bash
set -euo pipefail

: "${V3_APK:?V3_APK is required}"
: "${V4_APK:?V4_APK is required}"

package_id=com.ashdelivery.driver.diagnostic
sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')
test "$sdk" = 36 || { echo "Expected Android API 36, got $sdk" >&2; exit 1; }

if [ -n "$(adb shell pm path "$package_id" | tr -d '\r')" ]; then
  echo "Expected a clean emulator; $package_id is already installed" >&2
  exit 1
fi

adb install "$V3_APK"
adb shell pm path "$package_id"
v3_details=$(adb shell dumpsys package "$package_id")
grep -E 'versionCode=3([^0-9]|$)' <<< "$v3_details"

# Release APKs are not debuggable, so run-as cannot inspect their sandbox. The
# google_apis emulator permits adb root, letting the test place a marker inside
# the actual private app directory without launching the production web app.
adb root
adb wait-for-device
data_dir="/data/user/0/$package_id"
marker_path="$data_dir/files/upgrade-marker.txt"
adb shell "test -d '$data_dir'"
app_uid=$(adb shell "stat -c %u '$data_dir'" | tr -d '\r')
adb shell "mkdir -p '$data_dir/files'; chown '$app_uid:$app_uid' '$data_dir/files'"
marker="ash_v3_v4_${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}"
adb shell "printf '%s' '$marker' > '$marker_path'"
adb shell "chown '$app_uid:$app_uid' '$marker_path'"
before=$(adb shell "cat '$marker_path'" | tr -d '\r')
test "$before" = "$marker"

# -r must perform an in-place update. It fails on a signing certificate or
# package-ID mismatch, and must leave the v3 data directory intact.
adb install -r "$V4_APK"
adb shell pm path "$package_id"
v4_details=$(adb shell dumpsys package "$package_id")
grep -E 'versionCode=4([^0-9]|$)' <<< "$v4_details"
after=$(adb shell "cat '$marker_path'" | tr -d '\r')
after_uid=$(adb shell "stat -c %u '$data_dir'" | tr -d '\r')
test "$after" = "$marker" || { echo 'Private app marker was lost during upgrade' >&2; exit 1; }
test "$after_uid" = "$app_uid" || { echo 'Android changed the app UID during upgrade' >&2; exit 1; }
echo 'Android 16 v3 diagnostic -> v4 in-place upgrade preserved private app data'
