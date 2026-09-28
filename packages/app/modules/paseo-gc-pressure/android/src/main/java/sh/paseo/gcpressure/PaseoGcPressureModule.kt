package sh.paseo.gcpressure

import android.os.Debug
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoGcPressureModule : Module() {
  companion object {
    // Loaded on first install, so a missing library only disables the balloon.
    private val isNativeLibraryLoaded: Boolean by lazy {
      try {
        System.loadLibrary("paseo_gc_pressure")
        true
      } catch (error: UnsatisfiedLinkError) {
        false
      }
    }
  }

  // cpp/balloon-finalizer.cpp. Installs global.__paseoGcBalloon.
  private external fun nativeInstallBalloonFinalizer(runtimePointer: Long): Boolean

  override fun definition() = ModuleDefinition {
    Name("PaseoGcPressure")

    // Scudo answers mallinfo in microseconds, so a 1 s poll is free.
    Function("nativeHeapBytes") {
      Debug.getNativeHeapAllocatedSize().toDouble()
    }

    // Sync functions run on the JS thread, which the JSI install requires.
    // The runtime pointer comes from the same holder Expo installs its own
    // JSI bindings from (RuntimeContext.installJSIContext).
    Function("installBalloonFinalizer") {
      val holder = appContext.hostingRuntimeContext.reactContext?.javaScriptContextHolder
      if (holder == null || !isNativeLibraryLoaded) {
        false
      } else {
        synchronized(holder) {
          val runtimePointer = holder.get()
          runtimePointer != 0L && nativeInstallBalloonFinalizer(runtimePointer)
        }
      }
    }
  }
}
