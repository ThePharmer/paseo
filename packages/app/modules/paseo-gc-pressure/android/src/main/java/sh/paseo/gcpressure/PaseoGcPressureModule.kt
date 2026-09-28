package sh.paseo.gcpressure

import android.os.Debug
import expo.modules.kotlin.jni.JavaScriptObject
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Hermes credits the whole amount against its heap-size check, and the JNI
// bridge takes an Int. 1 GB keeps both far from their limits.
private const val MAX_PRESSURE_BYTES = 1024.0 * 1024.0 * 1024.0

class PaseoGcPressureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoGcPressure")

    // Scudo answers mallinfo in microseconds, so a 1 s poll is free.
    Function("nativeHeapBytes") {
      Debug.getNativeHeapAllocatedSize().toDouble()
    }

    // Sync functions run on the JS thread, which setExternalMemoryPressure
    // requires. Hermes replaces the object's previous amount and debits it
    // when the object is collected.
    //
    // Expo converts the argument into a C++ JavaScriptObject that owns a
    // shared_ptr<jsi::Object>, which Hermes treats as a GC root. callJNISync
    // only drops the JNI local ref, so without deallocate() that root lives
    // until Java finalizes the wrapper, the balloon survives every collection
    // (even global.gc()), and its pressure inflates the next old-generation
    // target. Release it on every call, including arming calls.
    Function("setPressure") { target: JavaScriptObject, bytes: Double ->
      try {
        val clamped = if (bytes.isNaN()) 0.0 else bytes.coerceIn(0.0, MAX_PRESSURE_BYTES)
        target.setExternalMemoryPressure(clamped.toInt())
      } finally {
        target.deallocate()
      }
    }
  }
}
