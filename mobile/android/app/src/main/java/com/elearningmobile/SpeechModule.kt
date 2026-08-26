package com.elearningmobile

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Android-native text-to-speech module (SPEC TASK-077). Wraps
 * [android.speech.tts.TextToSpeech] behind a minimal JS surface:
 *
 *   speak(text) -> Promise<void>  resolves when playback finishes or is
 *                                 interrupted, rejects on engine/language
 *                                 failures with a normalized error code
 *   stop()                       halts playback immediately, safe when idle
 *
 * Failure handling requirements from SPEC: missing English language support
 * is reported through E_TTS_LANGUAGE_UNAVAILABLE instead of speaking garbage,
 * every callback path settles the pending promise exactly once, and no
 * exception from the TTS subsystem is allowed to escape into a crash.
 */
class SpeechModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    const val NAME = "Speech"

    /** Error codes surfaced to JavaScript. */
    const val E_ENGINE_ERROR = "E_TTS_ENGINE"
    const val E_LANGUAGE_UNAVAILABLE = "E_TTS_LANGUAGE_UNAVAILABLE"

    private const val UTTERANCE_PREFIX = "elearning-"

    /** English locales tried in order until one initializes successfully. */
    private val ENGLISH_LOCALES =
        listOf(Locale.US, Locale.UK)
  }

  private enum class EngineState {
    IDLE,
    INITIALIZING,
    READY,
    FAILED,
  }

  private val lock = Any()
  private var tts: TextToSpeech? = null
  private var state = EngineState.IDLE
  private var languageSupported = false
  private var utteranceCounter = AtomicLong(0)

  /** Callbacks waiting for engine initialization. */
  private val initWaiters = mutableListOf<(Boolean) -> Unit>()

  /** The single in-flight utterance: id -> promise handed to JS. */
  private var pendingSpeak: Pair<String, Promise>? = null

  override fun getName(): String = NAME

  @ReactMethod
  fun speak(text: String, promise: Promise) {
    if (text.isBlank()) {
      promise.resolve(null)
      return
    }
    ensureReady { ready ->
      if (!ready) {
        promise.reject(E_ENGINE_ERROR, "Text-to-speech engine is unavailable")
        return@ensureReady
      }
      synchronized(lock) {
        if (!languageSupported) {
          promise.reject(
              E_LANGUAGE_UNAVAILABLE,
              "No English voice data is installed on this device")
          return@synchronized
        }
        // Superseding request: settle the previous waiter so awaiting UI
        // cleans up instead of hanging; late TTS callbacks ignore it.
        pendingSpeak?.let { (_, waiting) ->
          pendingSpeak = null
          waiting.resolve(null)
        }
        val utteranceId = UTTERANCE_PREFIX + utteranceCounter.incrementAndGet()
        pendingSpeak = utteranceId to promise
        try {
          tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
              ?: run {
                pendingSpeak = null
                promise.reject(E_ENGINE_ERROR, "Text-to-speech engine was released")
              }
        } catch (e: Exception) {
          pendingSpeak = null
          promise.reject(E_ENGINE_ERROR, "Failed to start playback", e)
        }
      }
    }
  }

  @ReactMethod
  fun stop() {
    synchronized(lock) {
      pendingSpeak?.let { (_, waiting) ->
        pendingSpeak = null
        waiting.resolve(null)
      }
      try {
        tts?.stop()
      } catch (_: Exception) {
        // Idle/unavailable engines are fine to stop silently.
      }
    }
  }

  /**
   * Resolves once initialization finished; true means READY with language
   * probing done. Concurrent callers share one in-flight construction.
   */
  private fun ensureReady(onResult: (Boolean) -> Unit) {
    var constructEngine = false
    synchronized(lock) {
      when (state) {
        EngineState.READY -> {
          onResult(true)
          return
        }
        EngineState.FAILED -> {
          onResult(false)
          return
        }
        else -> {
          initWaiters.add(onResult)
          if (state == EngineState.IDLE) {
            state = EngineState.INITIALIZING
            constructEngine = true
          }
        }
      }
    }
    if (!constructEngine) {
      return
    }
    try {
      tts = TextToSpeech(reactApplicationContext.applicationContext) { status ->
        handleInit(status == TextToSpeech.SUCCESS)
      }
    } catch (_: Exception) {
      handleInit(false)
    }
  }

  private fun handleInit(success: Boolean) {
    val waiters: List<(Boolean) -> Unit>
    var result = success
    synchronized(lock) {
      waiters = ArrayList(initWaiters)
      initWaiters.clear()
      if (!success || tts == null) {
        releaseEngineLocked()
        state = EngineState.FAILED
        result = false
      } else {
        languageSupported = probeEnglishVoiceLocked()
        state = EngineState.READY
        attachProgressListenerLocked()
      }
    }
    for (waiter in waiters) {
      try {
        waiter(result)
      } catch (_: Exception) {
        // A misbehaving waiter must not break the others.
      }
    }
  }

  private fun probeEnglishVoiceLocked(): Boolean {
    for (locale in ENGLISH_LOCALES) {
      val availability = try {
        tts?.setLanguage(locale)
      } catch (_: Exception) {
        null
      }
      when (availability) {
        TextToSpeech.LANG_AVAILABLE,
        TextToSpeech.LANG_COUNTRY_AVAILABLE,
        TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> return true
        else -> continue
      }
    }
    return false
  }

  private fun attachProgressListenerLocked() {
    try {
      tts?.setOnUtteranceProgressListener(
          object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}

            override fun onDone(utteranceId: String?) {
              settle(utteranceId, null)
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
              settle(utteranceId, "Playback failed")
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
              settle(utteranceId, "Playback failed ($errorCode)")
            }
          })
    } catch (_: Exception) {
      // Without a listener promises still resolve via stop()/replacement.
    }
  }

  /** Settles the matching pending promise exactly once; unknown ids ignored. */
  private fun settle(utteranceId: String?, errorMessage: String?) {
    if (utteranceId == null) {
      return
    }
    var waiting: Promise? = null
    synchronized(lock) {
      val current = pendingSpeak
      if (current != null && current.first == utteranceId) {
        pendingSpeak = null
        waiting = current.second
      }
    }
    waiting?.let { promise ->
      if (errorMessage == null) {
        promise.resolve(null)
      } else {
        promise.reject(E_ENGINE_ERROR, errorMessage)
      }
    }
  }

  private fun releaseEngineLocked() {
    val engine = tts
    tts = null
    languageSupported = false
    try {
      engine?.stop()
      engine?.shutdown()
    } catch (_: Exception) {
      // Shutdown failures during teardown must never crash the app.
    }
  }

  override fun invalidate() {
    var waiting: Promise? = null
    synchronized(lock) {
      releaseEngineLocked()
      waiting = pendingSpeak?.second
      pendingSpeak = null
      initWaiters.clear()
      state = EngineState.IDLE
    }
    waiting?.resolve(null)
    super.invalidate()
  }
}
