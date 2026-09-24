// Process-local node state shared by node and full-device pairing removal.
import { randomUUID } from "node:crypto";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { removeRemoteNodeInfo } from "../skills/runtime/remote.js";
import { clearNodePendingWork } from "./node-pending-work.js";
import type { NodeRegistry } from "./node-registry.js";
import { invalidateNodeWakeState } from "./node-wake-state.js";

export type PendingNodeAction = {
  id: string;
  nodeId: string;
  pairingGeneration: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
  enqueuedAtMs: number;
};

const pendingNodeActionsById = resolveGlobalMap<string, PendingNodeAction[]>(
  Symbol.for("openclaw.pendingNodeActions"),
  "close-and-restart",
);

function prunePendingNodeActions(params: {
  nodeId: string;
  nowMs: number;
  ttlMs: number;
  pairingGeneration?: string;
}): PendingNodeAction[] {
  const queue = pendingNodeActionsById.get(params.nodeId) ?? [];
  const minTimestampMs = params.nowMs - params.ttlMs;
  const live = queue.filter((entry) => entry.enqueuedAtMs >= minTimestampMs);
  if (live.length === 0) {
    pendingNodeActionsById.delete(params.nodeId);
    return [];
  }
  pendingNodeActionsById.set(params.nodeId, live);
  return params.pairingGeneration
    ? live.filter((entry) => entry.pairingGeneration === params.pairingGeneration)
    : live;
}

export function replacePendingNodeActionsForGeneration(params: {
  nodeId: string;
  pairingGeneration: string;
  replacement: PendingNodeAction[];
  ttlMs: number;
  nowMs?: number;
}): void {
  const live = prunePendingNodeActions({
    nodeId: params.nodeId,
    nowMs: params.nowMs ?? Date.now(),
    ttlMs: params.ttlMs,
  });
  const next = [
    ...live.filter((entry) => entry.pairingGeneration !== params.pairingGeneration),
    ...params.replacement,
  ];
  if (next.length === 0) {
    pendingNodeActionsById.delete(params.nodeId);
    return;
  }
  pendingNodeActionsById.set(params.nodeId, next);
}

export function enqueuePendingNodeAction(params: {
  nodeId: string;
  pairingGeneration: string;
  command: string;
  paramsJSON?: string;
  idempotencyKey: string;
  ttlMs: number;
  maxPerNode: number;
  nowMs?: number;
}): { action: PendingNodeAction; created: boolean } {
  const nowMs = params.nowMs ?? Date.now();
  const queue = prunePendingNodeActions({
    nodeId: params.nodeId,
    nowMs,
    ttlMs: params.ttlMs,
    pairingGeneration: params.pairingGeneration,
  });
  const existing = queue.find((entry) => entry.idempotencyKey === params.idempotencyKey);
  if (existing) {
    return { action: existing, created: false };
  }
  // Idempotency keys are client-retry identity (see NodeInvokeParamsSchema:
  // "idempotency allows safe retries") and survive pairing-generation rotation,
  // so a retry after re-pair must not fork a second executable action. Pull and
  // acknowledgement stay generation-scoped, which would strand a survivor left
  // in the retired generation; rebind it into the current generation instead.
  // Queued actions carry no transferred agent or approval authority
  // (nodes.invoke.ts refuses to queue those), and pull re-validates the command
  // allowlist, so rebinding preserves the original authorization posture.
  const retained = pendingNodeActionsById.get(params.nodeId) ?? [];
  const duplicates = retained.filter((entry) => entry.idempotencyKey === params.idempotencyKey);
  const survivor = duplicates[0];
  if (survivor) {
    survivor.pairingGeneration = params.pairingGeneration;
    if (duplicates.length > 1) {
      // Collapse legacy duplicates so one key maps to one action ID.
      const survivorId = survivor.id;
      pendingNodeActionsById.set(
        params.nodeId,
        retained.filter(
          (entry) => entry.id === survivorId || entry.idempotencyKey !== params.idempotencyKey,
        ),
      );
    }
    return { action: survivor, created: false };
  }
  const action: PendingNodeAction = {
    id: randomUUID(),
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    command: params.command,
    paramsJSON: params.paramsJSON,
    idempotencyKey: params.idempotencyKey,
    enqueuedAtMs: nowMs,
  };
  queue.push(action);
  if (queue.length > params.maxPerNode) {
    queue.splice(0, queue.length - params.maxPerNode);
  }
  replacePendingNodeActionsForGeneration({
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    replacement: queue,
    ttlMs: params.ttlMs,
    nowMs,
  });
  return { action, created: true };
}

export function listPendingNodeActions(params: {
  nodeId: string;
  pairingGeneration?: string;
  ttlMs: number;
  nowMs?: number;
}): PendingNodeAction[] {
  return prunePendingNodeActions({
    nodeId: params.nodeId,
    nowMs: params.nowMs ?? Date.now(),
    ttlMs: params.ttlMs,
    pairingGeneration: params.pairingGeneration,
  });
}

export function acknowledgePendingNodeActions(params: {
  nodeId: string;
  pairingGeneration: string;
  ids: readonly string[];
  ttlMs: number;
}): PendingNodeAction[] {
  const pending = prunePendingNodeActions({
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    nowMs: Date.now(),
    ttlMs: params.ttlMs,
  });
  if (params.ids.length === 0) {
    return pending;
  }
  const ids = new Set(params.ids);
  const remaining = pending.filter((entry) => !ids.has(entry.id));
  replacePendingNodeActionsForGeneration({
    ...params,
    replacement: remaining,
  });
  return remaining;
}

export function removePendingNodeAction(params: {
  nodeId: string;
  pairingGeneration: string;
  actionId: string;
  ttlMs: number;
}): void {
  const pending = prunePendingNodeActions({
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    nowMs: Date.now(),
    ttlMs: params.ttlMs,
  });
  const remaining = pending.filter((entry) => entry.id !== params.actionId);
  if (remaining.length === pending.length) {
    return;
  }
  replacePendingNodeActionsForGeneration({
    ...params,
    replacement: remaining,
  });
}

function clearPendingNodeActions(nodeId: string): void {
  pendingNodeActionsById.delete(nodeId);
}

export function clearRemovedNodeRuntimeState(params: {
  nodeId: string;
  context: {
    nodeRegistry: Pick<NodeRegistry, "updateSurface">;
  };
}) {
  clearPendingNodeActions(params.nodeId);
  clearNodePendingWork(params.nodeId);
  invalidateNodeWakeState(params.nodeId);
  params.context.nodeRegistry.updateSurface(params.nodeId, {
    caps: [],
    commands: [],
    permissions: undefined,
  });
  removeRemoteNodeInfo(params.nodeId);
}
