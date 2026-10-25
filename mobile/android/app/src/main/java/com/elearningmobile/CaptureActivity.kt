package com.elearningmobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import org.json.JSONArray

/**
 * Transparent, no-UI handler for Android text selection (WORD_CAPTURE_V1
 * TASK-WC-002). Registered for ACTION_PROCESS_TEXT (the system
 * text-selection menu) and ACTION_SEND (apps that only offer Share). It never
 * starts React Native: the selected word is appended to the
 * `word_capture` SharedPreferences queue, a toast confirms the save, and the
 * activity finishes immediately so the user stays in the app they were
 * reading. The queue is drained by [WordCaptureModule] the next time the main
 * app runs, which keeps capture instant and offline-safe.
 *
 * The single-word rule is pre-checked here for instant feedback (whitespace
 * or over-long selections are rejected with a toast); the JS pipeline
 * re-validates authoritatively.
 */
class CaptureActivity : Activity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val selected = selectedText(intent)
    val trimmed = selected?.trim().orEmpty()
    if (trimmed.isEmpty() || trimmed.length > MAX_CAPTURED_WORD_LENGTH || trimmed.any { it.isWhitespace() }) {
      Toast.makeText(this, rejectMessage(), Toast.LENGTH_SHORT).show()
    } else {
      enqueue(this, trimmed)
      Toast.makeText(this, savedMessage(trimmed), Toast.LENGTH_SHORT).show()
    }
    finish()
  }

  /** PROCESS_TEXT carries a CharSequence; SEND carries a string extra. */
  private fun selectedText(intent: Intent): String? =
      when (intent.action) {
        Intent.ACTION_PROCESS_TEXT ->
            intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
        Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
        else -> null
      }

  private fun rejectMessage(): String = getString(R.string.capture_rejected)

  private fun savedMessage(word: String): String = getString(R.string.capture_saved, word)

  companion object {
    /** Must mirror MAX_CAPTURED_WORD_LENGTH in src/serverless/wordCapture.ts. */
    const val MAX_CAPTURED_WORD_LENGTH = 64

    /**
     * Append one raw capture to the persistent queue, dropping the oldest
     * entries past [MAX_QUEUE]. Access is serialized on the class because the
     * module drains from another context.
     */
    fun enqueue(context: Context, raw: String) {
      synchronized(this) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val queue = JSONArray(prefs.getString(PENDING_KEY, "[]"))
        queue.put(raw)
        while (queue.length() > MAX_QUEUE) {
          queue.remove(0)
        }
        prefs.edit().putString(PENDING_KEY, queue.toString()).apply()
      }
    }

    fun pendingQueue(context: Context): JSONArray =
        synchronized(this) {
          JSONArray(context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(PENDING_KEY, "[]"))
        }

    fun removeFromQueue(context: Context, raws: Set<String>) {
      synchronized(this) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val queue = JSONArray(prefs.getString(PENDING_KEY, "[]"))
        val kept = JSONArray()
        for (index in 0 until queue.length()) {
          val value = queue.optString(index, "")
          if (value !in raws) {
            kept.put(value)
          }
        }
        prefs.edit().putString(PENDING_KEY, kept.toString()).apply()
      }
    }

    private const val PREFS_NAME = "word_capture"
    private const val PENDING_KEY = "pending"
    private const val MAX_QUEUE = 500
  }
}
