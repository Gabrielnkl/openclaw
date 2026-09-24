/**
 * Pending foreground-action idempotency tests.
 *
 * Regression coverage: enqueueing the same (nodeId, idempotencyKey) under a
 * rotated pairing generation must not fork a second executable action. The
 * survivor is rebound into the current generation so generation-scoped
 * pull/ack can consume it exactly once.
 */
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgePendingNodeActions,
  clearRemovedNodeRuntimeState,
  enqueuePendingNodeAction,
  listPendingNodeActions,
  removePendingNodeAction,
} from "./node-runtime-state.js";

// node-runtime-state re-exports removal across node, wake, and remote-skill
// state. The pending-action units under test never touch remote skills; mock
// that heavy transitive import so this focused suite stays dependency-light.
vi.mock("../skills/runtime/remote.js", () => ({
  removeRemoteNodeInfo: vi.fn(),
}));

const TTL_MS = 10 * 60_000;
const MAX_PER_NODE = 64;

let nodeSeq = 0;
function freshNodeId(): string {
  nodeSeq += 1;
  return `test-pending-action-${nodeSeq}`;
}

describe("pending foreground-action idempotency across pairing generations", () => {
  it("dedupes the same key across generations without forking a second action", () => {
    const nodeId = freshNodeId();
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      paramsJSON: '{"a":1}',
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(first.created).toBe(true);

    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      paramsJSON: '{"a":1}',
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);

    const all = listPendingNodeActions({ nodeId, ttlMs: TTL_MS });
    expect(all).toHaveLength(1);
  });

  it("rebinds the survivor into the generation that can pull it", () => {
    const nodeId = freshNodeId();
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });

    expect(second.action.pairingGeneration).toBe("gen-2");
    expect(second.action.enqueuedAtMs).toBe(first.action.enqueuedAtMs);
    expect(
      listPendingNodeActions({ nodeId, pairingGeneration: "gen-2", ttlMs: TTL_MS }).map(
        (entry) => entry.id,
      ),
    ).toEqual([first.action.id]);
    expect(listPendingNodeActions({ nodeId, pairingGeneration: "gen-1", ttlMs: TTL_MS })).toEqual(
      [],
    );
  });

  it("acks the rebound action exactly once with no orphan left behind", () => {
    const nodeId = freshNodeId();
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(second.action.id).toBe(first.action.id);

    const remaining = acknowledgePendingNodeActions({
      nodeId,
      pairingGeneration: "gen-2",
      ids: [second.action.id],
      ttlMs: TTL_MS,
    });
    expect(remaining).toEqual([]);
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toEqual([]);
    expect(listPendingNodeActions({ nodeId, pairingGeneration: "gen-1", ttlMs: TTL_MS })).toEqual(
      [],
    );
  });

  it("removes the rebound action under the current generation", () => {
    const nodeId = freshNodeId();
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });

    removePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      actionId: first.action.id,
      ttlMs: TTL_MS,
    });
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toEqual([]);
  });

  it("keeps same-generation dedupe behavior unchanged", () => {
    const nodeId = freshNodeId();
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);
    expect(second.action.pairingGeneration).toBe("gen-1");
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toHaveLength(1);
  });

  it("keeps different idempotency keys independent", () => {
    const nodeId = freshNodeId();
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-2",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.action.id).not.toBe(first.action.id);
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toHaveLength(2);
  });

  it("anchors TTL at the original enqueue across rebinding", () => {
    const nodeId = freshNodeId();
    const startMs = 1_000_000;
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
      nowMs: startMs,
    });
    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
      nowMs: startMs + 60_000,
    });
    expect(second.created).toBe(false);
    expect(second.action.enqueuedAtMs).toBe(first.action.enqueuedAtMs);

    // Expiry is relative to the original enqueue, not the rebind.
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS, nowMs: startMs + TTL_MS + 1 })).toEqual(
      [],
    );
  });

  it("allows a new action for the same key after TTL expiry", () => {
    const nodeId = freshNodeId();
    const startMs = 2_000_000;
    const first = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
      nowMs: startMs,
    });
    const second = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
      nowMs: startMs + TTL_MS + 1,
    });
    expect(second.created).toBe(true);
    expect(second.action.id).not.toBe(first.action.id);
  });

  it("keeps pull/ack generation scoping for distinct keys", () => {
    const nodeId = freshNodeId();
    const queued = enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(listPendingNodeActions({ nodeId, pairingGeneration: "gen-2", ttlMs: TTL_MS })).toEqual(
      [],
    );
    expect(
      listPendingNodeActions({ nodeId, pairingGeneration: "gen-1", ttlMs: TTL_MS }).map(
        (entry) => entry.id,
      ),
    ).toEqual([queued.action.id]);

    // Acking under the wrong generation is a no-op for the stored action.
    acknowledgePendingNodeActions({
      nodeId,
      pairingGeneration: "gen-2",
      ids: [queued.action.id],
      ttlMs: TTL_MS,
    });
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toHaveLength(1);
  });

  it("clears rebound pending actions when the node is removed", () => {
    const nodeId = freshNodeId();
    enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-1",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    enqueuePendingNodeAction({
      nodeId,
      pairingGeneration: "gen-2",
      command: "camera.capture",
      idempotencyKey: "key-1",
      ttlMs: TTL_MS,
      maxPerNode: MAX_PER_NODE,
    });
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toHaveLength(1);

    clearRemovedNodeRuntimeState({
      nodeId,
      context: {
        nodeRegistry: {
          updateSurface: () => null,
        },
      },
    });
    expect(listPendingNodeActions({ nodeId, ttlMs: TTL_MS })).toEqual([]);
  });
});
