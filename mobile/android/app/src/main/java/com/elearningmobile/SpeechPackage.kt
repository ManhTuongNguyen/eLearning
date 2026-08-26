package com.elearningmobile

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/** Registers [SpeechModule] with the React Native bridge (SPEC TASK-077). */
class SpeechPackage : ReactPackage {

  @Deprecated("Classic-module registration kept for native TTS interop")
  override fun createNativeModules(
      reactContext: ReactApplicationContext
  ): List<NativeModule> = listOf(SpeechModule(reactContext))

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}
