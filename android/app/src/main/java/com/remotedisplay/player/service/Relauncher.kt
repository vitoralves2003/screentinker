package com.remotedisplay.player.service

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import com.remotedisplay.player.MainActivity
import com.remotedisplay.player.RemoteDisplayApp

/**
 * Brings the player back to the foreground after a trigger (device boot or a self-update).
 * Shared by [BootReceiver] and [PackageReplacedReceiver] so both relaunch through the SAME
 * cascade (#96).
 *
 * A BroadcastReceiver runs in the background, and Android 10+ blocks a bare startActivity
 * from the background. The cascade, most-reliable first:
 *
 *   1. Direct startActivity — legal below Android 10 with NO permission at all (the
 *      restriction did not exist yet), and legal on 10+ when SYSTEM_ALERT_WINDOW is granted
 *      (the documented exemption). Covers MAXHUB (elevated), any properly-onboarded device, and
 *      Fire OS 7 (Android 9). This line described the rule correctly for a long time while the
 *      code below tested only the overlay half of it — which is what stranded Fire TV.
 *   2. Notification — on Android <14 a full-screen intent AUTO-LAUNCHES the activity (covers
 *      FireOS, which is Android 9–11); on 14+, where USE_FULL_SCREEN_INTENT is auto-revoked,
 *      it degrades to a VISIBLE, tappable "tap to resume" prompt. That is the requirement
 *      (a) fail-loud path: human-recoverable, never a silent dark screen. The server sees
 *      the device's next check-in — or its absence — via the #96 update logging.
 *
 * The only device class with no path here is vanilla Android 14+ with neither the overlay
 * granted nor the app set as home launcher — for those it stops at the visible prompt.
 */
object Relauncher {
    private const val TAG = "Relauncher"
    const val UPDATE = "update"
    const val BOOT = "boot"
    const val RESTART = "restart"

    /**
     * A REAL restart: schedule the way back, then end the process.
     *
     * WHY THIS EXISTS. The dashboard's "Reiniciar aplicativo" sent "launch", which is
     * startActivity(MainActivity) with CLEAR_TOP — it brings the player to the FRONT. On a signage
     * panel the player is already the front, so the button did nothing at all, and had done nothing
     * since it was written.
     *
     * THE ORDER IS LOAD-BEARING. Killing first leaves nothing running to schedule the return, so
     * the alarm is set before the process ends.
     *
     * ── WHY IT NO LONGER REFUSES, AND WHY IT WAS WRONG TO ────────────────────────────────────
     * The first version demanded SYSTEM_ALERT_WINDOW and gave up without it, reasoning that
     * nothing could bring the player back. That is only true of ONE of the three paths this file
     * already had. A Fire TV is Android underneath but exposes no Settings screen for "draw over
     * other apps", so canDrawOverlays() is false and cannot be made true from the box — and
     * restart refused on hardware where boot-time relaunch had been working all along, through the
     * full-screen-intent notification two paths down.
     *
     * The fix is to stop deciding here. The alarm now wakes [RestartReceiver], which runs the SAME
     * cascade as boot and post-update: overlay-direct if available, full-screen intent if not, and
     * a visible tap-to-resume prompt as the floor. Never a silent dark screen, and never a refusal
     * on a device that had a way back the whole time.
     *
     * A RECEIVER, not an activity, for a second reason: an alarm delivering an activity
     * PendingIntent is still a background activity launch on Android 10+. The alarm grants no
     * exemption, so the old path was fragile even where the overlay HAD been granted.
     *
     * The alarm is deliberately INEXACT (set, not setExactAndAllowWhileIdle): exact alarms need
     * SCHEDULE_EXACT_ALARM from Android 12, which this app does not hold and does not need. A
     * second either way is nothing next to the app being gone.
     *
     * @return true when the process is about to end, false when the alarm could not be scheduled —
     *         the one case where ending the process really would leave nothing behind.
     */
    fun restart(context: Context): Boolean {
        val wake = Intent(context, RestartReceiver::class.java).apply {
            action = RestartReceiver.ACTION
            `package` = context.packageName
        }
        val pi = PendingIntent.getBroadcast(
            context, 424242, wake,
            PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return try {
            val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
            am.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 1500, pi)
            Log.i(TAG, "[restart] relaunch scheduled via RestartReceiver; ending the process " +
                "(overlay=${Settings.canDrawOverlays(context)})")

            // A moment for the WebSocket to flush its acknowledgement, so the dashboard learns the
            // command was taken rather than watching the socket drop and guessing.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                android.os.Process.killProcess(android.os.Process.myPid())
            }, 400)
            true
        } catch (e: Exception) {
            // Nothing was killed, so the player is still running and still showing content.
            Log.e(TAG, "[restart] could not schedule the relaunch, staying up: ${e.message}")
            false
        }
    }

    fun relaunch(context: Context, reason: String) {
        // Keep the WS foreground service alive (it drives playback + reconnect).
        try {
            val svc = Intent(context, WebSocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc)
            else context.startService(svc)
            Log.i(TAG, "[$reason] WebSocket service started")
        } catch (e: Exception) {
            Log.e(TAG, "[$reason] Failed to start service: ${e.message}")
        }

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }

        /*
         * 1. Direct launch — legal whenever the platform ALLOWS it, which is a different question
         *    from whether the overlay permission is granted.
         *
         * THE BUG THIS FIXES, and the doc comment at the top of this file already knew it: the
         * background-activity-launch restriction arrived in Android 10 (API 29). BELOW that there
         * is nothing to be exempt FROM — startActivity from a receiver simply works.
         *
         * The gate asked only about the overlay, so on a Fire TV Stick — Fire OS 7, which is
         * Android 9 — this path was skipped on a device where it needed no permission at all. What
         * remained was the notification, and Fire TV does not auto-launch from one. The result was
         * a player that exited on restart and never came back, and an auto-start after reboot that
         * never fired, on hardware where the simplest path had been legal the whole time.
         */
        val platformAllowsBackgroundLaunch =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Settings.canDrawOverlays(context)

        var launched = false
        if (platformAllowsBackgroundLaunch) {
            try {
                context.startActivity(launchIntent)
                launched = true
                Log.i(TAG, "[$reason] Direct launch (sdk=${Build.VERSION.SDK_INT}, " +
                    "overlay=${Settings.canDrawOverlays(context)})")
            } catch (e: Exception) {
                // Not fatal: the notification below is exactly the fallback for this.
                Log.e(TAG, "[$reason] Direct launch failed: ${e.message}")
            }
        } else {
            Log.i(TAG, "[$reason] Direct launch unavailable (Android ${Build.VERSION.SDK_INT}, no overlay)")
        }

        // 2. Notification: <14 full-screen-intent auto-launch; 14+/no-overlay the visible
        //    tap-to-resume prompt. Posted even if (1) launched, so a 14+ device that could
        //    not auto-launch always has a tappable way back (fail loud, never dark).
        postRelaunchNotification(context, launchIntent, reason, launched)
    }

    private fun postRelaunchNotification(context: Context, launchIntent: Intent, reason: String, alreadyLaunched: Boolean) {
        try {
            val pi = PendingIntent.getActivity(
                context, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val isUpdate = reason == UPDATE
            val builder = NotificationCompat.Builder(context, RemoteDisplayApp.BOOT_CHANNEL_ID)
                .setContentTitle(if (isUpdate) "Loop Player atualizado" else "Loop Player")
                .setContentText(if (isUpdate) "Tap to resume the display" else "Starting display...")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setContentIntent(pi)              // tap -> launch (the path on 14+ where FSI is revoked)
                .setFullScreenIntent(pi, true)     // <14: auto-launch
                .setAutoCancel(true)
            // Fail-loud: if we could not auto-launch (14+, no overlay), keep the prompt
            // sticky until the operator taps it to resume.
            if (isUpdate && !alreadyLaunched) builder.setOngoing(true)

            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(999, builder.build())
            Log.i(TAG, "[$reason] Relaunch notification posted (fullScreenIntent + tappable, ongoing=${isUpdate && !alreadyLaunched})")
        } catch (e: Exception) {
            Log.e(TAG, "[$reason] Notification failed: ${e.message}")
            if (!alreadyLaunched) {
                // last-ditch: try a direct launch even though bg-launch may be blocked.
                try { context.startActivity(launchIntent) } catch (e2: Exception) { Log.e(TAG, "[$reason] Last-ditch launch failed: ${e2.message}") }
            }
        }
    }
}
