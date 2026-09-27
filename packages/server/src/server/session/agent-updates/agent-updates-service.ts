import type pino from "pino";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { AgentStateUpdateReason, ManagedAgent } from "../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { resolveEffectiveThinkingOptionId, toAgentPayload } from "../../agent/agent-projections.js";

/**
 * Minimum spacing between usage-only snapshots of one agent to one session.
 * Claude reports usage twice per API step (message_start and message_delta), and
 * each snapshot costs a storage read, project placement, a directory sequence and
 * a workspace descriptor rebuild for every connected client. lastUsage only feeds
 * usage displays such as the context meter, so they can lag by up to this window.
 * State changes are never throttled and carry the latest usage with them.
 */
export const USAGE_UPDATE_THROTTLE_MS = 2000;

type AgentUpdatePayload = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
type AgentUpdatesFilter = NonNullable<
  Extract<SessionInboundMessage, { type: "fetch_agents_request" }>["filter"]
>;

interface AgentUpdatesSubscriptionState {
  subscriptionId: string;
  emit: (message: SessionOutboundMessage) => void;
  syncEnabled: boolean;
  filter?: AgentUpdatesFilter;
  isProviderVisible: (provider: string) => boolean;
  isBootstrapping: boolean;
  pendingUpdatesByAgentId: Map<string, AgentUpdatePayload>;
}

/** Owns filtered agent snapshots and live updates for independent observers. */
export interface AgentUpdatesService {
  beginSubscription(input: {
    subscriptionId: string;
    isProviderVisible?: (provider: string) => boolean;
    emit?: (message: SessionOutboundMessage) => void;
    filter?: AgentUpdatesFilter;
    syncEnabled?: boolean;
  }): void;
  flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): void;
  clearSubscription(subscriptionId: string): void;
  hasSubscription(): boolean;
  includesLiveAgent(agent: ManagedAgent, subscriptionIds?: ReadonlySet<string>): Promise<boolean>;
  /**
   * Publish a live agent snapshot. "state" (the default) is sent immediately.
   * "usage" is sent immediately when the agent has no open usage window, and
   * otherwise at most once per window with the latest snapshot. The returned
   * promise settles once a snapshot sent now has gone out; a throttled usage
   * snapshot resolves at once.
   */
  forwardLiveAgent(
    agent: ManagedAgent,
    options?: { reason?: AgentStateUpdateReason },
  ): Promise<void>;
  emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload>;
  removeAgent(agentId: string): Promise<void>;
  dispose(): void;
}

export interface AgentUpdatesServiceDeps {
  emit(message: SessionOutboundMessage): void;
  enrichAgentPayload(payload: AgentSnapshotPayload): Promise<AgentSnapshotPayload>;
  buildStoredAgentPayload(record: StoredAgentRecord): AgentSnapshotPayload;
  isProviderVisibleToClient(provider: string): boolean;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<ProjectPlacementPayload | null>;
  emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void>;
  sequenceAgentUpdate<T extends AgentUpdatePayload>(
    payload: T,
    agent: AgentSnapshotPayload | null,
    project: ProjectPlacementPayload | null,
    agentId: string,
    includeSequence: boolean,
  ): T;
  logger: pino.Logger;
}

function agentThinkingOptionMatchesFilter(
  agent: AgentSnapshotPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.thinkingOptionId === undefined) {
    return true;
  }
  const expectedThinkingOptionId = resolveEffectiveThinkingOptionId({
    configuredThinkingOptionId: filter.thinkingOptionId ?? null,
  });
  const resolvedThinkingOptionId =
    agent.effectiveThinkingOptionId ??
    resolveEffectiveThinkingOptionId({
      runtimeInfo: agent.runtimeInfo,
      configuredThinkingOptionId: agent.thinkingOptionId ?? null,
    });
  return resolvedThinkingOptionId === expectedThinkingOptionId;
}

function matchesAgentStructuralFilter(
  agent: AgentSnapshotPayload,
  project: ProjectPlacementPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.statuses && filter.statuses.length > 0) {
    const statuses = new Set(filter.statuses);
    if (!statuses.has(agent.status)) {
      return false;
    }
  }

  if (typeof filter.requiresAttention === "boolean") {
    const requiresAttention = agent.requiresAttention ?? false;
    if (requiresAttention !== filter.requiresAttention) {
      return false;
    }
  }

  if (filter.projectKeys && filter.projectKeys.length > 0) {
    const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
    if (projectKeys.size > 0 && !projectKeys.has(project.projectKey)) {
      return false;
    }
  }
  return true;
}

/**
 * Pure predicate shared by the live subscription stream and the snapshot listing
 * pager: does an agent (with its resolved project placement) satisfy a
 * `fetch_agents` filter?
 */
export function matchesAgentUpdatesFilter(input: {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  filter?: AgentUpdatesFilter;
}): boolean {
  const { agent, project, filter } = input;

  if (filter?.labels) {
    const matchesLabels = Object.entries(filter.labels).every(
      ([key, value]) => agent.labels[key] === value,
    );
    if (!matchesLabels) {
      return false;
    }
  }

  const includeArchived = filter?.includeArchived ?? false;
  if (!includeArchived && agent.archivedAt) {
    return false;
  }

  if (filter && !agentThinkingOptionMatchesFilter(agent, filter)) {
    return false;
  }

  if (filter && !matchesAgentStructuralFilter(agent, project, filter)) {
    return false;
  }

  return true;
}

interface UsageWindow {
  timer: ReturnType<typeof setTimeout>;
  pendingAgent: ManagedAgent | null;
}

function agentUpdateTargetId(update: AgentUpdatePayload): string {
  return update.kind === "remove" ? update.agentId : update.agent.id;
}

export function createAgentUpdatesService(deps: AgentUpdatesServiceDeps): AgentUpdatesService {
  const subscriptions = new Map<string, AgentUpdatesSubscriptionState>();
  const liveAgentUpdateTails = new Map<string, Promise<void>>();
  const usageWindows = new Map<string, UsageWindow>();
  const sequence = <T extends AgentUpdatePayload>(
    sub: AgentUpdatesSubscriptionState,
    payload: T,
    agent: AgentSnapshotPayload | null,
    project: ProjectPlacementPayload | null,
    agentId: string,
  ) => deps.sequenceAgentUpdate(payload, agent, project, agentId, sub.syncEnabled === true);

  function bufferOrEmit(sub: AgentUpdatesSubscriptionState, payload: AgentUpdatePayload): void {
    if (subscriptions.get(sub.subscriptionId) !== sub) return;
    if (payload.kind === "upsert" && !sub.isProviderVisible(payload.agent.provider)) {
      return;
    }
    if (sub.isBootstrapping) {
      sub.pendingUpdatesByAgentId.set(agentUpdateTargetId(payload), payload);
      return;
    }

    sub.emit({ type: "agent_update", payload });
  }

  function beginSubscription(input: {
    subscriptionId: string;
    isProviderVisible?: (provider: string) => boolean;
    emit?: (message: SessionOutboundMessage) => void;
    filter?: AgentUpdatesFilter;
    syncEnabled?: boolean;
  }): void {
    subscriptions.set(input.subscriptionId, {
      ...input,
      emit: input.emit ?? deps.emit,
      syncEnabled: input.syncEnabled ?? false,
      isProviderVisible: input.isProviderVisible ?? deps.isProviderVisibleToClient,
      isBootstrapping: true,
      pendingUpdatesByAgentId: new Map(),
    });
  }

  function flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): void {
    const sub = subscriptions.get(subscriptionId);
    if (!sub?.isBootstrapping) return;
    sub.isBootstrapping = false;
    const pending = Array.from(sub.pendingUpdatesByAgentId.values());
    sub.pendingUpdatesByAgentId.clear();
    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshotUpdatedAt = options?.snapshotUpdatedAtByAgentId?.get(payload.agent.id);
        if (
          snapshotUpdatedAt !== undefined &&
          Date.parse(payload.agent.updatedAt) < snapshotUpdatedAt
        )
          continue;
      }
      bufferOrEmit(sub, payload);
    }
  }

  function clearSubscription(subscriptionId: string): void {
    subscriptions.delete(subscriptionId);
    if (subscriptions.size === 0) cancelAllUsageWindows();
  }

  function hasSubscription(): boolean {
    return subscriptions.size > 0;
  }

  async function includesLiveAgent(
    agent: ManagedAgent,
    subscriptionIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    const observers = [...subscriptions.values()].filter(
      (sub) => !subscriptionIds || subscriptionIds.has(sub.subscriptionId),
    );
    if (observers.length === 0) return false;
    const payload = await deps.enrichAgentPayload(toAgentPayload(agent));
    const project = payload.workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(payload.workspaceId)
      : null;
    return (
      project !== null &&
      observers.some(
        (sub) =>
          sub.isProviderVisible(payload.provider) &&
          matchesAgentUpdatesFilter({ agent: payload, project, filter: sub.filter }),
      )
    );
  }

  async function publishPayload(payload: AgentSnapshotPayload): Promise<void> {
    const observers = [...subscriptions.values()];
    if (observers.length === 0) return;
    const project = payload.workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(payload.workspaceId)
      : null;
    for (const sub of observers) {
      const matches =
        project && matchesAgentUpdatesFilter({ agent: payload, project, filter: sub.filter });
      bufferOrEmit(
        sub,
        sequence(
          sub,
          matches
            ? { kind: "upsert", agent: payload, project }
            : { kind: "remove", agentId: payload.id },
          payload,
          project,
          payload.id,
        ),
      );
    }
  }

  async function emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload> {
    // Archive and detach publish the stored record. Drop any pending usage
    // snapshot and queue behind in-flight live snapshots so a stale live upsert
    // cannot land after the archived record and resurrect the agent.
    cancelUsageWindow(record.id);
    const payload = deps.buildStoredAgentPayload(record);
    await enqueueAgentUpdate(record.id, () => publishPayload(payload));
    return payload;
  }

  async function emitLiveAgentUpdate(payload: AgentSnapshotPayload): Promise<void> {
    try {
      if (hasSubscription()) await publishPayload(await deps.enrichAgentPayload(payload));
      if (payload.workspaceId) await deps.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
    } catch (error) {
      deps.logger.error({ err: error }, "Failed to emit agent update");
    }
  }

  function enqueueAgentUpdate(
    agentId: string,
    emitUpdate: () => void | Promise<void>,
  ): Promise<void> {
    const previous = liveAgentUpdateTails.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(emitUpdate);
    liveAgentUpdateTails.set(agentId, next);
    void next.finally(() => {
      if (liveAgentUpdateTails.get(agentId) === next) {
        liveAgentUpdateTails.delete(agentId);
      }
    });
    return next;
  }

  function cancelUsageWindow(agentId: string): void {
    const usageWindow = usageWindows.get(agentId);
    if (!usageWindow) return;
    clearTimeout(usageWindow.timer);
    usageWindows.delete(agentId);
  }

  function cancelAllUsageWindows(): void {
    for (const usageWindow of usageWindows.values()) clearTimeout(usageWindow.timer);
    usageWindows.clear();
  }

  function openUsageWindow(agentId: string): UsageWindow {
    const usageWindow: UsageWindow = {
      timer: setTimeout(() => closeUsageWindow(agentId, usageWindow), USAGE_UPDATE_THROTTLE_MS),
      pendingAgent: null,
    };
    usageWindows.set(agentId, usageWindow);
    return usageWindow;
  }

  function closeUsageWindow(agentId: string, usageWindow: UsageWindow): void {
    if (usageWindows.get(agentId) !== usageWindow) return;
    usageWindows.delete(agentId);
    const pendingAgent = usageWindow.pendingAgent;
    if (!pendingAgent) return;
    // The trailing send opens the next window, so a steady stream of usage
    // produces one snapshot per window.
    openUsageWindow(agentId);
    void publishLiveAgent(pendingAgent);
  }

  function forwardLiveAgent(
    agent: ManagedAgent,
    options?: { reason?: AgentStateUpdateReason },
  ): Promise<void> {
    const usageWindow = usageWindows.get(agent.id);
    if (options?.reason === "usage") {
      if (usageWindow) {
        usageWindow.pendingAgent = agent;
        return Promise.resolve();
      }
      openUsageWindow(agent.id);
    } else if (usageWindow) {
      // This snapshot already carries the latest usage.
      usageWindow.pendingAgent = null;
    }
    return publishLiveAgent(agent);
  }

  function publishLiveAgent(agent: ManagedAgent): Promise<void> {
    if (!hasSubscription()) {
      const workspaceId = agent.workspaceId;
      return workspaceId
        ? enqueueAgentUpdate(agent.id, async () => {
            try {
              await deps.emitWorkspaceUpdateForWorkspaceId(workspaceId);
            } catch (error) {
              deps.logger.error({ err: error }, "Failed to emit workspace update");
            }
          })
        : Promise.resolve();
    }
    const payload = toAgentPayload(agent);
    return enqueueAgentUpdate(payload.id, () => emitLiveAgentUpdate(payload));
  }

  function removeAgent(agentId: string): Promise<void> {
    cancelUsageWindow(agentId);
    return enqueueAgentUpdate(agentId, () => {
      for (const sub of subscriptions.values()) {
        bufferOrEmit(sub, sequence(sub, { kind: "remove", agentId }, null, null, agentId));
      }
    });
  }

  function dispose(): void {
    subscriptions.clear();
    cancelAllUsageWindows();
  }

  return {
    beginSubscription,
    flushBootstrapped,
    clearSubscription,
    hasSubscription,
    includesLiveAgent,
    forwardLiveAgent,
    emitStoredRecord,
    removeAgent,
    dispose,
  };
}
