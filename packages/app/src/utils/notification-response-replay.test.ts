import { describe, expect, it } from "vitest";
import {
  createNotificationResponseReplayGuard,
  HANDLED_NOTIFICATION_RESPONSES_STORAGE_KEY,
  type HandledNotificationResponseStorage,
} from "./notification-response-replay";

class MemoryStorage implements HandledNotificationResponseStorage {
  readonly values = new Map<string, string>();
  failReads = false;

  async getItem(key: string): Promise<string | null> {
    if (this.failReads) {
      throw new Error("storage unavailable");
    }
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function createGuard(storage: MemoryStorage) {
  const clears: number[] = [];
  const guard = createNotificationResponseReplayGuard({
    storage,
    clearLastResponse: () => clears.push(clears.length),
  });
  return { guard, clears };
}

async function flushWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createNotificationResponseReplayGuard", () => {
  it("handles a new response once and clears it from the native slot", async () => {
    const { guard, clears } = createGuard(new MemoryStorage());

    expect(await guard.claim("message-1")).toBe(true);
    expect(clears).toHaveLength(1);
  });

  it("ignores the same response when the router remounts and replays it", async () => {
    const { guard, clears } = createGuard(new MemoryStorage());

    await guard.claim("message-1");

    expect(await guard.claim("message-1")).toBe(false);
    expect(clears).toHaveLength(2);
  });

  it("lets only one of two concurrent deliveries of a response through", async () => {
    const { guard } = createGuard(new MemoryStorage());

    const results = await Promise.all([guard.claim("message-1"), guard.claim("message-1")]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("ignores a handled response re-delivered after the process restarts", async () => {
    const storage = new MemoryStorage();
    await createGuard(storage).guard.claim("message-1");
    await createGuard(storage).guard.claim("message-2");
    await flushWrites();

    const relaunched = createGuard(storage).guard;

    expect(await relaunched.claim("message-1")).toBe(false);
    expect(await relaunched.claim("message-2")).toBe(false);
  });

  it("still handles a new tap after the process restarts", async () => {
    const storage = new MemoryStorage();
    await createGuard(storage).guard.claim("message-1");
    await flushWrites();

    expect(await createGuard(storage).guard.claim("message-2")).toBe(true);
  });

  it("handles a cold-start tap when the handled record cannot be read", async () => {
    const storage = new MemoryStorage();
    storage.failReads = true;

    expect(await createGuard(storage).guard.claim("message-1")).toBe(true);
  });

  it("handles a response without an identifier because it cannot be matched", async () => {
    const { guard } = createGuard(new MemoryStorage());

    expect(await guard.claim("")).toBe(true);
  });

  it("remembers a bounded number of responses, forgetting the oldest", async () => {
    const storage = new MemoryStorage();
    const { guard } = createGuard(storage);
    for (let index = 0; index < 60; index += 1) {
      await guard.claim(`message-${index}`);
    }
    await flushWrites();

    const remembered: unknown = JSON.parse(
      storage.values.get(HANDLED_NOTIFICATION_RESPONSES_STORAGE_KEY) ?? "[]",
    );
    expect(Array.isArray(remembered) && remembered.length).toBe(50);
    expect(await createGuard(storage).guard.claim("message-0")).toBe(true);
    expect(await createGuard(storage).guard.claim("message-59")).toBe(false);
  });
});
