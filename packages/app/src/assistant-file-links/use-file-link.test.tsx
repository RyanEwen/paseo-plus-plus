/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import type { InlinePathTarget } from "./parse";
import { AssistantFileLinkResolverProvider } from "./provider";
import {
  WorkspaceBrowserOpenerProvider,
  WorkspaceLinkPolicyContext,
  useWorkspaceLinkOpening,
  type WorkspaceLinkPolicy,
} from "@/workspace/browser/context";
import { openExternalUrl } from "@/utils/open-external-url";
import { toErrorMessage } from "@/utils/error-messages";
import type { DirectorySuggestionResult } from "./resolver";
import { useFileLink } from "./use-file-link";
import type { OpenFileDisposition } from "@/workspace/file-open";

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

const SOURCE = {
  href: "http://dumm.md",
  text: "dumm.md",
  markup: "linkify",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

interface OpenedFile {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
}

interface TestClient {
  getDirectorySuggestions: (input: {
    query: string;
    cwd: string;
    includeFiles: true;
    includeDirectories: false;
    matchMode: "suffix";
    limit: number;
  }) => Promise<DirectorySuggestionResult>;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createToast(): ToastApi {
  return {
    show: vi.fn<ToastApi["show"]>(),
    copied: vi.fn<ToastApi["copied"]>(),
    error: vi.fn<ToastApi["error"]>(),
  };
}

/** The Workspace links preference as the policy port sees it; tests flip `enabled` directly. */
interface TestPreference {
  enabled: boolean;
}

function createWrapper(input: {
  client: TestClient;
  openedFiles: OpenedFile[];
  toast?: ToastApi;
  preference?: TestPreference;
  onOpenHttpUrl?: (url: string) => void | Promise<void>;
}) {
  const queryClient = createQueryClient();
  const toast = input.toast ?? createToast();
  const preference = input.preference ?? { enabled: true };
  return function Wrapper({ children }: { children: ReactNode }) {
    // Rebuilt on every render so a rerender after flipping the preference updates `enabled`.
    const policy: WorkspaceLinkPolicy = {
      enabled: preference.enabled,
      isEnabled: () => preference.enabled,
      reportError: (error) => toast.error(toErrorMessage(error)),
    };
    const openWorkspaceFile = useCallback(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        input.openedFiles.push({ target, disposition });
      },
      [],
    );

    return (
      <QueryClientProvider client={queryClient}>
        <WorkspaceLinkPolicyContext.Provider value={policy}>
          <WorkspaceBrowserOpenerProvider value={input.onOpenHttpUrl}>
            <AssistantFileLinkResolverProvider
              client={input.client}
              serverId="server-1"
              workspaceRoot="/Users/test/project"
              onOpenWorkspaceFile={openWorkspaceFile}
              toast={input.toast}
            >
              {children}
            </AssistantFileLinkResolverProvider>
          </WorkspaceBrowserOpenerProvider>
        </WorkspaceLinkPolicyContext.Provider>
      </QueryClientProvider>
    );
  };
}

describe("useFileLink", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.clearAllMocks();
  });

  it("reports a failed owning browser activation once without opening externally", async () => {
    const toast = createToast();
    const openedUrls: string[] = [];
    const { result } = renderHook(() => useWorkspaceLinkOpening(), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions: async () => resolvedSuggestions([]) },
        openedFiles: [],
        toast,
        onOpenHttpUrl: async (url) => {
          openedUrls.push(url);
          throw new Error("Owning workspace is unavailable");
        },
      }),
    });

    await act(async () => {
      await result.current.openPrimary("https://example.com/owned");
    });

    expect(openedUrls).toEqual(["https://example.com/owned"]);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Owning workspace is unavailable");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("applies the preference at activation time to a primary opener captured earlier", async () => {
    const preference = { enabled: true };
    const internal: string[] = [];
    const { result } = renderHook(() => useWorkspaceLinkOpening(), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions: async () => resolvedSuggestions([]) },
        openedFiles: [],
        preference,
        onOpenHttpUrl: (url) => {
          internal.push(url);
        },
      }),
    });
    const capturedPrimary = result.current.openPrimary;

    preference.enabled = false;
    await act(async () => {
      await capturedPrimary("https://example.com/after-turning-off");
    });

    expect(internal).toEqual([]);
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/after-turning-off",
    );
  });

  it("toasts an asynchronous menu failure through the scope's error reporter", async () => {
    const toast = createToast();
    const failure = createDeferred<void>();
    const { result } = renderHook(() => useWorkspaceLinkOpening(), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions: async () => resolvedSuggestions([]) },
        openedFiles: [],
        toast,
        onOpenHttpUrl: async () => {},
      }),
    });
    const pendingMenuAction = failure.promise.catch(result.current.reportError);

    await act(async () => {
      failure.reject(new Error("Could not open terminal link"));
      await pendingMenuAction;
    });

    expect(toast.error).toHaveBeenCalledExactlyOnceWith("Could not open terminal link");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens a chat HTTP link in the workspace browser when Workspace links is on", async () => {
    const onOpenHttpUrl = vi.fn(async () => {});
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const source = { href: "https://example.invalid/guide" };
    const { result } = renderHook(() => useFileLink(source), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles: [],
        preference: { enabled: true },
        onOpenHttpUrl,
      }),
    });

    act(() => result.current.onPress());

    await waitFor(() => expect(onOpenHttpUrl).toHaveBeenCalledExactlyOnceWith(source.href));
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
  });

  it("opens a chat HTTP link externally when Workspace links is off", async () => {
    const onOpenHttpUrl = vi.fn(async () => {});
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const source = { href: "https://example.invalid/guide" };
    const { result } = renderHook(() => useFileLink(source), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles: [],
        preference: { enabled: false },
        onOpenHttpUrl,
      }),
    });

    act(() => result.current.onPress());

    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(source.href));
    expect(onOpenHttpUrl).not.toHaveBeenCalled();
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
  });

  it("opens HTTP links externally when the preference is on but no owning opener is available", async () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const openedFiles: OpenedFile[] = [];
    const source = { href: "https://example.invalid/no-owning-opener" };
    const { result } = renderHook(() => useFileLink(source), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
        preference: { enabled: true },
      }),
    });
    act(() => result.current.onPress());
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(source.href));
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(openedFiles).toEqual([]);
  });

  it("keeps the explicit browser opener and offers it as the alternate when primary opening is off", async () => {
    const preference = { enabled: true };
    const onOpenHttpUrl = vi.fn(async () => {});
    const { result, rerender } = renderHook(() => useWorkspaceLinkOpening(), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions: vi.fn(async () => resolvedSuggestions([])) },
        openedFiles: [],
        preference,
        onOpenHttpUrl,
      }),
    });
    expect(result.current.defaultDestination).toBe("paseo");

    preference.enabled = false;
    rerender();
    expect(result.current.defaultDestination).toBe("external");

    await act(async () => {
      await result.current.openInPaseo?.("https://example.invalid/explicit");
    });
    expect(onOpenHttpUrl).toHaveBeenCalledExactlyOnceWith("https://example.invalid/explicit");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens externally after a pending file lookup when the preference was turned off during it", async () => {
    const preference = { enabled: true };
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const onOpenHttpUrl = vi.fn(async () => {});
    const httpSource = { href: "https://example.invalid/after-lookup" };
    const { result, rerender } = renderHook(
      () => ({ file: useFileLink(SOURCE), http: useFileLink(httpSource) }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
          preference,
          onOpenHttpUrl,
        }),
      },
    );
    const capturedHttpPress = result.current.http.onPress;
    act(() => result.current.file.onPress());
    await waitFor(() => expect(getDirectorySuggestions).toHaveBeenCalledTimes(1));

    preference.enabled = false;
    rerender();
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => expect(openedFiles).toHaveLength(1));
    expect(openedFiles[0].target.path).toBe("/Users/test/project/docs/dumm.md");

    act(() => capturedHttpPress());
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(httpSource.href));
    expect(onOpenHttpUrl).not.toHaveBeenCalled();
  });

  it("opens in the workspace browser after a pending file lookup when the preference was turned on during it", async () => {
    const preference = { enabled: false };
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const onOpenHttpUrl = vi.fn(async () => {});
    const httpSource = { href: "https://example.invalid/after-lookup" };
    const { result, rerender } = renderHook(
      () => ({ file: useFileLink(SOURCE), http: useFileLink(httpSource) }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
          preference,
          onOpenHttpUrl,
        }),
      },
    );
    const capturedHttpPress = result.current.http.onPress;
    act(() => result.current.file.onPress());
    await waitFor(() => expect(getDirectorySuggestions).toHaveBeenCalledTimes(1));

    preference.enabled = true;
    rerender();
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => expect(openedFiles).toHaveLength(1));
    expect(openedFiles[0].target.path).toBe("/Users/test/project/docs/dumm.md");

    act(() => capturedHttpPress());
    await waitFor(() => expect(onOpenHttpUrl).toHaveBeenCalledExactlyOnceWith(httpSource.href));
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  // Lookups resolve after a test's last assertion; an unmounted hook cannot re-render
  // once jsdom is torn down.
  afterEach(() => {
    cleanup();
  });

  it("returns the same object across no-op parent rerenders", () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const queryClient = createQueryClient();
    const Provider = AssistantFileLinkResolverProvider as React.ComponentType<
      Omit<React.ComponentProps<typeof AssistantFileLinkResolverProvider>, "children"> & {
        children?: ReactNode;
      }
    >;

    function ChurningProviderWrapper({ children }: { children: ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Provider,
          {
            client: { getDirectorySuggestions },
            serverId: "server-1",
            workspaceRoot: "/Users/test/project",
            onOpenWorkspaceFile: () => {},
            toast: createToast(),
          },
          children,
        ),
      );
    }

    const { result, rerender } = renderHook(() => useFileLink({ ...SOURCE }), {
      wrapper: ChurningProviderWrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.onHoverIn).toBe(first.onHoverIn);
    expect(result.current.onPress).toBe(first.onPress);
    expect(result.current.open).toBe(first.open);
  });

  it("does not cache unresolved lookups forever", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockResolvedValueOnce(resolvedSuggestions([]))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
        toast,
      }),
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledWith("No file found for dumm.md", {
        variant: "error",
        testID: "assistant-file-link-not-found-toast",
      });
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toEqual([
        {
          target: {
            raw: "dumm.md",
            path: "/Users/test/project/docs/dumm.md",
            lineStart: undefined,
            lineEnd: undefined,
          },
          disposition: "preferred",
        },
      ]);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("click retries after hover prefetch fails", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("dedupes two links pointing at the same source", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(
      () => ({
        first: useFileLink(SOURCE),
        second: useFileLink(SOURCE),
      }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
        }),
      },
    );

    act(() => {
      result.current.first.onHoverIn();
      result.current.second.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => {
      expect(result.current.first.target?.path).toBe("/Users/test/project/docs/dumm.md");
      expect(result.current.second.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });
  });

  it("hover then click uses the prefetched result", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(result.current.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale result after the workspace changes", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const queryClient = createQueryClient();

    function Wrapper({ children }: { children: ReactNode }) {
      const [workspaceRoot, setWorkspaceRoot] = useState("/Users/test/project");
      const client = useMemo(() => ({ getDirectorySuggestions }), []);
      const openWorkspaceFile = useCallback(
        (target: InlinePathTarget, disposition: OpenFileDisposition) => {
          openedFiles.push({ target, disposition });
        },
        [],
      );
      return (
        <QueryClientProvider client={queryClient}>
          <AssistantFileLinkResolverProvider
            client={client}
            serverId="server-1"
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={openWorkspaceFile}
          >
            <WorkspaceSwitchContext.Provider value={setWorkspaceRoot}>
              {children}
            </WorkspaceSwitchContext.Provider>
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        link: useFileLink(SOURCE),
        setWorkspaceRoot: React.useContext(WorkspaceSwitchContext),
      }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.link.onPress();
    });
    act(() => {
      result.current.setWorkspaceRoot("/Users/test/other");
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));

    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    expect(openedFiles).toEqual([]);
  });
});

const WorkspaceSwitchContext = React.createContext<(workspaceRoot: string) => void>(() => {});
