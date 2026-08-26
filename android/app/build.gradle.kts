plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.remotedisplay.player"
    compileSdk = 36

    defaultConfig {
        // The app's permanent identity on Google Play and the Amazon Appstore. It is NOT the
        // Kotlin package (namespace, above), which stays com.remotedisplay.player: that name is
        // internal and invisible, and renaming forty source files to match would buy nothing.
        // Changing THIS after the first store release is not possible — it would be a different
        // app, with a different listing and no upgrade path from the old one.
        applicationId = "br.com.loopplayer.player"
        minSdk = 24
        targetSdk = 36
        // Env-overridable so device-owner reinstalls (which require an ever-increasing
        // versionCode — downgrades are blocked) don't churn this file each build.
        versionCode = (System.getenv("VERSION_CODE") ?: findProperty("VERSION_CODE") as String? ?: "134").toInt()
        versionName = System.getenv("VERSION_NAME") ?: findProperty("VERSION_NAME") as String? ?: "1.9.43"
    }

    /*
     * WHERE THE PLAYER CONNECTS, decided at build time.
     *
     * A Loop Player panel is set up by someone who plugs it in and reads a code off the screen.
     * Asking them to type a server address first is asking them to get it wrong: the address is
     * always the same one, and it is ours. So it is compiled in, and ProvisioningActivity's
     * existing auto-connect path (already used by the device-owner QR) carries the screen
     * straight to its pairing code.
     *
     * The self-hosted flavor keeps the address empty, which is exactly the behaviour this app
     * has always had: type your own server, then pair.
     */
    flavorDimensions += "distribution"
    productFlavors {
        create("loop") {
            dimension = "distribution"
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://player.loopplayer.com.br\"")
            buildConfigField("boolean", "STORE_BUILD", "false")
        }
        create("selfhosted") {
            dimension = "distribution"
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"\"")
            buildConfigField("boolean", "STORE_BUILD", "false")
        }

        /*
         * The build that goes to Google Play and the Amazon Appstore.
         *
         * Same player, minus everything a consumer app store refuses or interrogates: the
         * accessibility service (Play requires accessibility APIs to serve accessibility, and
         * ours drives remote control), the self-updater (an app Play installed is an app Play
         * updates — anything else is Device and Network Abuse), location (asked only to show a
         * Wi-Fi network name), and the device-admin receiver (kiosk and device-owner control,
         * which reads as fleet-management software rather than a consumer app).
         *
         * None of it is lost: it all ships in the `loop` build, which is what a signage panel
         * installs directly — and most signage hardware has no app store at all. The listing
         * serves the cheap consumer boxes and sticks, where the store also does the updating.
         */
        create("loopStore") {
            dimension = "distribution"
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://player.loopplayer.com.br\"")
            buildConfigField("boolean", "STORE_BUILD", "true")
        }
    }

    buildFeatures {
        // AGP 8 stopped generating BuildConfig unless asked; DEFAULT_SERVER_URL above lives there.
        buildConfig = true
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release-key.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD") as String? ?: ""
            keyAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS") as String? ?: "loopplayer"
            keyPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD") as String? ?: ""
            // #81: AGP ignores enableV1Signing at minSdk>=24, so assembleRelease emits a
            // v2-only APK. The v1 (JAR) signature that some MDM-managed signage (MAXHUB)
            // requires is added by the `resignReleaseV1` task below (apksigner re-sign).
        }
    }

    buildTypes {
        debug {
            /*
             * Debug builds are signed with the RELEASE key when it is present, because a panel
             * enrolled as device owner refuses an update signed by a different certificate — so a
             * debug build that could not replace the installed release build would be useless for
             * testing exactly the thing that most needs testing.
             *
             * When the keystore is absent, fall back to Android's own debug key instead of failing.
             * The keystore is deliberately not in the repository, so without this nobody can build
             * and run the app at all until they hold the release key: an odd requirement for
             * compiling a debug APK, and it is what stopped this project building on a fresh
             * machine.
             */
            if (file("../release-key.jks").exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // ScheduleEval uses java.time (Instant/LocalDate/ZoneId), which is API 26 — but minSdk is
        // 24. Without desugaring, per-item dayparting/expiry threw NoClassDefFoundError on Android
        // 7.0/7.1, which are still common on cheap signage sticks and older TV boxes. Because that
        // is an Error and not an Exception, the evaluator's deliberate fail-open guard did not
        // catch it: the playlist update aborted before content downloaded, and the cold-start path
        // then cleared the playlist cache — so the screen sat on "waiting for content" and a reboot
        // did not help.
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        // Let JVM unit tests exercise Android-dependent code paths (e.g. ContentCache's real
        // download logic, which logs via android.util.Log) without Robolectric — stubbed Android
        // APIs return defaults instead of throwing "not mocked".
        unitTests.isReturnDefaultValues = true
    }

    // feat/transition-engine: the GL transition shaders ship as assets, COPIED from shared/Transitions
    // at build (the single source of truth — same .glsl the web bundle + Tizen build assemble from),
    // so the native compositor can't drift from the other players. See copyTransitionShaders below.
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/transitionAssets"))
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ExoPlayer / Media3
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")

    // Socket.IO client.
    //
    // org.json is excluded deliberately. socket.io-client pulls org.json:json:20090211
    // transitively, and that artifact was being packaged into the APK in full — 19 classes,
    // including CDL, XML, JSONML and its own Test class. It carries the JSON License, whose
    // "shall be used for Good, not Evil" clause is not OSI-approved, is treated as non-free by
    // Debian and Fedora, and is Category X at Apache. Shipping it in a commercially distributed
    // binary is an avoidable licensing problem: it is not copyleft, but it is not a licence we
    // want to have to explain.
    //
    // Nothing is lost. Android provides org.json in the platform (since API 1, and minSdk is 24),
    // and the only classes either side actually touches are JSONObject, JSONArray and JSONTokener.
    // The full method surface used — by socket.io/engine.io and by our own Kotlin — is
    // get/getString/getLong/getJSONArray/getJSONObject/has/keys/length/isNull/put/NULL,
    // the opt* family, and JSONTokener.nextValue. Every one is platform API.
    implementation("io.socket:socket.io-client:2.1.0") {
        exclude(group = "org.json", module = "json")
    }

    // WorkManager for background downloads
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Gson for JSON
    implementation("com.google.code.gson:gson:2.10.1")

    // OkHttp for file downloads
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // #74/#75: unit tests for the Kotlin schedule evaluator (vector drift guard)
    testImplementation("junit:junit:4.13.2")
    // feat/transition-engine: real org.json on the unit-test classpath (the stubbed android.jar one
    // returns defaults with isReturnDefaultValues=true) so TransitionParseTest exercises actual parsing.
    testImplementation("org.json:json:20231013")
}

// feat/transition-engine: copy the shared GL transition shaders into a generated assets dir so the
// native compositor loads the SAME .glsl the web/Tizen players do (no checked-in copy to drift). Wired
// ahead of asset merge for every variant.
val copyTransitionShaders by tasks.registering(Copy::class) {
    from(File(rootProject.projectDir.parentFile, "shared/Transitions")) { include("*.glsl") }
    into(layout.buildDirectory.dir("generated/transitionAssets/transitions"))
}
tasks.matching { it.name == "preBuild" || it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(copyTransitionShaders) }

// #74/#75: point the evaluator drift-guard test at the SHARED vector contract
// (shared/schedule-vectors.json, the single source - no snapshot). rootProject is
// the android/ Gradle root; its parent is the repo root. Any ScheduleEval.kt edit
// that breaks a vector fails ScheduleEvalTest in CI.
tasks.withType<Test> {
    systemProperty("scheduleVectors", File(rootProject.projectDir.parentFile, "shared/schedule-vectors.json").absolutePath)
}

// #81: AGP ignores enableV1Signing at minSdk>=24, so `assembleRelease` produces a
// v2-only APK - and some MDM-managed signage (MAXHUB/Pivot) silently removes a v2-only
// app on the next reboot because its boot integrity check expects a v1 (JAR) signature.
// Re-sign the assembled release APK with apksigner, forcing a low --min-sdk-version so
// the v1 signature is emitted alongside v2/v3. v1+v2+v3 verifies on every Android
// version (legacy MDM hardware via v1, modern Android via v2/v3).
tasks.register("resignReleaseV1") {
    // Resolved here, not inside doLast: the signingConfig above accepts either an environment
    // variable or a Gradle property, and this task only ever read the environment — so a build
    // whose password lives in ~/.gradle/gradle.properties (the normal place for it) handed
    // apksigner an empty password and failed with a bare "exit value 2".
    val ksPass = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD") as String? ?: ""
    val keyPass = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD") as String? ?: ""
    val keyAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS") as String? ?: "loopplayer"

    doLast {
        // Every release APK the build produced, whatever flavor it belongs to. Hardcoding
        // outputs/apk/release/app-release.apk stopped matching the moment flavors arrived, and a
        // task that quietly finds nothing to sign is worse than one that fails.
        val outputs = layout.buildDirectory.dir("outputs/apk").get().asFile
        if (!outputs.exists()) return@doLast
        val apks = outputs.walkTopDown()
            .filter { it.isFile && it.extension == "apk" && it.parentFile.name == "release" }
            .toList()
        if (apks.isEmpty()) return@doLast

        val sdkDir = System.getenv("ANDROID_HOME")
            ?: System.getenv("ANDROID_SDK_ROOT")
            ?: rootProject.file("local.properties").takeIf { it.exists() }
                ?.readLines()?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")?.trim()
            ?: throw GradleException("#81 resign: set ANDROID_HOME or sdk.dir in local.properties")
        val buildTools = File(sdkDir, "build-tools").listFiles()
            ?.filter { it.isDirectory }?.maxByOrNull { it.name }
            ?: throw GradleException("#81 resign: no build-tools found under $sdkDir")

        // apksigner ships as a shell script on Linux and a .bat on Windows. The original
        // hardcoded the extensionless name, which is fine in CI and fails on a Windows desktop —
        // the machine where a release is most likely to be cut by hand.
        val isWindows = System.getProperty("os.name").orEmpty().startsWith("Windows", ignoreCase = true)
        val apksigner = File(buildTools, if (isWindows) "apksigner.bat" else "apksigner")

        apks.forEach { apk ->
            project.exec {
                commandLine(
                    apksigner.absolutePath, "sign",
                    "--ks", file("../release-key.jks").absolutePath,
                    "--ks-key-alias", keyAlias,
                    "--ks-pass", "pass:" + ksPass,
                    "--key-pass", "pass:" + keyPass,
                    "--v1-signing-enabled", "true",
                    "--v2-signing-enabled", "true",
                    "--v3-signing-enabled", "true",
                    "--min-sdk-version", "19",
                    apk.absolutePath
                )
            }
        }
    }
}
// AGP registers these lazily, so match them when/after they are created.
//
// EVERY assemble*Release, not just the flavourless aggregate: with product flavors the task that
// actually builds the panel APK is assembleLoopRelease, and that is what the release script calls.
// Hooking only "assembleRelease" meant the v1 signature — the thing that stops MDM-managed panels
// deleting the app on the next reboot — was silently never applied to the APK we ship.
tasks.matching { it.name.startsWith("assemble") && it.name.endsWith("Release") }
    .configureEach { finalizedBy("resignReleaseV1") }
