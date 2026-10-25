package com.elearningmobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.Arguments

/**
 * JS bridge over the capture queue written by [CaptureActivity]
 * (WORD_CAPTURE_V1 TASK-WC-002). The queue is only removed from after the JS
 * side has committed the words, so a crash mid-processing replays the same
 * raws and the topic-level duplicate filter absorbs them.
 */
class WordCaptureModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "WordCapture"

  /** All raw captures waiting to be processed; does NOT clear the queue. */
  @ReactMethod
  fun getPendingCapturedWords(promise: Promise) {
    try {
      val queue = CaptureActivity.pendingQueue(reactApplicationContext)
      val array = Arguments.createArray()
      for (index in 0 until queue.length()) {
        array.pushString(queue.optString(index, ""))
      }
      promise.resolve(array)
    } catch (error: Exception) {
      promise.reject("get_pending_failed", error)
    }
  }

  /** Remove exactly the raws JS reports as processed. */
  @ReactMethod
  fun removeCapturedWords(words: ReadableArray, promise: Promise) {
    try {
      val raws = HashSet<String>()
      for (index in 0 until words.size()) {
        words.getString(index)?.let { raws.add(it) }
      }
      CaptureActivity.removeFromQueue(reactApplicationContext, raws)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("remove_failed", error)
    }
  }
}
