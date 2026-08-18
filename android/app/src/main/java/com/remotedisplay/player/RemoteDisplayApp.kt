package com.remotedisplay.player

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import android.util.Log
import com.remotedisplay.player.data.ServerConfig

class RemoteDisplayApp : Application() {

    companion object {
        const val CHANNEL_ID = "remote_display_service"
        const val CHANNEL_NAME = "Loop Player"
        // Separate HIGH-importance channel for the boot full-screen-intent launch.
        // A full-screen intent is only honored from a high-importance channel.
        const val BOOT_CHANNEL_ID = "remote_display_boot"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        seedBuiltInServer()
        installCrashExitSignal()
    }

    /*
     * The address this build was compiled for, written once, on the very first launch.
     *
     * Placed in the Application rather than in SetupActivity because there is more than one way
     * into this app — the launcher, the boot receiver, a relaunch after an update — and a panel
     * that came up through any of the others would otherwise still be sitting on an empty URL
     * field. Here it is true before any screen exists.
     *
     * It only ever fills a BLANK. A panel that has already been pointed somewhere — by pairing,
     * by the device-owner QR, or by a support technician through the PIN-gated menu — keeps that
     * address; this must never drag a screen back to the default behind someone's back.
     *
     * setPendingAutoConnect is what turns a pre-filled address into a finished setup:
     * ProvisioningActivity consumes it, skips the URL entry, and shows the pairing code.
     */
    private fun seedBuiltInServer() {
        val builtIn = BuildConfig.DEFAULT_SERVER_URL.trim().trimEnd('/')
        if (builtIn.isEmpty()) return                     // self-hosted build: ask, as always
        try {
            val config = ServerConfig(this)
            if (config.serverUrl.isNotEmpty()) return     // already pointed somewhere: leave it
            config.serverUrl = builtIn
            config.setPendingAutoConnect(true)
            Log.i("LoopPlayer", "server preset to $builtIn")
        } catch (e: Exception) {
            // Never block startup over this. Without it the setup screen simply asks for the URL,
            // which is the behaviour every earlier build had.
            Log.w("LoopPlayer", "could not preset the server url: ${e.message}")
        }
    }

    // Exit-signal contract v1 — 'crashed'. A global uncaught-exception handler fires a BEST-EFFORT
    // blocking last-gasp to the server, then delegates to the previous default handler so the crash
    // still propagates and the process dies normally. Runs on the crashing thread (already dying), so
    // the short blocking POST is acceptable. BEST-EFFORT: a native/OOM kill runs no JVM handler ->
    // nothing is sent -> the server infers 'silent'. Honesty: only ever emits 'crashed' here.
    private fun installCrashExitSignal() {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val detail = (throwable.javaClass.simpleName + ": " + (throwable.message ?: "")).trim()
                com.remotedisplay.player.service.ExitSignal.send(this, "crashed", detail)
            } catch (t: Throwable) { /* never mask the original crash */ }
            prev?.uncaughtException(thread, throwable)   // chain -> normal crash reporting + process death
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Mantém a tela conectada ao Loop Player"
                    setShowBadge(false)
                }
            )
            manager.createNotificationChannel(
                NotificationChannel(BOOT_CHANNEL_ID, "Loop Player — inicialização", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Abre a tela quando o aparelho liga"
                    setShowBadge(false)
                }
            )
        }
    }
}
