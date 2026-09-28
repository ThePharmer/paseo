// Installs global.__paseoGcBalloon, the GC safety net's balloon API. A balloon
// is a plain JS object whose jsi::NativeState reports the balloon's id when
// Hermes finalizes it, in the same collection that debits its pressure. No
// Java or Expo wrapper ever references a balloon.
//
// Names here are read by src/performance/gc-safety-net/balloon-finalizer.ts
// and checked by pressure-module-contract.test.ts.

#include <jni.h>
#include <jsi/jsi.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace jsi = facebook::jsi;

namespace {

constexpr const char* kGlobalName = "__paseoGcBalloon";
// Hermes credits the whole amount against its heap-size check, which caps an
// amount at 32 bits. 1 GB keeps both far from their limits.
constexpr double kMaxPressureBytes = 1024.0 * 1024.0 * 1024.0;
// At most one balloon is collected per trigger, so the queue stays tiny.
constexpr size_t kReservedIds = 16;

// Filled by finalizers on any thread, drained on the JS thread. The JS thread
// holds the mutex only to copy ids, never across a JSI call, so a finalizer
// run by a collection on the JS thread cannot find it held (see hermes#2007).
class FinalizedIds {
 public:
  FinalizedIds() { ids_.reserve(kReservedIds); }

  void push(double id) noexcept {
    try {
      std::lock_guard<std::mutex> lock(mutex_);
      ids_.push_back(id);
    } catch (...) {
      // A lost id leaves the balloon uncollected in JS; the fallback covers it.
    }
  }

  std::vector<double> take() {
    std::lock_guard<std::mutex> lock(mutex_);
    std::vector<double> taken(ids_);
    ids_.clear();
    return taken;
  }

 private:
  std::mutex mutex_;
  std::vector<double> ids_;
};

// Hermes runs this destructor from the finalizer of the balloon's NativeState
// cell: on the JS thread for young-generation and compacted objects, on the
// Hades background thread for old-generation sweeps. It must not touch JSI or
// JNI, block on anything the JS thread holds across a JSI call, or throw.
class BalloonFinalizer final : public jsi::NativeState {
 public:
  BalloonFinalizer(double id, std::shared_ptr<FinalizedIds> finalized)
      : id_(id), finalized_(std::move(finalized)) {}

  ~BalloonFinalizer() override { finalized_->push(id_); }

 private:
  const double id_;
  const std::shared_ptr<FinalizedIds> finalized_;
};

jsi::Function makeFunction(
    jsi::Runtime& runtime,
    const char* name,
    unsigned int paramCount,
    jsi::HostFunctionType body) {
  return jsi::Function::createFromHostFunction(
      runtime, jsi::PropNameID::forAscii(runtime, name), paramCount, std::move(body));
}

// Every jsi::Object below is a stack handle, released when its host function
// returns, so no call leaves a root on a balloon.
void install(jsi::Runtime& runtime) {
  // One queue per install: a finalizer from an earlier runtime or install
  // cannot report an id into the current one.
  auto finalized = std::make_shared<FinalizedIds>();
  jsi::Object api(runtime);

  api.setProperty(
      runtime,
      "create",
      makeFunction(
          runtime,
          "create",
          1,
          [finalized](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count)
              -> jsi::Value {
            if (count < 1 || !args[0].isNumber()) {
              throw jsi::JSError(rt, "create(id) needs a numeric id");
            }
            jsi::Object balloon(rt);
            balloon.setNativeState(
                rt, std::make_shared<BalloonFinalizer>(args[0].getNumber(), finalized));
            return balloon;
          }));

  // Hermes replaces the object's previous amount and debits it when the
  // object is finalized. setExternalMemoryPressure must run on the JS thread.
  api.setProperty(
      runtime,
      "setPressure",
      makeFunction(
          runtime,
          "setPressure",
          2,
          [](jsi::Runtime& rt, const jsi::Value&, const jsi::Value* args, size_t count)
              -> jsi::Value {
            if (count < 2 || !args[0].isObject() || !args[1].isNumber()) {
              throw jsi::JSError(rt, "setPressure(balloon, bytes) needs an object and a number");
            }
            const double requested = args[1].getNumber();
            const double bytes =
                std::isnan(requested) ? 0.0 : std::clamp(requested, 0.0, kMaxPressureBytes);
            args[0].getObject(rt).setExternalMemoryPressure(rt, static_cast<size_t>(bytes));
            return jsi::Value::undefined();
          }));

  api.setProperty(
      runtime,
      "takeFinalizedIds",
      makeFunction(
          runtime,
          "takeFinalizedIds",
          0,
          [finalized](jsi::Runtime& rt, const jsi::Value&, const jsi::Value*, size_t)
              -> jsi::Value {
            const std::vector<double> ids = finalized->take();
            jsi::Array result(rt, ids.size());
            for (size_t index = 0; index < ids.size(); index++) {
              result.setValueAtIndex(rt, index, jsi::Value(ids[index]));
            }
            return result;
          }));

  runtime.global().setProperty(runtime, kGlobalName, std::move(api));
}

}  // namespace

// Called from a sync Expo function, so on the JS thread while the runtime is
// executing that call.
extern "C" JNIEXPORT jboolean JNICALL
Java_sh_paseo_gcpressure_PaseoGcPressureModule_nativeInstallBalloonFinalizer(
    JNIEnv*, jobject, jlong runtimePointer) {
  if (runtimePointer == 0) {
    return JNI_FALSE;
  }
  try {
    install(*reinterpret_cast<jsi::Runtime*>(runtimePointer));
    return JNI_TRUE;
  } catch (...) {
    return JNI_FALSE;
  }
}
