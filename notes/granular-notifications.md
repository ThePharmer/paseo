# Granular notifications: research notes

Status: research only, no code yet. Branch `exp/granular-notifications-v0.11.1`, based on the 0.11.1 release commit (`ab10a6694`).

Researched 2026-10-09/10. Upstream thread states and t3code code are snapshots from that date.

## Goal

Let users choose which agent events send a system notification or mobile push, for example "Agent needs permission" on and "Agent finished" off. The in-app sidebar status should stay as it is.

## Can a plugin do it?

No.

- The daemon decides delivery in `computeNotificationPlan` (`packages/server/src/server/agent-attention-policy.ts:42`). It looks at presence and focus only. Plugins are never consulted.
- Plugin event hooks (`agent.turn_ended`, `agent.permission_requested`, ...) are observers. They cannot cancel or change a notification. See `public-docs/plugins/reference.md:719`.
- The only `server.before()` hooks are `agent.create`, `agent.session_open` and `workspace.create` (`public-docs/plugins/reference.md:772`). None touch notifications.
- Plugins have no `server.notify()`, so they cannot send through Paseo's delivery either.

Workaround: turn off Paseo notifications at the OS level, and have a plugin listen for `agent.permission_requested` and for `agent.turn_ended` with a `failed` outcome, then push through a side channel such as ntfy. Discussion #5912 describes a plugin doing this. It needs setup on every machine, and a tap does not open Paseo.

## Upstream threads (getpaseo/paseo)

| Thread                                                                 | Ask                                                                                                           | State on 2026-10-09                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Discussion #5977](https://github.com/getpaseo/paseo/discussions/5977) | Per-event switches (finished / permission / error) in Settings → Notifications                                | Open, no replies. Closest match.                                                      |
| [Issue #234](https://github.com/getpaseo/paseo/issues/234)             | Same switches, plus error and unanswered-input reminder notifications                                         | Closed as completed, but #5977 says the switches never shipped                        |
| #1496, #3019                                                           | Choose which events notify; turn off notifications in desktop                                                 | Closed and moved to Discussions (per #5977)                                           |
| #3948, #4268                                                           | Same control for schedule-finished notifications                                                              | Linked from #5977                                                                     |
| [Discussion #5912](https://github.com/getpaseo/paseo/discussions/5912) | `server.notify()` for plugins through daemon delivery, per-plugin mute                                        | Open                                                                                  |
| [Discussion #6267](https://github.com/getpaseo/paseo/discussions/6267) | Plugin API gaps; notifications is item 1                                                                      | Open                                                                                  |
| [Issue #6472](https://github.com/getpaseo/paseo/issues/6472)           | Allow/Deny on permission pushes, plugin notify API, deep links to the exact item, push-token lease visibility | Opened 2026-10-09, no comments                                                        |
| [Issue #3932](https://github.com/getpaseo/paseo/issues/3932)           | Notification sources polled by the app                                                                        | Closed. Maintainers want the daemon-owned delivery model settled before a plugin API. |

Related notification bugs that touch the same code: #2622 (iOS background suspension inside the 180 s presence window), #4841 (stale desktop presence suppresses banners), #1841 (notification sound never applied).

Open PRs mentioning notifications are all about `notifyOnFinish` for agent-to-agent calls or tap routing (#4131, #5586). None add user-facing filtering.

## How Paseo works today (0.11.1)

| Piece                                                                                  | Location                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Event types: `"finished" \| "error" \| "permission"` (questions count as `permission`) | `packages/protocol/src/agent-attention-notification.ts:3`       |
| Presence and focus rule, 180 s threshold                                               | `packages/server/src/server/agent-attention-policy.ts:3`, `:42` |
| `error` never pushes                                                                   | `packages/server/src/server/agent-attention-policy.ts:78`       |
| Builds the notification, computes the plan, sends the push                             | `packages/server/src/server/websocket-server.ts:2613-2624`      |
| Push sends to every active token at once                                               | `packages/server/src/server/push/index.ts:38-43`                |
| Push token registration carries only `token`                                           | `packages/protocol/src/messages.ts:2889`                        |
| Desktop notification settings hold only `playSound`                                    | `packages/app/src/desktop/settings/desktop-settings.ts:16`      |

The push goes out only when no client is present. When a client is present, the daemon picks one recipient and sends it `agent_attention_required` with `shouldNotify: true`. That client shows the OS notification.

## t3code for comparison

Source: [pingdotgg/t3code @ 5fe9d024](https://github.com/pingdotgg/t3code/tree/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce), cloned 2026-10-09.

### Web and desktop: one mode, no per-event control

- A single `notificationMode`: `off`, `notifications`, `sound`, `notifications-and-sound`. A separate `inAppNotificationsEnabled` switch controls toasts. Both are client settings per device. Default is `off`.
  [`apps/web/src/threadNotifications.ts`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/web/src/threadNotifications.ts),
  [`apps/web/src/components/settings/NotificationSettings.tsx`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/web/src/components/settings/NotificationSettings.tsx)
- The client derives events by diffing thread state, not from server events. It skips subagent threads, and does not notify for archived threads or on first load (no prior state).
  [`apps/web/src/components/ThreadNotificationCoordinator.tsx`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/web/src/components/ThreadNotificationCoordinator.tsx)
- Events: completed, approval needed, input needed, failed, usage limit reached. Each has its own title and icon.
- Separate sounds for completion and input. Audio is unlocked on the first pointer or key press so later background playback works.
- When the window is focused and you are viewing another thread, it shows an in-app toast with "Open thread" instead of an OS notification. When you are viewing that thread, nothing fires.
- Notifications use `tag: environmentId:threadId`, so a new one replaces the previous one for the same thread. A dock/taskbar badge counts pending notifications and clears on window focus.
- Permission request failures fall back to telling the user "Sound only is still available".

### Mobile push: per-event filter exists on the relay, but no UI sets it

- Device registration carries `notifyOnApproval`, `notifyOnInput`, `notifyOnCompletion`, `notifyOnFailure`, plus `notificationsEnabled` and `liveActivitiesEnabled`.
  [`packages/contracts/src/relay.ts:34-40`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/packages/contracts/src/relay.ts#L34-L40)
- The relay filters each device by event before pushing (`alertAllowedForPhase`). A device with no stored preferences gets everything.
  [`infra/relay/src/agentActivity/agentActivityAlerts.ts:37-54`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/infra/relay/src/agentActivity/agentActivityAlerts.ts#L37-L54)
- The mobile app hardcodes all four flags to `true`.
  [`apps/mobile/src/features/agent-awareness/registrationPayload.ts:46-49`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/mobile/src/features/agent-awareness/registrationPayload.ts#L46-L49)
- The mobile settings screen has only "Device Notifications" and "Live Activity Updates". Turning notifications off sends you to OS settings.
  [`apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx)
- The web profile page lists each device's flags read-only ("Alerts enabled for approvals, completions...").
  [`apps/web/src/components/clerk/MobileClientsUserProfilePage.logic.ts`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/web/src/components/clerk/MobileClientsUserProfilePage.logic.ts)

### Other ideas worth taking

- **Grouping.** Several agents changing state in one update produce one push: "3 agents need attention" with the thread titles in the body. Same file, `alertForActivityRows`.
- **Freshness limit.** Completed/failed pushes older than 2 minutes are dropped (`TERMINAL_NOTIFICATION_FRESHNESS_MS`). With no previous state to compare against, nothing pushes, so a reconnect replay does not buzz the phone.
- **Approval vs input.** Separate events and separate switches. Paseo merges both into `permission`.
- **Android channels.** High-importance `agent-alerts` for alerts, a separate `agent-activity` channel for ongoing live updates.
  [`apps/mobile/modules/t3-agent-notifications/android/.../AgentNotifications.kt:46-47`](https://github.com/pingdotgg/t3code/blob/5fe9d024d9b1c28ec93d495cf1441c57e47ae7ce/apps/mobile/modules/t3-agent-notifications/android/src/main/java/expo/modules/t3agentnotifications/AgentNotifications.kt#L46-L47)
- **iOS grouping.** APNs `thread-id` per thread so one noisy thread does not bury others (`infra/relay/src/agentActivity/ApnsClient.ts:192`).

## Proposed design for Paseo

Per-device, per-event switches. Mobile filtering happens in the daemon; desktop and web filtering happens in the client.

1. **Mobile push.** Add an optional `preferences` object to `register_push_token` (`packages/protocol/src/messages.ts:2889`). Store it with the token. In `send()` (`packages/server/src/server/push/index.ts:38`), skip tokens whose preferences turn the event off. Tokens without preferences get everything, so old apps behave as before. Optional field only, per [protocol-compatibility](../docs/protocol-compatibility.md).
2. **Desktop and web.** The client already gets `agent_attention_required` with `reason`. Add switches next to "Play sound" (`packages/app/src/desktop/settings/desktop-settings.ts:16`) and skip the OS notification when the event is off. Keep the sidebar status and in-app attention as is.
3. **Settings UI.** Settings → Notifications: Agent finished, Agent needs permission, Agent error. All on by default. Same switches on mobile, sent with the push token.

## Open questions

- **Errors.** `error` never pushes today (`agent-attention-policy.ts:78`). Should an "Agent error" switch enable pushes for errors, or apply to desktop only?
- **Split permission and question?** t3code separates approval from input. Paseo would need a new reason or a sub-kind on `permission`; the permission request `kind` (`tool`, `plan`, `question`, `mode`, `other`) already exists.
- **Where preferences live for mobile.** Per token on the daemon (above) or a daemon-wide setting? Per token matches t3code and lets phone and desktop differ.
- **Interaction with the presence rule.** If the chosen in-app recipient has the event off, should the daemon fall through to a push? Probably not: the user is present and chose silence.
- **Terminal and schedule notifications.** `broadcastTerminalAttention` and schedule finish notifications (#3948, #4268) would want the same switches.
- **Grouping and freshness.** Worth a follow-up after the switches land.
- **Plugin notify API (#5912, #6472).** Separate work, but a shared "notify the user" entry point would let per-event and per-plugin switches use one filter.
