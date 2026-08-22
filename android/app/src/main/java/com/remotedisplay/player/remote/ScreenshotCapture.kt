package com.remotedisplay.player.remote

import android.graphics.Bitmap
import android.graphics.Canvas
import android.app.Activity
import android.graphics.Rect
import android.os.Build
import android.view.PixelCopy
import java.util.concurrent.atomic.AtomicReference
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ScreenshotCapture {

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Capture the entire view hierarchy including video content.
     * Thread-safe: marshals to main thread if needed.
     */
    fun captureView(view: View, quality: Int = 40): String? {
        /*
         * From the main thread there is no choice but the hand-rolled path: PixelCopy answers
         * through a callback, and waiting for it on the thread that has to deliver it deadlocks
         * until the timeout. In practice this branch is not the one that runs — the capture
         * request arrives on the socket thread.
         */
        if (Looper.myLooper() == Looper.getMainLooper()) return captureOnMainThread(view, quality)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val shot = try { capturePixelCopy(view, quality) } catch (t: Throwable) {
                Log.w("ScreenshotCapture", "PixelCopy threw: ${t.message}"); null
            }
            if (shot != null) return shot
        }

        val latch = CountDownLatch(1)
        var result: String? = null
        mainHandler.post {
            result = captureOnMainThread(view, quality)
            latch.countDown()
        }
        latch.await(3, TimeUnit.SECONDS)
        return result
    }

    /*
     * ASK THE COMPOSITOR WHAT IS ON THE SCREEN, rather than rebuilding it.
     *
     * The fallback below draws the view hierarchy and then composites each TextureView frame ON
     * TOP, because view.draw() leaves a TextureView black. That second pass runs unconditionally
     * last, so ANY view above a video in z-order is painted over by it. With one fullscreen video
     * that is invisible; with a layout that has zones it is wrong. Reported from a two-zone panel:
     * the dashboard capture showed the background clip alone while the weather widget was
     * rotating correctly in the corner of the real screen, which the device log proved.
     *
     * PixelCopy reads the window the compositor already produced, so z-order, rotation, zones and
     * the PiP overlay come out right because nothing is being re-derived. Called only from a
     * background thread — see captureView.
     */
    private fun capturePixelCopy(view: View, quality: Int): String? {
        val ready = CountDownLatch(1)
        val out = AtomicReference<Bitmap?>(null)

        /*
         * Geometry is read ON the main thread and the request issued from there too. Reading
         * width/height and the window location off-thread is the kind of race that produces a
         * correct-looking capture of the wrong rectangle once a week.
         */
        mainHandler.post {
            try {
                val window = (view.context as? Activity)?.window
                val w = view.width; val h = view.height
                if (window == null || w <= 0 || h <= 0) { ready.countDown(); return@post }

                val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                /*
                 * The VIEW inside the window, not the whole window: captureRoot is
                 * android.R.id.content, which leaves out the status bar on a panel that still
                 * has one. Copying the window would band every capture with chrome the wall
                 * never shows.
                 */
                val loc = IntArray(2)
                view.getLocationInWindow(loc)
                val src = Rect(loc[0], loc[1], loc[0] + w, loc[1] + h)

                PixelCopy.request(window, src, bitmap, { result ->
                    if (result == PixelCopy.SUCCESS) out.set(bitmap)
                    else { Log.w("ScreenshotCapture", "PixelCopy result $result — falling back"); bitmap.recycle() }
                    ready.countDown()
                }, mainHandler)
            } catch (t: Throwable) {
                Log.w("ScreenshotCapture", "PixelCopy request failed: ${t.message}")
                ready.countDown()
            }
        }

        ready.await(2, TimeUnit.SECONDS)
        val bmp = out.get() ?: return null
        return encodeBitmap(bmp, quality)
    }

    /**
     * FALLBACK. Must be called on main thread.
     * Draws the view hierarchy + composites TextureView bitmap for video.
     *
     * ⚠️ Composites video LAST, so it paints over anything above it in z-order — the exact
     * limitation capturePixelCopy exists to avoid. Kept for API < 26 and for a system that
     * refuses the copy (a secure surface, most likely).
     */
    private fun captureOnMainThread(view: View, quality: Int): String? {
        return try {
            val w = view.width
            val h = view.height
            if (w <= 0 || h <= 0) {
                Log.w("ScreenshotCapture", "View has no size: ${w}x${h}")
                return null
            }

            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)

            // First draw the view hierarchy (gets UI elements, images, overlays)
            // Note: view.draw() renders TextureView areas as black since video
            // is in a separate hardware surface
            view.draw(canvas)

            // Then composite TextureView content (video) ON TOP
            // This replaces the black areas where video should be
            val textureViews = mutableListOf<TextureView>()
            findAllTextureViews(view, textureViews)
            for (tv in textureViews) {
                if (tv.isAvailable && tv.visibility == View.VISIBLE) {
                    val tvBitmap = tv.bitmap
                    if (tvBitmap != null) {
                        // Place the frame through the SAME transform chain the hierarchy was drawn
                        // with, rather than an axis-aligned rect at getLocationInWindow().
                        //
                        // #236 gave a video-wall panel a mounting rotation, which puts a real
                        // rotation on an ancestor of this TextureView. An axis-aligned rect cannot
                        // express that, so the frame was pasted un-rotated at a position that fell
                        // outside the capture bitmap entirely — and what the dashboard received was
                        // the plain black that view.draw() leaves wherever a TextureView is, i.e. a
                        // panel that looks dead while it is happily playing. Verified on the
                        // emulator: at rotation 90 every remote screenshot of a video came back
                        // #010101 with zero variance, while rotation 0 was correct.
                        val m = matrixTo(tv, view)
                        // The surface bitmap is not required to match the view's size.
                        if (tvBitmap.width > 0 && tvBitmap.height > 0) {
                            m.preScale(tv.width.toFloat() / tvBitmap.width, tv.height.toFloat() / tvBitmap.height)
                        }
                        canvas.drawBitmap(tvBitmap, m, null)
                        tvBitmap.recycle()
                        Log.d("ScreenshotCapture", "Composited TextureView ${tv.width}x${tv.height} via $m")
                    }
                }
            }

            Log.i("ScreenshotCapture", "Composite capture: ${w}x${h}, ${textureViews.size} TextureView(s)")
            encodeBitmap(bitmap, quality)
        } catch (e: Exception) {
            Log.e("ScreenshotCapture", "Capture failed: ${e.message}", e)
            null
        }
    }

    private fun encodeBitmap(bitmap: Bitmap, quality: Int): String = encode(bitmap, quality)

    companion object {
        // Downscale to max width 960 + JPEG + base64. Shared by the view-capture path and the #161
        // accessibility full-screen path (PowerAccessibilityService.takeScreenshot). Recycles inputs.
        fun encode(bitmap: Bitmap, quality: Int): String {
            val toEncode = if (bitmap.width > 960) {
                val scale = 960f / bitmap.width
                val h = (bitmap.height * scale).toInt()
                val scaled = Bitmap.createScaledBitmap(bitmap, 960, h, true)
                if (scaled !== bitmap) bitmap.recycle()
                scaled
            } else {
                bitmap
            }
            val stream = ByteArrayOutputStream()
            toEncode.compress(Bitmap.CompressFormat.JPEG, quality, stream)
            val w = toEncode.width
            val h = toEncode.height
            toEncode.recycle()
            val result = Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
            Log.i("ScreenshotCapture", "Encoded ${w}x${h}, size=${result.length} chars")
            return result
        }
    }

    /**
     * The matrix mapping [view]'s own coordinates into [ancestor]'s, by walking up the parent chain
     * and concatenating each step the way the framework does when it draws a child: the child's own
     * matrix (rotation/scale/translation about its pivot) followed by its layout offset.
     *
     * Stops at [ancestor], or at the top of the View chain if it is never reached — a partial chain
     * still places the frame better than ignoring the transform completely.
     */
    private fun matrixTo(view: View, ancestor: View): android.graphics.Matrix {
        val out = android.graphics.Matrix()
        var v: View = view
        while (true) {
            val local = android.graphics.Matrix(v.matrix)     // translationX/Y + rotation about pivot
            local.postTranslate(v.left.toFloat(), v.top.toFloat())
            out.postConcat(local)                             // out = local * out  (child-first)
            val parent = v.parent
            if (parent !is View || parent === ancestor) break
            v = parent
        }
        return out
    }

    private fun findAllTextureViews(view: View, result: MutableList<TextureView>) {
        if (view is TextureView) {
            result.add(view)
            return
        }
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                findAllTextureViews(view.getChildAt(i), result)
            }
        }
    }
}
