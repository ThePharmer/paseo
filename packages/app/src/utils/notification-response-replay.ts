import { z } from "zod";
import { readValidatedJson, type ValidatedStorage } from "@/storage/validated-storage";

export const HANDLED_NOTIFICATION_RESPONSES_STORAGE_KEY = "@paseo:handled-notification-responses";
const MAX_REMEMBERED_RESPONSES = 50;
const HandledResponsesSchema = z.array(z.string());

export interface HandledNotificationResponseStorage extends ValidatedStorage {
  setItem(key: string, value: string): Promise<void>;
}

export interface NotificationResponseReplayGuard {
  /** Resolves true only the first time a response is delivered. */
  claim(identifier: string): Promise<boolean>;
}

// expo-notifications keeps the last response in a native slot that every router
// mount reads again, and Android re-delivers a notification launch intent when
// the app is relaunched from recents after the process died. Neither is a new
// tap, so handled response identifiers are remembered across both.
export function createNotificationResponseReplayGuard(deps: {
  storage: HandledNotificationResponseStorage;
  clearLastResponse: () => void;
}): NotificationResponseReplayGuard {
  let handledIds: Promise<string[]> | null = null;

  function loadHandledIds(): Promise<string[]> {
    handledIds ??= readValidatedJson(
      deps.storage,
      HANDLED_NOTIFICATION_RESPONSES_STORAGE_KEY,
      HandledResponsesSchema,
    )
      .then((stored) => stored ?? [])
      .catch((error: unknown) => {
        console.warn("[Notifications] Failed to read handled notification responses", error);
        return [];
      });
    return handledIds;
  }

  return {
    async claim(identifier) {
      deps.clearLastResponse();
      if (!identifier) {
        return true;
      }
      const ids = await loadHandledIds();
      if (ids.includes(identifier)) {
        return false;
      }
      ids.push(identifier);
      ids.splice(0, Math.max(0, ids.length - MAX_REMEMBERED_RESPONSES));
      deps.storage
        .setItem(HANDLED_NOTIFICATION_RESPONSES_STORAGE_KEY, JSON.stringify(ids))
        .catch((error: unknown) => {
          console.warn("[Notifications] Failed to persist handled notification response", error);
        });
      return true;
    },
  };
}
