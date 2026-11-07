import { createContext, useContext, type ReactNode } from "react";

/** A link rendered by a generic component, offered to the surrounding app scope for a menu. */
export interface LinkMenuInput {
  url: string;
  /** True when the link's own click always opens the system browser. */
  primaryOpensExternally: boolean;
  children: ReactNode;
}

/** Wraps a link in whatever context menu the surrounding scope offers; must not call hooks. */
export type LinkMenuWrapper = (input: LinkMenuInput) => ReactNode;

const passThrough: LinkMenuWrapper = ({ children }) => children;

/**
 * Extension point for generic link components (external links, Markdown links). Feature
 * scopes provide a wrapper; without one, links render unchanged.
 */
export const LinkMenuContext = createContext<LinkMenuWrapper>(passThrough);

export function useLinkMenu(): LinkMenuWrapper {
  return useContext(LinkMenuContext);
}
