package com.remotedisplay.player.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.SurfaceTexture
import android.graphics.drawable.BitmapDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.TextureView
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import com.remotedisplay.player.util.ImageLoader
import java.io.File

class MediaPlayerManager(
    private val context: Context,
    private val playerView: PlayerView,
    private val imageView: ImageView,
    private val youtubeWebView: WebView? = null,
    private val onVideoComplete: () -> Unit,
    private val onImageError: (() -> Unit)? = null,
    // feat/transition-engine: the full-screen GL overlay that plays a from->to wipe. Null = no
    // transitions (every render hard-cuts, exactly as before).
    private val transitionView: TransitionGLView? = null
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var exoPlayer: ExoPlayer? = null
    private var currentType: MediaType = MediaType.NONE
    // The URL the widget WebView currently has loaded, so re-showing the same widget can be a
    // no-op. Cleared whenever anything else takes the surface (see clearWidgetUrl callers).
    private var currentWidgetUrl: String? = null
    // Wall mode: followers must stay muted even as the leader's sync switches them
    // to a new (possibly unmuted) item, so the mute has to survive each playVideo.
    private var wallMute = false
    // #group-sync loop state, tracked so it can be applied to a freshly-swapped double-buffer player.
    private var videoLooping = false
    // #group-sync double buffer: a second ExoPlayer that pre-opens/pre-buffers the NEXT clip so the
    // boundary switch is a warm swap (~100-300ms) instead of a cold prepare (~1-2s black hold). Only
    // engaged when preloadVideo() is called ahead of a boundary (group sync); the wall/solo paths are
    // untouched (they never preload, so playVideo takes the normal cold path).
    private var preloadPlayer: ExoPlayer? = null
    private var preloadedFile: File? = null
    // Throwaway offscreen surface for the preload player: it forces the preload clip to decode frame 0
    // and populate its video size BEFORE the swap, so PlayerView doesn't reset the aspect to "fill"
    // (a one-frame landscape stretch) while it waits for the new player's first video-size report.
    private var warmTexture: SurfaceTexture? = null
    private var warmSurface: Surface? = null

    enum class MediaType { NONE, VIDEO, IMAGE, YOUTUBE, WIDGET }

    init {
        setupExoPlayer()
    }

    // Build a player with the shared end/error listener so BOTH the active and the preload player
    // advance/self-heal identically once either is the visible one.
    private fun buildPlayer(): ExoPlayer = ExoPlayer.Builder(context).build().also { player ->
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                // Only the ACTIVE (view-attached) player drives advance; ignore the preload player's
                // own state changes (it's parked with playWhenReady=false and never ENDs while parked).
                if (playbackState == Player.STATE_ENDED && player === exoPlayer) onVideoComplete()
            }
            // Root-2: a corrupt/undecodable video used to freeze the playlist forever — only
            // STATE_ENDED advanced, and an error goes to STATE_IDLE, so onVideoComplete never
            // fired. Treat a playback error like a completion so the loop moves on instead of
            // wedging on the broken item (mirrors the web/.wgt onerror -> advance).
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                Log.e("MediaPlayerManager", "Playback error (${error.errorCodeName}) — advancing: ${error.message}")
                if (player === exoPlayer) onVideoComplete()
            }
        })
    }

    private fun setupExoPlayer() {
        // Hold the last frame instead of flashing black during a reset/prepare — turns any residual
        // switch gap into a brief freeze-frame rather than a black hold.
        try { playerView.setKeepContentOnPlayerReset(true) } catch (e: Throwable) {}
        exoPlayer = buildPlayer().also { playerView.player = it }
    }

    // #129: remembered so the live device:mute-changed toggle knows YouTube's current
    // state and the IFrame API bridge can flip it without reloading the embed.
    private var youtubeMuted = false

    // ---- feat/transition-engine: GL wipe helpers. Every failure path returns false/null so the caller
    // hard-cuts (never a blank frame). Solo fullscreen only — suppressed for wall followers and group/
    // loop sync (they own their own frame timing). ----
    private fun transitionsActive(): Boolean = transitionView != null && !wallMute && !videoLooping

    // The frame on screen now, as a bitmap, for the wipe's `from`. Image -> the ImageView bitmap; video
    // -> the ExoPlayer TextureView's current frame. Null (youtube/widget/none/unavailable) -> hard cut.
    private fun captureCurrentFrame(): Bitmap? = try {
        when (currentType) {
            MediaType.IMAGE -> (imageView.drawable as? BitmapDrawable)?.bitmap
            MediaType.VIDEO -> (playerView.videoSurfaceView as? TextureView)?.let { tv ->
                if (tv.isAvailable && tv.width > 0 && tv.height > 0) tv.bitmap else null
            }
            else -> null
        }
    } catch (e: Throwable) { null }

    // Pick one effect at random (variety) and resolve its wrapped fragment source + params. Null if the
    // shader isn't in assets -> hard cut.
    private fun pickEffect(spec: TransitionSpec): Pair<String, Map<String, Float>>? {
        if (spec.effects.isEmpty()) return null
        val idx = (Math.random() * spec.effects.size).toInt().coerceIn(0, spec.effects.size - 1)
        val e = spec.effects[idx]
        val src = TransitionGlsl.loadSource(context.assets, e.shader) ?: return null
        return TransitionGlsl.fragmentFor(src) to e.params
    }

    // Run a from->to wipe, then `swap` (the plain mount) on completion. Returns false if it can't start
    // (the caller must then swap immediately). `swap` is the SAME plain mount the no-transition path uses.
    private fun runWipe(toBitmap: Bitmap, spec: TransitionSpec?, from: Bitmap?, swap: () -> Unit): Boolean {
        val view = transitionView
        if (view == null || spec == null || from == null || !transitionsActive()) return false
        val picked = pickEffect(spec) ?: return false
        val w = ImageLoader.screenWidth(context); val h = ImageLoader.screenHeight(context)
        if (w <= 0 || h <= 0) return false
        val fromFit: Bitmap; val toFit: Bitmap
        try { fromFit = fitTransitionBitmap(from, w, h); toFit = fitTransitionBitmap(toBitmap, w, h) }
        catch (e: Throwable) { Log.w("MediaPlayerManager", "wipe fit failed: ${e.message}"); return false }
        view.play(fromFit, toFit, picked.first, picked.second, spec.durationMs) { swap() }
        return true
    }

    // Extract a local video's first frame as a bitmap (the wipe's `to` for image->video / video->video).
    // Blocking — call off the main thread. Null on any failure -> hard cut.
    private fun extractFirstFrame(path: String): Bitmap? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(path)
            r.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } catch (e: Throwable) { Log.w("MediaPlayerManager", "first-frame extract failed: ${e.message}"); null }
        finally { try { r.release() } catch (_: Throwable) {} }
    }

    // Plain image mount (visibility flip + set bitmap). Shared by the transition-done swap and the
    // no-transition hard cut.
    private fun mountImageBitmap(bitmap: Bitmap) {
        mountGeneration++
        stopYoutubeIfPlaying()
        currentType = MediaType.IMAGE
        currentWidgetUrl = null   // surface reused - a later widget show must reload
        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.VISIBLE
        youtubeWebView?.visibility = android.view.View.GONE
        exoPlayer?.stop()
        try { imageView.setImageBitmap(bitmap) }
        catch (e: Throwable) { Log.e("MediaPlayerManager", "setImageBitmap failed: ${e.message}"); onImageError?.invoke() }
    }

    /**
     * Stop a YouTube embed that is being switched away from.
     *
     * Hiding the WebView does NOT stop it — visibility is not playback state, so the video kept
     * running behind the next item and its audio carried on over the top. Reported after YouTube
     * items started advancing at all (before that they never ended, so nothing ever switched away
     * from one and this could not surface): "even when the picture is there the sound from the
     * video continues playing".
     *
     * Blanking is what stop() already does, and it is safe here because playYoutube always reloads
     * the embed from scratch anyway. Guarded on the OUTGOING type so it must be called before
     * currentType is reassigned, and so it never blanks a widget that is being reused.
     */
    private fun stopYoutubeIfPlaying() {
        if (currentType != MediaType.YOUTUBE) return
        youtubeWebView?.loadUrl("about:blank")
    }

    fun playYoutube(embedUrl: String, durationSec: Int = 0, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Playing YouTube: $embedUrl (muted=$muted)")
        mountGeneration++
        currentType = MediaType.YOUTUBE
        currentWidgetUrl = null   // surface reused - a later widget show must reload
        youtubeMuted = muted || wallMute

        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        // alpha, not just visibility: showWidget stages the shared WebView transparent while the
        // next widget paints, and a mount superseded before it revealed leaves it at 0f. Without
        // this the embed would be VISIBLE and completely invisible.
        youtubeWebView?.alpha = 1f
        youtubeWebView?.visibility = android.view.View.VISIBLE

        exoPlayer?.stop()

        youtubeWebView?.apply {
            com.remotedisplay.player.util.WebViewSupport.configure(this, "YouTube")
            setBackgroundColor(android.graphics.Color.BLACK)
            // Load via an embed wrapper with a valid youtube.com origin (Error 153 fix).
            // #129: initial mute comes from the per-item flag (no longer hardcoded).
            val html = com.remotedisplay.player.util.WebViewSupport.youtubeEmbedHtml(embedUrl, youtubeMuted)
            if (html != null) loadDataWithBaseURL(com.remotedisplay.player.util.WebViewSupport.EMBED_BASE, html, "text/html", "UTF-8", null)
            else loadUrl(embedUrl)
        }
    }

    // #129: live mute for the YouTube embed via the IFrame API postMessage bridge
    // (enablejsapi=1 is set on the embed). Avoids a full reload of the player, which
    // would restart the video and flicker. Main thread only (WebView access).
    private fun setYoutubeMuted(muted: Boolean) {
        youtubeMuted = muted
        postYoutubeCommand(if (muted) "mute" else "unMute")
    }

    /** Send one IFrame-API command to the embed. Main thread only (WebView access). */
    private fun postYoutubeCommand(func: String) {
        val js = "(function(){try{var f=document.querySelector('iframe');" +
            "if(f&&f.contentWindow){f.contentWindow.postMessage(" +
            "JSON.stringify({event:'command',func:'$func',args:[]}),'*');}}catch(e){}})()"
        youtubeWebView?.let { wv -> wv.post { try { wv.evaluateJavascript(js, null) } catch (_: Throwable) {} } }
    }

    /**
     * The app is going to the background. Stop making noise.
     *
     * A WebView keeps running when its Activity stops — nothing in the lifecycle pauses it — so a
     * YouTube embed carried on playing with the app closed and the audio kept coming out of the
     * panel: "I closed the app and I can still hear the sound... I force stop the app and then open
     * again." A signage player that is not on screen must be silent.
     *
     * Pause rather than blank, so returning to the foreground resumes in place instead of
     * restarting the clip. pauseTimers() is process-wide, which is fine here (one WebView) and is
     * what actually stops the embed's own scripted playback.
     */
    fun onAppBackgrounded() {
        if (currentType == MediaType.YOUTUBE) postYoutubeCommand("pauseVideo")
        youtubeWebView?.let { wv -> wv.post { try { wv.onPause(); wv.pauseTimers() } catch (_: Throwable) {} } }
        exoPlayer?.pause()
    }

    /** Back in the foreground: undo onAppBackgrounded. */
    fun onAppForegrounded() {
        youtubeWebView?.let { wv -> wv.post { try { wv.resumeTimers(); wv.onResume() } catch (_: Throwable) {} } }
        if (currentType == MediaType.YOUTUBE) postYoutubeCommand("playVideo")
        if (currentType == MediaType.VIDEO) exoPlayer?.play()
    }

    /*
     * WIDGET_REVEAL_DEADLINE_MS - how long the outgoing item may be held while the next widget
     * paints.
     *
     * Not a guess at how long a page takes: a backstop for the page that never paints at all.
     * Widget HTML is seeded server-side so first paint does not wait on a fetch, and the panels
     * that showed this worst are exactly the ones where a stalled load must not strand the
     * playlist on the previous item. Two seconds is longer than a healthy paint by a wide margin
     * and short enough that a broken one is a hiccup rather than a stuck screen.
     */
    private val WIDGET_REVEAL_DEADLINE_MS = 2000L

    /*
     * Held so the deadline can be cancelled INDIVIDUALLY. The first version called
     * mainHandler.removeCallbacksAndMessages(null) on reveal, which cancels every pending
     * message on the main handler - image mounts and transition callbacks included, since they
     * share it. Cancelling one timer must not sweep the queue it happens to sit in.
     */
    private var widgetRevealDeadline: Runnable? = null

    // Fullscreen widget render (single-zone / "fullscreen" layouts). Reuses the
    // full-screen WebView; ZoneManager handles widgets in multi-zone layouts.
    fun showWidget(url: String) {
        // A solo-widget playlist re-shows the SAME item every duration_sec, and a playlist refresh
        // re-issues the current item too. Re-navigating the WebView for a URL it already has is a
        // visible flash, and it destroys widget state - a half-typed directory search, scroll
        // position, anything the viewer was doing. Widgets refresh their own data client-side
        // (directory-search polls the board's data.json every 30s), so the reload buys nothing.
        // Make the show idempotent: same URL + widget already on screen => leave it running.
        if (currentType == MediaType.WIDGET && url == currentWidgetUrl && youtubeWebView != null) {
            Log.i("MediaPlayerManager", "Widget already showing, not reloading: $url")
            youtubeWebView?.alpha = 1f
            youtubeWebView?.visibility = android.view.View.VISIBLE
            return
        }
        Log.i("MediaPlayerManager", "Showing widget: $url")

        /*
         * THE OUTGOING FRAME IS HELD UNTIL THE NEW PAGE HAS PAINTED.
         *
         * This used to read: hide playerView, hide imageView, show the WebView, THEN loadUrl. A
         * WebView goes on drawing the document it already has until the next one commits a paint,
         * so revealing it before the navigation put the PREVIOUS widget back on screen - for as
         * long as the new page took to arrive. On a 2020 WebView in a TV box, fetching a page with
         * a photograph, that is comfortably long enough to read. Reported from the field as
         * "one image comes in on top of the other, they load late and change quickly", and it fired
         * five times per rotation on a playlist that alternates video and widget, because taking
         * the surface for a video clears currentWidgetUrl and every widget therefore reloads.
         *
         * So the WebView is staged transparent, the navigation runs underneath, and the swap
         * happens on the first paint of the NEW document (or on the deadline above). alpha 0f
         * rather than INVISIBLE deliberately: an INVISIBLE view is not drawn, and a WebView that
         * is not drawn need not commit a paint - which is the very signal being waited on.
         *
         * WHAT THIS DOES NOT FIX: widget -> widget. There is one WebView, so the old document and
         * the new one share it and there is nothing underneath to hold. Those transitions behave
         * as they always did. Fixing them needs a second WebView to swap between, which costs
         * memory on hardware whose renderer already dies under pressure (see onRenderProcessGone),
         * so it is a separate decision made with the reveal timings below in hand.
         */
        mountGeneration++
        val gen = mountGeneration
        val wv = youtubeWebView

        /*
         * WIDGET → WIDGET, o caso que o bloco acima declarava não cobrir.
         *
         * A medição que aquele comentário pedia foi feita (04/09, TV PROSK-1000, Android 10):
         * nove trocas, TODAS reveladas por paint, nenhuma por deadline — mediana 495ms, máximo
         * 646ms. As páginas são rápidas. Então o segundo WebView não compra nada: sua única
         * vantagem seria manter o widget velho VIVO durante a troca, e ninguém vê um relógio
         * parado por meio segundo. O que compra é um renderer a mais na RAM de um aparelho cujo
         * renderer já morre sob pressão.
         *
         * O que resolve a meio segundo é segurar uma FOTO do widget que está saindo: desenhá-lo
         * num bitmap, pôr na imageView (que já existe e já é match_parent), e deixar o WebView
         * navegar transparente por baixo — exatamente o mecanismo do vídeo→widget, com a foto no
         * lugar do último quadro do vídeo. A revelação, o prazo e o log são os mesmos de lá, e o
         * log passa a medir este caminho também.
         *
         * O bitmap é RGB_565: metade da memória do ARGB_8888, e uma foto que vive meio segundo
         * atrás de um WebView não precisa de canal alfa. É liberado na revelação.
         */
        val segurandoVideo = wv != null && currentType != MediaType.WIDGET
        val foto = if (!segurandoVideo && wv != null && currentType == MediaType.WIDGET) congelar(wv) else null
        val segurando = segurandoVideo || foto != null

        currentType = MediaType.WIDGET
        currentWidgetUrl = url

        if (wv == null) {
            playerView.visibility = android.view.View.GONE
            imageView.visibility = android.view.View.GONE
            exoPlayer?.stop()
            return
        }

        if (segurandoVideo) {
            /*
             * Pause rather than stop: stop() releases the surface and the frame goes black, which
             * is the thing being avoided. playWhenReady=false freezes the last frame AND silences
             * the audio immediately, so the held frame is silent. stop() happens at reveal.
             */
            exoPlayer?.playWhenReady = false
            wv.alpha = 0f
            wv.visibility = android.view.View.VISIBLE
        } else if (foto != null) {
            /* A foto do widget que sai cobre a tela; o WebView troca de documento por baixo. */
            imageView.setImageBitmap(foto)
            imageView.visibility = android.view.View.VISIBLE
            playerView.visibility = android.view.View.GONE
            exoPlayer?.stop()
            wv.alpha = 0f
            wv.visibility = android.view.View.VISIBLE
        } else {
            playerView.visibility = android.view.View.GONE
            imageView.visibility = android.view.View.GONE
            exoPlayer?.stop()
            wv.alpha = 1f
            wv.visibility = android.view.View.VISIBLE
        }

        val startedAt = android.os.SystemClock.elapsedRealtime()
        com.remotedisplay.player.util.WebViewSupport.configure(wv, "Widget") {
            if (segurando) revealWidget(gen, startedAt, "paint")
        }
        wv.loadUrl(url)

        if (segurando) {
            widgetRevealDeadline?.let { mainHandler.removeCallbacks(it) }
            val deadline = Runnable { revealWidget(gen, startedAt, "deadline") }
            widgetRevealDeadline = deadline
            mainHandler.postDelayed(deadline, WIDGET_REVEAL_DEADLINE_MS)
        }
    }

    /*
     * Swap to the staged widget. Idempotent and generation-guarded: first paint and the deadline
     * race by design, and a mount that has already been superseded must not claw the screen back
     * from whatever replaced it.
     *
     * The reason is logged to remote debug, with the elapsed time, because it is the measurement
     * that decides whether the second WebView is worth its memory: "paint" every time and widget
     * pages are fast, "deadline" often and they are not.
     */
    /**
     * A FOTO do widget que está na tela, para segurar a parede enquanto o próximo pinta.
     *
     * É o mesmo `view.draw(canvas)` que a captura remota usa em ScreenshotCapture, e que está
     * provado neste hardware: as capturas de widget que chegam ao painel saem dele. Um WebView é
     * uma View comum para o draw — ao contrário do vídeo, que vive numa superfície própria e
     * sairia preto.
     *
     * Devolve null em qualquer tropeço (view sem tamanho, sem memória para o bitmap, draw que
     * lançou), e null significa "troca como sempre foi": uma foto que falha custa a piscada de
     * antes, nunca uma tela travada.
     */
    private fun congelar(wv: android.webkit.WebView): android.graphics.Bitmap? {
        return try {
            val w = wv.width
            val h = wv.height
            if (w <= 0 || h <= 0 || wv.alpha == 0f || wv.visibility != android.view.View.VISIBLE) return null
            val foto = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.RGB_565)
            wv.draw(android.graphics.Canvas(foto))
            foto
        } catch (t: Throwable) {
            Log.w("MediaPlayerManager", "não consegui congelar o widget: ${t.message}")
            null
        }
    }

    private fun revealWidget(gen: Long, startedAt: Long, reason: String) {
        if (gen != mountGeneration || currentType != MediaType.WIDGET) return
        val wv = youtubeWebView ?: return
        if (wv.alpha == 1f) return                       // already swapped by whichever fired first
        widgetRevealDeadline?.let { mainHandler.removeCallbacks(it) }
        widgetRevealDeadline = null
        wv.alpha = 1f
        wv.visibility = android.view.View.VISIBLE
        playerView.visibility = android.view.View.GONE
        imageView.visibility = android.view.View.GONE
        /* Solta a foto do widget anterior, se foi ela que segurou a tela: um bitmap de tela cheia
           não pode ficar pendurado na imageView até a próxima imagem substituí-lo. */
        imageView.setImageDrawable(null)
        exoPlayer?.stop()
        val ms = android.os.SystemClock.elapsedRealtime() - startedAt
        com.remotedisplay.player.util.DebugLog.i("Player", "widget revealed on $reason after ${ms}ms")
    }

    fun playVideoFromUrl(url: String, muted: Boolean = false) {
        Log.i("MediaPlayerManager", "Streaming video from URL: $url (muted=$muted)")
        mountGeneration++
        stopYoutubeIfPlaying()
        currentType = MediaType.VIDEO
        currentWidgetUrl = null   // surface reused - a later widget show must reload

        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        exoPlayer?.apply {
            volume = if (muted || wallMute) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.parse(url)))
            prepare()
            playWhenReady = true
        }
    }

    /**
     * Bumped by every request to put something on screen. An async decode captures it and drops its
     * result if the value has moved on — the same drop-if-replaced token PipOverlay.loadImageInto
     * already carries.
     *
     * Without it a slow remote image (ImageLoader allows 10s connect + 30s read, against a slot
     * that is usually 10s) finished long after the playlist had advanced and mounted itself over
     * whatever was playing. If that was a video, the mount also called exoPlayer.stop(), which
     * lands in STATE_IDLE — and the advance listener only fires onVideoComplete on STATE_ENDED or a
     * playback error, so no advance was ever scheduled and the playlist stopped for good. The 60s
     * refresh could not rescue it either: the playlist signature was unchanged, so the update
     * returned early.
     */
    private var mountGeneration: Long = 0L

    fun showImageFromUrl(url: String, transition: TransitionSpec? = null) {
        Log.i("MediaPlayerManager", "Loading remote image: $url")
        // Capture the outgoing frame NOW, on the main thread, before the decode thread swaps it out.
        val from = if (transition != null) captureCurrentFrame() else null
        val myGeneration = ++mountGeneration
        Thread {
            val bitmap = ImageLoader.decodeUrl(url, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
            mainHandler.post {
                // Something else has been asked for since this decode started — including the
                // error branch, whose onImageError posts next() and would otherwise cut short
                // whatever is now playing.
                if (myGeneration != mountGeneration) {
                    Log.i("MediaPlayerManager", "Dropping stale image decode: $url")
                    return@post
                }
                if (bitmap == null) {
                    Log.w("MediaPlayerManager", "Skipping unloadable remote image: $url")
                    onImageError?.invoke(); return@post
                }
                if (!runWipe(bitmap, transition, from) { mountImageBitmap(bitmap) }) mountImageBitmap(bitmap)
            }
        }.start()
    }

    /**
     * #group-sync double buffer: pre-open/pre-buffer the NEXT clip on the parked second player so the
     * upcoming boundary switch (playVideo of the same file) is a warm swap instead of a cold prepare.
     * Cheap to call every tick — it no-ops if this file is already the preloaded one. Main thread only.
     */
    fun preloadVideo(file: File) {
        if (preloadedFile?.absolutePath == file.absolutePath) return
        val p = preloadPlayer ?: buildPlayer().also { preloadPlayer = it }
        if (warmSurface == null) { warmTexture = SurfaceTexture(0).apply { setDefaultBufferSize(16, 16) }; warmSurface = Surface(warmTexture) }
        p.apply {
            setVideoSurface(warmSurface)                  // decode frame 0 offscreen -> video size known pre-swap
            volume = 0f                                   // silent while parked; real volume set on swap
            repeatMode = if (videoLooping) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            playWhenReady = false                         // buffer/parse/decode-frame-0 now, don't start
            prepare()
        }
        preloadedFile = file
        Log.i("MediaPlayerManager", "Preloaded next video: ${file.name}")
    }

    fun playVideo(file: File, muted: Boolean = false, transition: TransitionSpec? = null) {
        // image->video / video->video wipe: extract the incoming clip's first frame OFF the main thread,
        // wipe from the outgoing frame into it, then warm-mount the real video (which starts from frame 0,
        // matching the wipe's `to`). Any failure hard-cuts to the plain mount. Local files only — remote
        // streams (playVideoFromUrl) keep the plain path.
        if (transition != null && transitionsActive()) {
            val from = captureCurrentFrame()
            if (from != null) {
                Thread {
                    val toBmp = extractFirstFrame(file.absolutePath)
                    mainHandler.post {
                        if (toBmp != null && runWipe(toBmp, transition, from) { mountVideo(file, muted) }) return@post
                        mountVideo(file, muted)
                    }
                }.start()
                return
            }
        }
        mountVideo(file, muted)
    }

    private fun mountVideo(file: File, muted: Boolean = false) {
        mountGeneration++
        stopYoutubeIfPlaying()
        currentType = MediaType.VIDEO
        currentWidgetUrl = null   // surface reused - a later widget show must reload

        // Show player, hide image
        playerView.visibility = android.view.View.VISIBLE
        imageView.visibility = android.view.View.GONE
        youtubeWebView?.visibility = android.view.View.GONE

        // Warm swap: if this exact file was preloaded, promote the parked player instead of a cold
        // prepare — the container is already open/buffered so the first frame renders near-instantly.
        val pp = preloadPlayer
        if (pp != null && preloadedFile?.absolutePath == file.absolutePath) {
            Log.i("MediaPlayerManager", "Playing video (warm swap): ${file.name}")
            val old = exoPlayer
            exoPlayer = pp
            preloadPlayer = old
            preloadedFile = null
            pp.apply {
                volume = if (muted || wallMute) 0f else 1f
                repeatMode = if (videoLooping) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
                playWhenReady = true
            }
            playerView.player = pp
            // Park the previous active player as the new preload slot (idle until the next preloadVideo).
            old?.apply { playWhenReady = false; clearMediaItems() }
            return
        }

        Log.i("MediaPlayerManager", "Playing video: ${file.absolutePath} (muted=$muted)")
        exoPlayer?.apply {
            volume = if (muted || wallMute) 0f else 1f
            setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            prepare()
            playWhenReady = true
        }
    }

    fun showImage(file: File, transition: TransitionSpec? = null) {
        Log.i("MediaPlayerManager", "Showing image: ${file.absolutePath}")
        val bitmap = ImageLoader.decodeFile(file, ImageLoader.screenWidth(context), ImageLoader.screenHeight(context))
        if (bitmap == null) {
            Log.w("MediaPlayerManager", "Skipping unloadable image: ${file.name}")
            onImageError?.invoke()
            return
        }
        // Capture the outgoing frame (image or the video's TextureView) BEFORE the swap; decode above
        // doesn't touch the views, so it still reflects what's on screen. Wipe into the image, else hard cut.
        val from = if (transition != null) captureCurrentFrame() else null
        if (!runWipe(bitmap, transition, from) { mountImageBitmap(bitmap) }) mountImageBitmap(bitmap)
    }

    fun stop() {
        exoPlayer?.stop()
        imageView.setImageBitmap(null)
        youtubeWebView?.loadUrl("about:blank")
        youtubeWebView?.visibility = android.view.View.GONE
        currentType = MediaType.NONE
        currentWidgetUrl = null   // surface reused - a later widget show must reload
    }

    fun release() {
        exoPlayer?.release()
        exoPlayer = null
        preloadPlayer?.release()
        preloadPlayer = null
        preloadedFile = null
        warmSurface?.release(); warmSurface = null
        warmTexture?.release(); warmTexture = null
    }

    fun isPlayingVideo(): Boolean = currentType == MediaType.VIDEO && (exoPlayer?.isPlaying == true)

    // #129: live per-item mute. Applies a dashboard mute toggle to the CURRENTLY playing
    // item in real time (decoupled from a playlist reload). Native video -> ExoPlayer
    // volume; YouTube -> the IFrame API mute()/unMute() bridge (setYoutubeMuted), which
    // previously this method ignored so YouTube could never be un/muted live. Images/
    // widgets are silent. Persistence across the next play comes from the playlist
    // payload's per-item `muted` (honored in playVideo/playYoutube). Main thread only.
    fun setVideoMuted(muted: Boolean) {
        when (currentType) {
            MediaType.VIDEO -> exoPlayer?.volume = if (muted) 0f else 1f
            MediaType.YOUTUBE -> setYoutubeMuted(muted)   // #129: was a no-op for YouTube
            else -> {}
        }
    }

    // ---- Video-wall (wall:sync) accessors. All must be called on the main thread. ----

    /** Current video position in ms (0 when no video). */
    fun currentPositionMs(): Long = exoPlayer?.currentPosition ?: 0L

    /** Video duration in ms, or -1 when unknown/unprepared. */
    fun durationMs(): Long {
        val d = exoPlayer?.duration ?: C.TIME_UNSET
        return if (d == C.TIME_UNSET) -1L else d
    }

    /** Exact (frame-accurate) seek for the follower drift controller's hard-seek path. */
    fun seekExact(positionMs: Long) {
        exoPlayer?.apply {
            setSeekParameters(SeekParameters.EXACT)
            seekTo(positionMs)
        }
    }

    /** Playback rate — followers nudge ±3% to converge on the leader's clock. */
    fun setSpeed(rate: Float) { exoPlayer?.setPlaybackSpeed(rate) }

    /**
     * Wall follower mute. Persists across item switches (the leader's sync can move a
     * follower to an unmuted item, and N copies of the same audio out of phase flange),
     * and enforces the mute on whatever is playing right now.
     */
    fun setWallMute(mute: Boolean) {
        wallMute = mute
        if (mute) exoPlayer?.volume = 0f
    }

    /**
     * Loop the current video for wall followers so they never freeze on the last frame
     * if the leader's next index sync is slightly late; the leader plays through normally.
     */
    fun setVideoLooping(loop: Boolean) {
        videoLooping = loop
        exoPlayer?.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
        preloadPlayer?.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    }

    /**
     * In wall mode the content fills its slice (object-fit:fill parity with the web/Tizen
     * players); restore the default fit on exit.
     */
    fun setWallMode(enabled: Boolean) {
        playerView.resizeMode =
            if (enabled) AspectRatioFrameLayout.RESIZE_MODE_FILL else AspectRatioFrameLayout.RESIZE_MODE_FIT
        imageView.scaleType =
            if (enabled) ImageView.ScaleType.FIT_XY else ImageView.ScaleType.FIT_CENTER
    }
}
