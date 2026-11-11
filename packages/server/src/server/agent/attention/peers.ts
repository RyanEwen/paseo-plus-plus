import type { AgentAttentionPeer } from "@getpaseo/protocol/agent-attention";

/** Two peers are the same agent once an omitted server id is read as the local host. */
export function samePeer(input: {
  left: AgentAttentionPeer;
  right: AgentAttentionPeer;
  localServerId: string | undefined;
}): boolean {
  const { left, right, localServerId } = input;
  return (
    left.agentId === right.agentId &&
    (left.serverId ?? localServerId) === (right.serverId ?? localServerId)
  );
}

/** A peer on another host; an omitted server id is the local host. */
export function isRemotePeer(peer: AgentAttentionPeer, localServerId: string | undefined): boolean {
  return peer.serverId !== undefined && peer.serverId !== localServerId;
}
