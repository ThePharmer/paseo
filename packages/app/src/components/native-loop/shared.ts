// One loop per animation family, shared by every instance on screen. It starts at the wall-clock
// phase so an instance that appears mid-flight lands in step with the ones already moving, and it
// stops when the last visible instance leaves.

export interface LoopDriver {
  /** `phase` is the fraction of the period the wall clock is into, in [0, 1). */
  start(phase: number): void;
  stop(): void;
}

export interface SharedLoop {
  /** Returns the release for this consumer. */
  retain(): () => void;
}

interface SharedLoopOptions {
  driver: LoopDriver;
  now: () => number;
  periodMs: number;
}

export function createSharedLoop({ driver, now, periodMs }: SharedLoopOptions): SharedLoop {
  let consumers = 0;

  return {
    retain() {
      consumers += 1;
      if (consumers === 1) {
        driver.start((now() % periodMs) / periodMs);
      }

      let isReleased = false;
      return () => {
        if (isReleased) return;
        isReleased = true;
        consumers -= 1;
        if (consumers === 0) {
          driver.stop();
        }
      };
    },
  };
}
