package sh.paseo.gcpressure

import expo.modules.kotlin.sharedobjects.SharedObject

// Reports that one GC safety net balloon was collected. JS keeps the token's
// JS object only in a property of the balloon, a plain object, so Hermes can
// finalize the token once the balloon is gone. Its NativeState destructor then
// reaches sharedObjectDidRelease through JSIContext.deleteSharedObject. Hades
// runs old-generation finalizers on its background sweep thread
// (lib/VM/gcs/HadesGC.cpp:1176), so onFinalized must be thread-safe.
//
// The token is never the balloon: Expo's class constructor keeps a strong
// JavaScriptObject wrapper around the constructed object until Java finalizes
// it (JSClassesDecorator.cpp:98-105, SharedObjectRegistry.add), which would
// root a balloon. Rooting the token only delays the signal.
class GcBalloonToken(
  private val balloonId: Int,
  private val onFinalized: (Int) -> Unit
) : SharedObject() {
  override fun sharedObjectDidRelease() {
    onFinalized(balloonId)
  }
}
