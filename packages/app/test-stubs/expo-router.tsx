import type { ReactNode } from "react";
import { vi } from "vitest";

// Navigation is an app-shell boundary in component tests on every Vitest project.
const RouterPassthrough = ({ children }: { children?: ReactNode }) => children;
const adapter = {
  Redirect: () => null,
  Stack: Object.assign(RouterPassthrough, {
    Screen: () => null,
    Protected: RouterPassthrough,
  }),
  router: {
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    navigate: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
  },
  useGlobalSearchParams: vi.fn(() => ({})),
  useLocalSearchParams: vi.fn(() => ({})),
  usePathname: vi.fn(() => "/"),
  useRootNavigationState: vi.fn(() => ({ key: "root" })),
  useRouter: vi.fn(() => ({
    back: vi.fn(),
    canGoBack: vi.fn(() => false),
    navigate: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    setParams: vi.fn(),
  })),
};
export const {
  Redirect,
  Stack,
  router,
  useGlobalSearchParams,
  useLocalSearchParams,
  usePathname,
  useRootNavigationState,
  useRouter,
} = adapter;
