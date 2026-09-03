package com.elearningmobile

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * Android-native text-to-speech module (SPEC TASK-077). Wraps
 * [android.speech.tts.TextToSpeech] behind a minimal JS surface:
 *
 *   speak(text) -> Promise<void>              resolves when playback finishes
 *                                             or is interrupted, rejects on
 *                                             engine/language failures with a
 *                                             normalized error code
 *   speakWith(text, options) -> Promise<void> same, applying per-utterance
 *                                             voice/rate/pitch options
 *   stop()                                    halts playback immediately, safe
 *                                             when idle
 *   getVoices() -> Promise<array>             installed voices with quality,
 *                                             latency, network and heuristic
 *                                             gender metadata
 *   getEngines() -> Promise<array>            installed TTS engines
 *   getDefaultEngine() -> Promise<string?>    active engine package
 *   setDefaultEngine(id) -> Promise<void>     rebuilds the engine with the
 *                                             chosen package; reverts on failure
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
    const val E_VOICE_UNAVAILABLE = "E_TTS_VOICE_UNAVAILABLE"

    private const val UTTERANCE_PREFIX = "elearning-"

    /** English locales tried in order until one initializes successfully. */
    private val ENGLISH_LOCALES =
        listOf(Locale.US, Locale.UK)

    /** Voice.quality / Voice.latency bucket values from the platform API. */
    private const val LEVEL_VERY_LOW = 100
    private const val LEVEL_LOW = 200
    private const val LEVEL_NORMAL = 300
    private const val LEVEL_HIGH = 400
    private const val LEVEL_VERY_HIGH = 500

    /** Best-effort engine name for display when the label is unusable. */
    private fun prettifyEngineId(engineId: String): String {
      val last = engineId.substringAfterLast('.')
      return last.replace('_', ' ').ifBlank { engineId }
    }

    /**
     * Best-effort gender from the voice name. Only literal naming
     * conventions ("female", "woman" / "male", "man") are trusted: engine
     * voice ids (en-us-x-iol-local, …) encode gender in undocumented codes,
     * so guessing there would produce confidently wrong labels. Voices that
     * match nothing are reported "unknown" and the voice manager explains
     * that gender filtering cannot narrow them instead of hiding them.
     */
    private fun detectGender(name: String): String {
      val lower = name.lowercase(Locale.ROOT)
      return when {
        lower.contains("female") || lower.contains("woman") -> "female"
        lower.contains("male") || lower.contains("man") -> "male"
        else -> "unknown"
      }
    }

    /** Maps a Voice quality/latency bucket to a stable JS string. */
    private fun levelName(value: Int): String = when (value) {
      LEVEL_VERY_LOW -> "very_low"
      LEVEL_LOW -> "low"
      LEVEL_NORMAL -> "normal"
      LEVEL_HIGH -> "high"
      LEVEL_VERY_HIGH -> "very_high"
      else -> "unknown"
    }
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

  /** Engine package requested by the user; null = system default engine. */
  private var preferredEngine: String? = null

  /** Engine actually used by the live engine instance (set on init success). */
  private var activeEngineId: String? = null

  /** Callbacks waiting for engine initialization. */
  private val initWaiters = mutableListOf<(Boolean) -> Unit>()

  /** The single in-flight utterance: id -> promise handed to JS. */
  private var pendingSpeak: Pair<String, Promise>? = null

  override fun getName(): String = NAME

  @ReactMethod
  fun speak(text: String, promise: Promise) {
    speakWith(text, null, promise)
  }

  /**
   * Speaks with per-utterance options. `options` may carry:
   *   voiceId (string|null) — voice name from getVoices(); null = engine default
   *   rate (number)          — 1.0 = normal speech rate
   *   pitch (number)         — 1.0 = normal pitch
   * Invalid or unavailable values degrade to the engine defaults instead of
   * failing the utterance, except a missing selected voice, which is reported
   * through E_TTS_VOICE_UNAVAILABLE so the UI can resync.
   */
  @ReactMethod
  fun speakWith(text: String, options: ReadableMap?, promise: Promise) {
    if (text.isBlank()) {
      promise.resolve(null)
      return
    }
    val voiceId = options?.getString("voiceId")
    val rate = if (options != null && options.hasKey("rate")) options.getDouble("rate").toFloat() else 1.0f
    val pitch = if (options != null && options.hasKey("pitch")) options.getDouble("pitch").toFloat() else 1.0f
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
        val engine = tts ?: run {
          promise.reject(E_ENGINE_ERROR, "Text-to-speech engine was released")
          return@synchronized
        }
        if (voiceId != null && !applyVoiceLocked(engine, voiceId)) {
          promise.reject(
              E_VOICE_UNAVAILABLE,
              "The selected voice is no longer available on this device")
          return@synchronized
        }
        try {
          engine.setSpeechRate(rate)
          engine.setPitch(pitch)
        } catch (_: Exception) {
          // Rate/pitch tuning is best-effort; playback proceeds untuned.
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
          engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
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

  /** Lists the live engine's installed voices with display metadata. */
  @ReactMethod
  fun getVoices(promise: Promise) {
    ensureReady { ready ->
      if (!ready) {
        promise.reject(E_ENGINE_ERROR, "Text-to-speech engine is unavailable")
        return@ensureReady
      }
      synchronized(lock) {
        val result: WritableArray = Arguments.createArray()
        val voices = try {
          tts?.voices
        } catch (_: Exception) {
          null
        }
        voices?.forEach { voice ->
          val entry = Arguments.createMap()
          entry.putString("id", voice.name)
          entry.putString("name", voice.name)
          entry.putString("language", voice.locale.toString())
          entry.putString("quality", levelName(voice.quality))
          entry.putString("latency", levelName(voice.latency))
          entry.putBoolean("network", voice.isNetworkConnectionRequired)
          entry.putString("gender", detectGender(voice.name))
          result.pushMap(entry)
        }
        promise.resolve(result)
      }
    }
  }

  /** Lists installed TTS engines so the UI can offer engine switching. */
  @ReactMethod
  fun getEngines(promise: Promise) {
    ensureReady { ready ->
      if (!ready) {
        promise.reject(E_ENGINE_ERROR, "Text-to-speech engine is unavailable")
        return@ensureReady
      }
      synchronized(lock) {
        val result: WritableArray = Arguments.createArray()
        val engines = try {
          tts?.engines
        } catch (_: Exception) {
          null
        }
        engines?.forEach { engine ->
          val entry = Arguments.createMap()
          entry.putString("id", engine.name)
          val label = try {
            engine.label
          } catch (_: Exception) {
            null
          }
          entry.putString(
              "label",
              if (label.isNullOrBlank()) prettifyEngineId(engine.name) else label)
          entry.putBoolean("isDefault", engine.name == activeEngineId)
          result.pushMap(entry)
        }
        promise.resolve(result)
      }
    }
  }

  /** Resolves the engine package backing the live engine (null = default). */
  @ReactMethod
  fun getDefaultEngine(promise: Promise) {
    ensureReady { ready ->
      if (!ready) {
        promise.reject(E_ENGINE_ERROR, "Text-to-speech engine is unavailable")
        return@ensureReady
      }
      synchronized(lock) {
        promise.resolve(try {
          tts?.defaultEngine
        } catch (_: Exception) {
          null
        })
      }
    }
  }

  /**
   * Switches the engine package. The live engine is released and rebuilt
   * with the requested package; on initialization failure the previous
   * engine is restored so the app never ends up without a working engine.
   */
  @ReactMethod
  fun setDefaultEngine(engineId: String, promise: Promise) {
    val previous = synchronized(lock) {
      val prev = preferredEngine
      if (prev == engineId) {
        // Same engine: the live instance already backs this id.
        promise.resolve(null)
        return
      }
      preferredEngine = engineId
      releaseEngineLocked()
      state = EngineState.IDLE
      prev
    }
    ensureReady { ready ->
      if (ready) {
        promise.resolve(null)
        return@ensureReady
      }
      synchronized(lock) {
        preferredEngine = previous
        state = EngineState.IDLE
      }
      promise.reject(E_ENGINE_ERROR, "Text-to-speech engine is unavailable")
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
      tts = TextToSpeech(
          reactApplicationContext.applicationContext,
          { status -> handleInit(status == TextToSpeech.SUCCESS) },
          preferredEngine)
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
        activeEngineId = try {
          tts?.defaultEngine
        } catch (_: Exception) {
          preferredEngine
        }
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

  /** Applies a selected voice; true when the engine accepted it. */
  private fun applyVoiceLocked(engine: TextToSpeech, voiceId: String): Boolean {
    val voices = try {
      engine.voices
    } catch (_: Exception) {
      null
    } ?: return false
    val voice = voices.firstOrNull { it.name == voiceId } ?: return false
    return try {
      when (engine.setVoice(voice)) {
        TextToSpeech.LANG_AVAILABLE,
        TextToSpeech.LANG_COUNTRY_AVAILABLE,
        TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE -> true
        else -> false
      }
    } catch (_: Exception) {
      false
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
    activeEngineId = null
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
