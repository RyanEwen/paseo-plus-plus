import type { NaturalMessageGeometry } from "@/components/user-message-flow-model";

/** The RN sticky wrapper owns absolute L. Its nested cell's native y is local0.
 * Deliver each actual wrapper layout once to the existing VirtualizedList cell
 * callback. A fresh position identity gets a fresh channel, never stale replay. */
export function createNativeStickyLayout<T>(position?: {
  key: unknown;
  index: number | undefined;
  scope?: string;
  handoff?: "full-row";
}) {
  let latest: { event: T; revision: number } | null = null;
  let revision = 0;
  const subscribers = new Map<(event: T) => void, number>();
  let body: NaturalMessageGeometry | null = null;
  const bodySubscribers = new Set<(geometry: NaturalMessageGeometry | null) => void>();
  function deliver(callback: (event: T) => void) {
    if (!latest || subscribers.get(callback) === latest.revision) return;
    subscribers.set(callback, latest.revision);
    callback(latest.event);
  }
  return {
    position,
    readBody() {
      return body;
    },
    publishBody(geometry: NaturalMessageGeometry | null) {
      if (!geometry) {
        if (!body) return;
        body = null;
        for (const callback of bodySubscribers) callback(null);
        return;
      }
      if (body?.flowHeight === geometry.flowHeight && body.visualHeight === geometry.visualHeight)
        return;
      body = { flowHeight: geometry.flowHeight, visualHeight: geometry.visualHeight };
      for (const callback of bodySubscribers) callback(body);
    },
    subscribeBody(callback: (geometry: NaturalMessageGeometry | null) => void) {
      bodySubscribers.add(callback);
      if (body) callback(body);
      return () => {
        bodySubscribers.delete(callback);
      };
    },
    publish(event: T) {
      latest = { event, revision: ++revision };
      for (const callback of subscribers.keys()) deliver(callback);
    },
    subscribe(callback: (event: T) => void) {
      subscribers.set(callback, -1);
      deliver(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
  };
}
