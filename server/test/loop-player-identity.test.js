'use strict';

/*
 * The Android app is Loop Player, and it knows where to connect before anyone touches it.
 *
 * There is no Kotlin compiler in this suite, so these read the sources the way
 * player-parity-baselines.test.js already does. Every assertion below is a thing that, if it
 * silently reverted, would only be discovered by a customer holding a panel:
 *
 *   - a store identity that changed (the application id can never move after publication)
 *   - the borrowed system glyph coming back as the app icon
 *   - the compiled-in server address going missing, which puts a URL keyboard in front of
 *     someone who was told they only had to plug the screen in
 *   - the seed overwriting an address a panel was deliberately pointed at
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const GRADLE = read('android/app/build.gradle.kts');
const MANIFEST = read('android/app/src/main/AndroidManifest.xml');
const APP = read('android/app/src/main/java/com/remotedisplay/player/RemoteDisplayApp.kt');
const STRINGS = read('android/app/src/main/res/values/strings.xml');
const SERVER = read('server/server.js');

test('the application id is the published one, and the namespace deliberately is not', () => {
  assert.match(GRADLE, /applicationId = "br\.com\.loopplayer\.player"/);
  assert.match(GRADLE, /namespace = "com\.remotedisplay\.player"/,
    'the Kotlin package stays put: it is internal, and renaming it buys nothing');
});

test('the device-owner component names the class in full, not the dot shorthand', () => {
  // ".admin.STDeviceAdminReceiver" resolves against the NAMESPACE while the component's first
  // half is the APPLICATION ID. Now that they differ, the shorthand names a class that does not
  // exist — and device-owner provisioning fails with nothing useful in the log.
  assert.match(SERVER,
    /DEVICE_ADMIN_COMPONENT = 'br\.com\.loopplayer\.player\/com\.remotedisplay\.player\.admin\.STDeviceAdminReceiver'/);
});

test('the app wears its own icon and name', () => {
  assert.doesNotMatch(MANIFEST, /@android:drawable\/ic_media_play/,
    'the icon was a system glyph borrowed from the platform');
  assert.match(MANIFEST, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(MANIFEST, /android:roundIcon="@mipmap\/ic_launcher_round"/);
  assert.match(MANIFEST, /android:banner="@drawable\/banner"/, 'the leanback launcher needs a tile');
  assert.match(MANIFEST, /android:label="@string\/app_name"/);
  assert.match(STRINGS, /<string name="app_name">Loop Player<\/string>/);

  // Every density, both launcher shapes, plus the layers an adaptive icon is made of.
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const file of ['ic_launcher.png', 'ic_launcher_round.png',
      'ic_launcher_foreground.png', 'ic_launcher_monochrome.png']) {
      const p = `android/app/src/main/res/mipmap-${density}/${file}`;
      assert.ok(fs.existsSync(path.join(ROOT, p)), `missing ${p}`);
    }
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')));
  assert.ok(fs.existsSync(path.join(ROOT, 'android/app/src/main/res/drawable-xhdpi/banner.png')));
});

test('no screen may be hidden from the app because it lacks a touchscreen', () => {
  // Both stores read these. Required-by-default would hide Loop Player from televisions, sticks
  // and most signage panels — which is all of the hardware it is actually for.
  assert.match(MANIFEST, /android:name="android\.hardware\.touchscreen" android:required="false"/);
  assert.match(MANIFEST, /android:name="android\.software\.leanback" android:required="false"/);
});

test('the panel build carries our server address; the self-hosted build asks, as always', () => {
  assert.match(GRADLE, /create\("loop"\)/);
  assert.match(GRADLE, /create\("selfhosted"\)/);
  assert.match(GRADLE, /buildConfigField\("String", "DEFAULT_SERVER_URL", "\\"https:\/\/player\.loopplayer\.com\.br\\""\)/);
  assert.match(GRADLE, /buildConfig = true/, 'AGP 8 does not generate BuildConfig unless asked');
});

test('the address is seeded once, and never over one that is already set', () => {
  assert.match(APP, /seedBuiltInServer\(\)/);
  assert.match(APP, /BuildConfig\.DEFAULT_SERVER_URL/);
  // The guard is the whole safety of this: a panel pointed somewhere by pairing, by the
  // device-owner QR, or by a technician through the PIN menu must not be dragged back.
  assert.match(APP, /if \(config\.serverUrl\.isNotEmpty\(\)\) return/);
  // And the pre-filled address only saves a step if the setup screen is told to skip ahead.
  assert.match(APP, /setPendingAutoConnect\(true\)/);
});

test('the v1 re-sign runs for the flavor we actually ship, and can read its own password', () => {
  /*
   * #81: some MDM-managed signage (MAXHUB/Pivot) deletes a v2-only app on the next reboot,
   * because its boot integrity check expects a v1 JAR signature. The re-sign that adds it was
   * hooked to "assembleRelease" alone — a task nobody runs once flavors exist — so it silently
   * stopped applying, and the APK looked fine until a panel wiped itself overnight.
   */
  assert.ok(GRADLE.includes('it.name.startsWith("assemble") && it.name.endsWith("Release")'),
    "the re-sign must hook every release task, not the aggregate nobody runs");
  // And it must accept the password from the same two places the signingConfig does. Reading
  // only the environment made it fail with a bare "exit value 2" on a machine that keeps its
  // credentials in ~/.gradle/gradle.properties, which is where they belong.
  assert.ok(GRADLE.includes('val ksPass = System.getenv("KEYSTORE_PASSWORD") ?: findProperty'),
    'the password must come from the environment OR a Gradle property');
  // apksigner is a .bat on Windows. The extensionless name works in CI and fails on the desktop
  // where a release is most likely to be cut by hand.
  assert.ok(GRADLE.includes('if (isWindows) "apksigner.bat" else "apksigner"'),
    'apksigner is a .bat on Windows');
});

test('the release plumbing follows the flavors', () => {
  const ci = read('.github/workflows/ci.yml');
  const finalize = read('scripts/finalize-release.sh');
  // :app:testDebugUnitTest stops existing the moment flavors arrive, and a vector-conformance
  // test that quietly stops running is worse than one that fails.
  assert.match(ci, /:app:testLoopDebugUnitTest/);
  assert.doesNotMatch(ci, /:app:testDebugUnitTest\b/);
  assert.match(finalize, /assembleLoopRelease/);
  assert.match(finalize, /outputs\/apk\/loop\/release\/app-loop-release\.apk/);
});
