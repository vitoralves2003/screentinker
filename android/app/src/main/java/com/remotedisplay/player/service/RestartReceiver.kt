package com.remotedisplay.player.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * The way back after [Relauncher.restart] ends the process.
 *
 * WHY A RECEIVER AND NOT AN ACTIVITY. The first version of restart() scheduled a
 * PendingIntent.getActivity and had AlarmManager fire it directly. Two things wrong with that:
 *
 *   1. An alarm delivering an ACTIVITY PendingIntent is still a background activity launch on
 *      Android 10+. The alarm does not grant the exemption, so the path was fragile even on a
 *      device where the overlay permission had been granted.
 *   2. It bypassed the relaunch cascade this file spent an issue getting right, so it inherited
 *      none of the fallbacks — in particular the full-screen-intent notification, which is the
 *      only path that works on a device where the overlay permission cannot be granted at all.
 *
 * A Fire TV is exactly that device. It is Android underneath but has no Settings screen for
 * "draw over other apps", so canDrawOverlays() is false and cannot be made true from the box.
 * restart() therefore refused, every time, on hardware where boot-time relaunch already worked
 * fine through the notification.
 *
 * Waking a receiver instead puts restart on the SAME cascade as boot and post-update: overlay
 * direct if it is available, full-screen intent if it is not, and a visible tap-to-resume prompt
 * as the floor. One way back, tried three ways, rather than one way that gives up.
 */
class RestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        Log.i(TAG, "Restart alarm fired; bringing the player back through the relaunch cascade")
        Relauncher.relaunch(context, Relauncher.RESTART)
    }

    companion object {
        private const val TAG = "RestartReceiver"

        /* Explicit and package-scoped: an implicit action would let anything on the device ask
           this player to restart. */
        const val ACTION = "com.remotedisplay.player.RESTART_NOW"
    }
}
