package com.remotedisplay.player.util

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URL

/**
 * Safe bitmap loader. Reads dimensions first via inJustDecodeBounds, then decodes
 * with an inSampleSize that scales the image down to the device's screen resolution.
 * A 4K source image on a 1080p screen ends up as 1920x1080, not 3840x2160 — keeps
 * the bitmap under ~8 MB instead of ~33 MB.
 *
 * #170: BitmapFactory ignores EXIF orientation, so a portrait photo (landscape pixels
 * tagged "rotate 90") would render sideways. We apply the EXIF rotation after decode.
 * (The server-side ingest fix corrects stored dimensions + the thumbnail; this is the
 * companion so the panel itself draws the photo upright — videos are already handled by
 * ExoPlayer's rotation matrix.)
 *
 * All exceptions, including OutOfMemoryError, return null so the caller can skip the
 * item rather than crashing the whole app.
 */
object ImageLoader {
    private const val TAG = "ImageLoader"

    /*
     * THE TARGET IS THE OUTPUT RESOLUTION, not the render surface.
     *
     * displayMetrics reports the surface the UI is drawn into. Many TV boxes and sticks — Fire TV
     * among them — render that at 1280x720 and let the hardware scaler lift it to a 1080p or 4K
     * HDMI signal. telemetry/DeviceInfo.kt already documents exactly this (#134): a panel showing
     * a real 1080p signal reported itself as 720p.
     *
     * Aiming at the surface therefore aimed low, and the old sample-size maths then landed lower
     * still: a 1080p image on such a stick decoded to 960x540, was stretched to 720p, and was
     * upscaled again to 1080p by the hardware. Half the resolution, enlarged twice.
     *
     * Decoding to the OUTPUT size costs some memory on a box whose surface is smaller, and buys
     * every pixel that surface can actually show. Falls back to the surface whenever the display
     * mode is unavailable, which is also the correct answer on a normal panel where the two agree.
     */
    fun screenWidth(ctx: Context): Int = outputSize(ctx).first
    fun screenHeight(ctx: Context): Int = outputSize(ctx).second

    private fun outputSize(ctx: Context): Pair<Int, Int> {
        val dm = ctx.resources.displayMetrics
        val surface = dm.widthPixels to dm.heightPixels
        return try {
            val wm = ctx.getSystemService(Context.WINDOW_SERVICE) as android.view.WindowManager
            @Suppress("DEPRECATION")
            val mode = wm.defaultDisplay?.mode
            val pw = mode?.physicalWidth ?: 0
            val ph = mode?.physicalHeight ?: 0
            // Never smaller than the surface: on a software-rotated portrait stage the mode is
            // reported in the panel's own orientation, and taking the smaller of the two would
            // undo the whole point of this.
            if (pw > 0 && ph > 0) maxOf(pw, surface.first) to maxOf(ph, surface.second) else surface
        } catch (e: Throwable) {
            surface
        }
    }

    fun decodeFile(file: File, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.absolutePath, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                Log.w(TAG, "Invalid image dimensions for ${file.name}")
                return null
            }
            val opts = BitmapFactory.Options().apply {
                inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)
            }
            val decoded = BitmapFactory.decodeFile(file.absolutePath, opts) ?: return null
            val bmp = scaleToFit(decoded, maxW, maxH)
            // #170: honor EXIF orientation (read from the file; JPEGs from phones carry it).
            val orientation = try {
                ExifInterface(file.absolutePath).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }
            applyExifOrientation(bmp, orientation)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${file.name}: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${file.name}: ${e.message}")
            null
        }
    }

    fun decodeUrl(url: String, maxW: Int, maxH: Int): Bitmap? {
        // Reject anything that isn't HTTP/HTTPS. URL.openConnection() otherwise
        // happily handles file://, jar:, ftp:, etc. — which would let a server-supplied
        // remote_url read local files off the device or talk to internal services.
        val scheme = try { URL(url).protocol?.lowercase() } catch (_: Throwable) { null }
        if (scheme != "http" && scheme != "https") {
            Log.w(TAG, "Rejecting non-http(s) URL scheme: $scheme")
            return null
        }
        return try {
            val bytes = URL(url).openConnection().apply {
                connectTimeout = 10_000
                readTimeout = 30_000
            }.getInputStream().use { it.readBytes() }
            decodeBytes(bytes, maxW, maxH)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM downloading $url: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to download $url: ${e.message}")
            null
        }
    }

    private fun decodeBytes(bytes: ByteArray, maxW: Int, maxH: Int): Bitmap? {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            val opts = BitmapFactory.Options().apply {
                inSampleSize = calcSampleSize(bounds.outWidth, bounds.outHeight, maxW, maxH)
            }
            val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null
            val bmp = scaleToFit(decoded, maxW, maxH)
            // #170: honor EXIF orientation for remote images too (ExifInterface(stream) is API 24+).
            val orientation = try {
                ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }
            applyExifOrientation(bmp, orientation)
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM decoding ${bytes.size} bytes: ${e.message}")
            null
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to decode ${bytes.size} bytes: ${e.message}")
            null
        }
    }

    /**
     * The largest power-of-two decimation that still leaves the image AT OR ABOVE the target.
     *
     * THE BUG THIS REPLACES, and it was not subtle. The old loop doubled until the result fitted
     * INSIDE the target, so it always landed on the low side of it — and inSampleSize only moves
     * in halves. A 1921x1081 photo on a 1920x1080 screen decoded to 960x540: one pixel over the
     * line cost half the resolution, and the ImageView then stretched it back up. A 4000x2250
     * photo came out at 1000x562, barely half the screen. Everything looked serrated, which is
     * exactly how it was reported.
     *
     * Landing ABOVE the target is only half the fix; [scaleToFit] does the rest. Decimation alone
     * throws pixels away, so the remainder still has to be resampled DOWN with filtering rather
     * than stretched up without it.
     */
    private fun calcSampleSize(srcW: Int, srcH: Int, maxW: Int, maxH: Int): Int {
        if (maxW <= 0 || maxH <= 0) return 1
        var sample = 1
        // Stop BEFORE the step that would take either axis below the target.
        while (srcW / (sample * 2) >= maxW && srcH / (sample * 2) >= maxH) sample *= 2
        return sample
    }

    /**
     * Resample to the target with filtering, preserving aspect ratio.
     *
     * inSampleSize is a box decimation — it drops pixels on a grid and leaves hard edges. What
     * survived it is still larger than the screen, so it gets scaled down properly here, once,
     * with bilinear filtering. Scaling DOWN with a filter is what removes the stair-stepping;
     * letting the ImageView stretch a too-small bitmap UP is what created it.
     *
     * An image already at or below the target is returned untouched: enlarging it would invent
     * detail and cost memory, and the ImageView can stretch it just as badly for free.
     */
    private fun scaleToFit(src: Bitmap, maxW: Int, maxH: Int): Bitmap {
        if (maxW <= 0 || maxH <= 0) return src
        if (src.width <= maxW && src.height <= maxH) return src

        val ratio = minOf(maxW.toDouble() / src.width, maxH.toDouble() / src.height)
        val w = maxOf(1, Math.round(src.width * ratio).toInt())
        val h = maxOf(1, Math.round(src.height * ratio).toInt())
        if (w == src.width && h == src.height) return src

        return try {
            val out = Bitmap.createScaledBitmap(src, w, h, true)   // true = bilinear filtering
            if (out !== src) src.recycle()
            out
        } catch (e: OutOfMemoryError) {
            // A soft image beats no image. The caller already has something drawable.
            Log.w(TAG, "OOM rescaling to ${w}x${h}; keeping the decoded size")
            src
        } catch (e: Throwable) {
            Log.w(TAG, "Rescale failed: ${e.message}")
            src
        }
    }

    // #170: rotate/flip a just-decoded bitmap per its EXIF orientation so portrait photos
    // render upright. Returns the input unchanged for NORMAL/UNDEFINED (no allocation), and
    // recycles the source once a transformed copy is made. Falls back to the source on OOM
    // rather than crashing — a sideways image beats a dead player.
    private fun applyExifOrientation(bitmap: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(270f); m.postScale(-1f, 1f) }
            else -> return bitmap // NORMAL, UNDEFINED, or unknown -> leave as-is
        }
        return try {
            val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
            if (rotated != bitmap) bitmap.recycle()
            rotated
        } catch (e: OutOfMemoryError) {
            Log.e(TAG, "OOM applying EXIF orientation $orientation: ${e.message}")
            bitmap
        }
    }
}
