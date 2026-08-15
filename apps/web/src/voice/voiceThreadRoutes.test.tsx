import {
  createMemoryHistory,
  Match,
  Outlet,
  RouterContextProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const messages = [
    {
      id: "message-1",
      role: "user",
      text: "Keep this history",
      turnId: null,
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      streaming: false,
    },
    {
      id: "message-2",
      role: "assistant",
      text: "History retained",
      turnId: null,
      createdAt: "2026-08-14T00:00:01.000Z",
      updatedAt: "2026-08-14T00:00:01.000Z",
      streaming: false,
    },
  ];
  const provider = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-14T00:00:00.000Z",
    models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: {} }],
    slashCommands: [],
    skills: [],
  };
  const project = {
    id: "project-one",
    environmentId: "env-one",
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5", options: {} },
  };
  const thread = {
    id: "thread-two",
    environmentId: "env-one",
    projectId: "project-one",
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "gpt-5", options: {} },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:01.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
  };
  const serverConfig = {
    providers: [provider],
    environment: { capabilities: { pullRequests: false } },
  };
  const environment = {
    environmentId: "env-one",
    label: "Local",
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig,
  };
  return {
    controls: new Map<string, () => void>(),
    environment,
    messages,
    micOff: vi.fn(),
    project,
    thread,
  };
});

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");
  return {
    LegendList: (props: {
      readonly data: ReadonlyArray<{ id: string }>;
      readonly keyExtractor: (item: { id: string }) => string;
      readonly renderItem: (args: { item: { id: string } }) => ReactNode;
      readonly ListHeaderComponent?: ReactNode;
      readonly ListFooterComponent?: ReactNode;
    }) =>
      React.createElement(
        "div",
        null,
        props.ListHeaderComponent,
        ...props.data.map((item) =>
          React.createElement("div", { key: props.keyExtractor(item) }, props.renderItem({ item })),
        ),
        props.ListFooterComponent,
      ),
  };
});

vi.mock("../components/ui/button", async () => {
  const React = await import("react");
  return {
    Button: (props: {
      readonly "aria-label"?: string;
      readonly children?: ReactNode;
      readonly onClick?: () => void;
    }) => {
      if (props["aria-label"] && props.onClick) {
        harness.controls.set(props["aria-label"], props.onClick);
      }
      return React.createElement("button", { "aria-label": props["aria-label"] }, props.children);
    },
  };
});

vi.mock("../components/ui/tooltip", async () => {
  const React = await import("react");
  return {
    Tooltip: ({ children }: { readonly children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    TooltipPopup: ({ children }: { readonly children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    TooltipTrigger: ({ render }: { readonly render: ReactNode }) => render,
  };
});

vi.mock("../components/ui/sidebar", async () => {
  const React = await import("react");
  return {
    SidebarInset: ({ children }: { readonly children?: ReactNode }) =>
      React.createElement("div", null, children),
  };
});

vi.mock("../voice/useVoiceSessionController", () => ({
  isVoiceCapabilityUnavailable: () => false,
  useVoiceSessionController: () => ({
    canEnableBrowserFallback: false,
    canTurnMicOn: true,
    captureMode: "local-audio",
    enableBrowserFallback: vi.fn(),
    enabled: true,
    listenerState: "awake",
    liveTranscript: "",
    micOff: harness.micOff,
    micOn: vi.fn(),
    sleeping: false,
    sleep: vi.fn(),
    statusText: "Listening",
    unlock: vi.fn(),
    unavailableReason: null,
  }),
}));

vi.mock("../composerDraftStore", async () => {
  const actual =
    await vi.importActual<typeof import("../composerDraftStore")>("../composerDraftStore");
  const draft = {
    prompt: "",
    images: [],
    terminalContexts: [],
    elementContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    nonPersistedImageIds: [],
    activeProvider: null,
    modelSelection: null,
    runtimeMode: null,
    interactionMode: null,
  };
  const functions = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const store = new Proxy(
    {
      draftThreadsByThreadKey: {},
      getComposerDraft: () => draft,
      getDraftSession: () => null,
      getDraftSessionByRef: () => null,
      getDraftThreadByRef: () => null,
      getDraftSessionByLogicalProjectKey: () => null,
      hasDraftThreadsInEnvironment: () => false,
    },
    {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        const existing = functions.get(property);
        if (existing) return existing;
        const fn = vi.fn();
        functions.set(property, fn);
        return fn;
      },
    },
  );
  return {
    ...actual,
    finalizePromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore: (selector: (value: typeof store) => unknown) => selector(store),
    useComposerThreadDraft: () => draft,
    useEffectiveComposerModelState: () => ({
      modelOptions: { codex: ["gpt-5"] },
      selectedModel: "gpt-5",
    }),
  };
});

vi.mock("../promptStashStore", async () => {
  const actual = await vi.importActual<typeof import("../promptStashStore")>("../promptStashStore");
  const store = {
    entries: [],
    enqueue: vi.fn(),
    remove: vi.fn(),
  };
  return {
    ...actual,
    usePromptStashStore: (selector: (value: typeof store) => unknown) => selector(store),
  };
});

vi.mock("../state/entities", () => ({
  useActiveEnvironmentId: () => "env-one",
  useEnvironmentThreadRefs: () => [{ environmentId: "env-one", threadId: "thread-two" }],
  useProject: () => harness.project,
  useProjects: () => [harness.project],
  useServerConfigs: () => new Map([["env-one", harness.environment.serverConfig]]),
  useThread: () => harness.thread,
  useThreadDetail: () => harness.thread,
  useThreadRefs: () => [{ environmentId: "env-one", threadId: "thread-two" }],
  useThreadShell: () => harness.thread,
  useThreadStatus: () => "live",
}));

vi.mock("../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://localhost",
  useEnvironments: () => ({ environments: [harness.environment] }),
  usePrimaryEnvironment: () => harness.environment,
  usePrimaryEnvironmentId: () => "env-one",
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { snapshot: { _tag: "Some", value: {} } },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../state/shell", () => ({
  environmentShell: { stateAtom: () => ({}) },
  environmentSnapshotAtom: {},
  shellEnvironment: new Proxy({}, { get: () => ({}) }),
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: new Proxy({}, { get: () => ({}) }),
  useEnvironmentThread: () => ({ page: { _tag: "None" } }),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: undefined })),
}));

vi.mock("@effect/atom-react", async () => {
  const actual = await vi.importActual<typeof import("@effect/atom-react")>("@effect/atom-react");
  return {
    ...actual,
    useAtomValue: () => ({
      environment: { serverVersion: "test", capabilities: { pullRequests: false } },
      newWorktreesStartFromOrigin: false,
      shortcuts: {},
      theme: "system",
    }),
  };
});

vi.mock("../hooks/useSettings", () => {
  const settings = {
    customModels: {},
    disabledProviders: [],
    hiddenModels: {},
    modelOptions: {},
    planModeEnabled: false,
    providers: {},
    providerInstances: {},
    sidebarAutoSettleAfterDays: 0,
    timestampFormat: "locale",
  };
  return {
    useClientSettings: (selector: (value: typeof settings) => unknown) => selector(settings),
    useClientSettingsHydrated: () => true,
    useEnvironmentIdentificationMode: () => "pill",
    useEnvironmentSettings: () => settings,
  };
});

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

vi.mock("../hooks/useNowMinute", () => ({
  useNowMinute: () => Date.now(),
}));

vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: [],
    inferredCheckpointTurnCountByTurnId: new Map(),
  }),
}));

vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => vi.fn(),
}));

vi.mock("../hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initialValue: unknown) => [initialValue, vi.fn()],
}));

vi.mock("../lib/composerPathSearchState", () => ({
  useComposerPathSearch: () => ({ entries: [], isLoading: false }),
}));

vi.mock("../uiStateStore", () => {
  const store = { markThreadVisited: vi.fn(), threadLastVisitedAtById: {} };
  return { useUiStateStore: (selector: (value: typeof store) => unknown) => selector(store) };
});

vi.mock("../terminalUiStateStore", async () => {
  const actual =
    await vi.importActual<typeof import("../terminalUiStateStore")>("../terminalUiStateStore");
  const functions = new Proxy(
    { terminalUiStateByThreadKey: {} },
    {
      get: (target, property) =>
        property in target ? target[property as keyof typeof target] : vi.fn(),
    },
  );
  return {
    ...actual,
    useTerminalUiStateStore: (selector: (value: typeof functions) => unknown) =>
      selector(functions),
  };
});

vi.mock("../rightPanelStore", async () => {
  const actual = await vi.importActual<typeof import("../rightPanelStore")>("../rightPanelStore");
  const store = {
    byThreadKey: {},
    activeSurfaceIdByThreadKey: {},
    rightPanelStateByThreadKey: {},
    surfacesByThreadKey: {},
  };
  return {
    ...actual,
    useRightPanelStore: (selector: (value: typeof store) => unknown) => selector(store),
  };
});

vi.mock("../previewStateStore", async () => {
  const actual =
    await vi.importActual<typeof import("../previewStateStore")>("../previewStateStore");
  return { ...actual, useThreadPreviewState: () => ({ sessions: [] }) };
});

vi.mock("../previewMiniPlayerStore", async () => {
  const actual = await vi.importActual<typeof import("../previewMiniPlayerStore")>(
    "../previewMiniPlayerStore",
  );
  return {
    ...actual,
    usePreviewMiniPlayerStore: (selector: (value: object) => unknown) =>
      selector({ byThreadKey: {} }),
  };
});

vi.mock("../diffPanelStore", () => ({
  useDiffPanelStore: (selector: (value: object) => unknown) => selector({}),
}));

vi.mock("../browserHistoryStore", () => ({
  useBrowserHistoryStore: (selector: (value: object) => unknown) => selector({}),
}));

vi.mock("../state/terminalSessions", () => ({
  useKnownTerminalSessions: () => [],
  useThreadRunningTerminalIds: () => [],
}));

vi.mock("../components/DiffWorkerPoolProvider", async () => {
  const React = await import("react");
  return {
    DiffWorkerPoolProvider: ({ children }: { readonly children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("../components/BranchToolbar", () => ({ BranchToolbar: () => null }));
vi.mock("../components/chat/ChatHeader", () => ({ ChatHeader: () => null }));
vi.mock("../components/RightPanelTabs", () => ({ RightPanelTabs: () => null }));
vi.mock("../components/ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("../components/chat/DraftHeroHeadline", () => ({ DraftHeroHeadline: () => null }));
vi.mock("../components/chat/PanelLayoutControls", () => ({
  PanelLayoutControls: () => null,
  RightPanelMaximizeControl: () => null,
}));
vi.mock("../components/preview/ThreadPreviewMiniPlayer", () => ({
  ThreadPreviewMiniPlayer: () => null,
}));

vi.mock("../assets/assetUrls", () => ({ useAssetUrls: () => [] }));

import { getRouter } from "../router";

function createHarness(history: RouterHistory) {
  const router = getRouter(history);
  Object.assign(router.routeTree.options, {
    beforeLoad: () => ({ authGateState: { status: "hosted-static" } }),
    component: Outlet,
  });
  Object.assign(router.routesById["/_chat"]?.options ?? {}, {
    beforeLoad: () => undefined,
    component: Outlet,
  });

  return {
    router,
    render: () => {
      const matchId = router.state.matches.at(-1)?.id;
      return matchId
        ? renderToStaticMarkup(
            <RouterContextProvider router={router}>
              <Match matchId={matchId} />
            </RouterContextProvider>,
          )
        : "";
    },
  };
}

async function loadForStaticRender(app: ReturnType<typeof createHarness>) {
  await app.router.load();
}

function expectConversation(html: string, surface: "text" | "voice") {
  if (surface === "voice") {
    expect(html).toContain('aria-label="Return to text conversation"');
  } else {
    expect(html).toContain("Keep this history");
    expect(html).toContain("History retained");
    expect(html).toContain('aria-label="Open voice conversation"');
  }
}

async function openVoice(
  controlLabel: "Return to text conversation" | "End voice and return to text conversation",
) {
  harness.controls.clear();
  harness.micOff.mockClear();
  const history = createMemoryHistory({
    initialEntries: ["/env-one/thread-two"],
  });
  const app = createHarness(history);
  await loadForStaticRender(app);

  expectConversation(app.render(), "text");
  expect(app.router.state.matches.at(-1)?.params).toMatchObject({
    environmentId: "env-one",
    threadId: "thread-two",
  });
  harness.controls.get("Open voice conversation")?.();
  await vi.waitFor(() => {
    expect(app.router.state.location.pathname).toBe("/voice/env-one/thread-two");
  });
  await loadForStaticRender(app);

  expectConversation(app.render(), "voice");
  expect(app.router.state.matches.at(-1)?.params).toMatchObject({
    environmentId: "env-one",
    threadId: "thread-two",
  });
  harness.controls.get(controlLabel)?.();
  await vi.waitFor(() => {
    expect(app.router.state.location.pathname).toBe("/env-one/thread-two");
  });
  await loadForStaticRender(app);

  return { app, html: app.render() };
}

describe("voice thread navigation", () => {
  it.each(["Return to text conversation", "End voice and return to text conversation"] as const)(
    "%s preserves the routed thread and rendered history",
    async (controlLabel) => {
      const { app, html } = await openVoice(controlLabel);

      expect(harness.micOff).toHaveBeenCalledOnce();
      expect(app.router.state.matches.at(-1)?.params).toMatchObject({
        environmentId: "env-one",
        threadId: "thread-two",
      });
      expectConversation(html, "text");
    },
  );
});
