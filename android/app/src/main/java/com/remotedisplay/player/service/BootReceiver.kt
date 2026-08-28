package com.remotedisplay.player.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        /*
         * MORE THAN ONE WAY TO LEARN THE BOX CAME BACK.
         *
         * Three actions used to be the whole list, and on hardware that delivers none of them the
         * player simply never returned. The competitor's app listens to seven, which is not
         * cleverness — it is the acknowledgement that every vendor fires a different subset and
         * none of them is guaranteed.
         *
         *   LOCKED_BOOT_COMPLETED fires EARLIER than BOOT_COMPLETED, before the user data
         *     partition is unlocked. Cheap insurance on a device that reboots unattended.
         *   USER_PRESENT fires when the device becomes interactive. On a TV box left on a screen
         *     saver it is often the first thing that happens after a power blip.
         *   REBOOT and the QUICKBOOT pair cover vendors that never send the standard one.
         *
         * Relaunching more than once is harmless: MainActivity is launched with CLEAR_TOP, so a
         * second call lands on the activity already running.
         */
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.LOCKED_BOOT_COMPLETED" ||
            action == "android.intent.action.REBOOT" ||
            action == Intent.ACTION_USER_PRESENT ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON") {

            Log.i("BootReceiver", "Boot signal (action=$action), launching Loop Player")
            // #96: boot + post-update relaunch share one cascade (overlay-direct -> FSI/
            // tap-to-resume). See Relauncher.
            Relauncher.relaunch(context, Relauncher.BOOT)
        }
    }
}
