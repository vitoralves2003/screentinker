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

test('nothing a customer reads is hardcoded English, and the brand is ours', () => {
  const layouts = ['activity_main', 'activity_provisioning', 'activity_setup'];
  for (const name of layouts) {
    const xml = read(`android/app/src/main/res/layout/${name}.xml`);
    // The rebrand swept strings.xml and missed these entirely: the text lived in the LAYOUTS,
    // so the pairing screen a customer stares at while typing the code still said RemoteDisplay.
    assert.doesNotMatch(xml, /RemoteDisplay/, `${name} still names the upstream product`);
    // A literal android:text is a string that cannot be translated. The panel shipped in English
    // to a Portuguese device because of 63 of them.
    assert.doesNotMatch(xml, /android:text="[^@]/, `${name} has untranslatable text`);
  }
  // And the Portuguese has to actually be there, or every one of those falls back to English.
  const pt = read('android/app/src/main/res/values-pt/strings.xml');
  for (const key of ['pair_code_hint', 'perm_battery_desc', 'player_connecting']) {
    assert.match(pt, new RegExp(`name="${key}"`), `values-pt is missing ${key}`);
  }
});

test('a normal install goes to its pairing code, not to a permissions wizard', () => {
  const main = read('android/app/src/main/java/com/remotedisplay/player/MainActivity.kt');
  // Only a device-owner panel may still route through SetupActivity at first run — that is where
  // the onboarding policy is applied. Everyone else pairs first.
  assert.match(main, /if \(isOwner\) \{[\s\S]{0,200}SetupActivity/);
  assert.match(main, /prefs\.edit\(\)\.putBoolean\("setup_complete", true\)\.apply\(\)/);

  // And the address field must not be painted at all when the address is already known.
  const prov = read('android/app/src/main/java/com/remotedisplay/player/ProvisioningActivity.kt');
  const auto = prov.slice(prov.indexOf('consumePendingAutoConnect()'));
  assert.ok(auto.indexOf('serverSection.visibility = View.GONE') < auto.indexOf('connectToServer'),
    'the entry has to be hidden BEFORE connecting, or it flashes for a frame');
});

test('claiming a screen starts it empty, whatever it was playing before', () => {
  // A reinstalled or factory-reset panel comes back to its ORIGINAL row: the socket recognises
  // the hardware fingerprint and links it there rather than creating a duplicate screen — and a
  // duplicate licence. Right for identity, wrong for content: a screen someone had just paired
  // started playing a playlist they never chose for it.
  assert.match(SERVER,
    /UPDATE devices SET pairing_code = NULL[^"]*playlist_id = NULL, layout_id = NULL/,
    'pairing must clear the content assignment');
});

test('a dead WebView renderer never leaves a screen black forever', () => {
  const wv = read('android/app/src/main/java/com/remotedisplay/player/util/WebViewSupport.kt');
  // Android offers two outcomes and both are wrong on a wall: kill the app (default), or keep a
  // permanently blank WebView while the player still reports itself healthy.
  assert.match(wv, /override fun onRenderProcessGone/);
  assert.match(wv, /Relauncher\.relaunch/);
  assert.match(wv, /return true/);
});

test('the store build ships without what a consumer app store refuses', () => {
  const store = read('android/app/src/loopStore/AndroidManifest.xml');
  // Collapse whitespace so the assertions do not depend on how the XML is wrapped.
  const flat = store.replace(new RegExp(String.fromCharCode(92) + 's+', 'g'), ' ');
  // Each of these is a documented Play rejection risk, and each one is REMOVED rather than
  // merely unused: a permission in the manifest is a permission the reviewer asks about.
  for (const gone of ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION',
    'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS']) {
    assert.ok(flat.includes(`android:name="android.permission.${gone}" tools:node="remove"`),
      `${gone} must be removed`);
  }
  // Accessibility drives remote control, which is not what Play allows accessibility to be for.
  // The device-admin receiver, and the provisioning handshake that exists only to serve it,
  // read as fleet-management software rather than a consumer app.
  for (const comp of ['.service.PowerAccessibilityService', '.admin.STDeviceAdminReceiver', '.admin.ProvisioningActivity']) {
    assert.ok(flat.includes(`android:name="${comp}" tools:node="remove"`),
      `${comp} must be removed`);
  }

  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /create\("loopStore"\)/);
  assert.match(gradle, /buildConfigField\("boolean", "STORE_BUILD", "true"\)/);

  // The permission is stripped, so the updater must not run either: it would download an APK
  // every half hour to die at an install prompt it can never satisfy.
  const main = read('android/app/src/main/java/com/remotedisplay/player/MainActivity.kt');
  assert.match(main, /if \(!BuildConfig\.STORE_BUILD\) updateChecker\.startPeriodicCheck\(\)/);

  // And the panel build keeps all of it — this is a second flavor, not a downgrade of the first.
  const panel = read('android/app/src/main/AndroidManifest.xml');
  assert.match(panel, /PowerAccessibilityService/);
  assert.match(panel, /REQUEST_INSTALL_PACKAGES/);
});

test('the app targets what the stores require, and still runs on the oldest panel', () => {
  // Play refuses a new app that targets an old API level, and the floor rises every August.
  assert.match(GRADLE, /targetSdk = 36/);
  assert.match(GRADLE, /compileSdk = 36/);
  // minSdk stays where it is on purpose: Android 7 boxes are still in the field, and raising
  // this would silently stop them receiving updates rather than fail loudly.
  assert.match(GRADLE, /minSdk = 24/);
  // compileSdk 36 needs a toolchain that understands it — AGP 8.2 could not build it at all,
  // and the old core-library desugaring failed dex merging with no usable message.
  assert.doesNotMatch(read('android/build.gradle.kts'), /version "8\.2\.0"/);
  assert.match(GRADLE, /desugar_jdk_libs:2\.1\.5/);
});
