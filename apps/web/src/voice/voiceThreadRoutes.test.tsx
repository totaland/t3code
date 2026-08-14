import {
  createMemoryHistory,
  Outlet,
  RouterProvider,
  type RouterHistory,
} from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  controls: new Map<string, () => void>(),
  messages: [
    { id: "message-1", role: "user", text: "Keep this history" },
    { id: "message-2", role: "assistant", text: "History retained" },
  ],
  micOff: vi.fn(),
}));

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
      return React.createElement(
        "button",
        { "aria-label": props["aria-label"] },
        props.children,
      );
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

vi.mock("../components/ChatView.logic", () => ({
  threadHasStarted: () => false,
}));

vi.mock("../composerDraftStore", () => {
  const store = {
    getDraftThreadByRef: () => null,
    hasDraftThreadsInEnvironment: () => false,
  };
  return {
    finalizePromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore: (selector: (value: typeof store) => unknown) => selector(store),
  };
});

vi.mock("../state/entities", () => ({
  useEnvironmentThreadRefs: () => [
    { environmentId: "env-one", threadId: "thread-two" },
  ],
  useThreadDetail: () => ({ id: "thread-two" }),
  useThreadShell: () => ({ id: "thread-two" }),
  useThreadStatus: () => "idle",
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { snapshot: { _tag: "Some", value: {} } },
  }),
}));

vi.mock("../state/shell", () => ({
  environmentShell: { stateAtom: () => ({}) },
  environmentSnapshotAtom: {},
}));

vi.mock("../components/ChatView", async () => {
  const React = await import("react");
  const { ComposerVoiceWakePhraseButton } = await import(
    "../components/chat/ComposerVoiceWakePhraseButton"
  );
  const { VoiceChatPage } = await import("../components/voice/VoiceChatPage");
  const { useVoiceThreadTransitions } = await import("./useVoiceThreadTransitions");

  function History(props: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly surface: "text" | "voice";
  }) {
    return React.createElement(
      "section",
      {
        "data-environment-id": props.environmentId,
        "data-surface": props.surface,
        "data-thread-id": props.threadId,
      },
      harness.messages.map((message) =>
        React.createElement("p", { key: message.id }, message.text),
      ),
    );
  }

  return {
    default: (props: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly voiceMode?: boolean;
    }) => {
      const transitions = useVoiceThreadTransitions({
        environmentId: props.environmentId,
        threadId: props.threadId,
        beforeEnterVoice: vi.fn(),
        beforeReturnToText: vi.fn(),
      });
      const history = React.createElement(History, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        surface: props.voiceMode ? "voice" : "text",
      });

      if (props.voiceMode) {
        return React.createElement(
          React.Fragment,
          null,
          history,
          React.createElement(VoiceChatPage, {
            fetchImplementation: vi.fn(async () => Response.json({})),
            httpBaseUrl: "http://localhost",
            messages: harness.messages,
            onCaptureCancelled: vi.fn(),
            onInterrupt: vi.fn(),
            onPlaybackUnlock: vi.fn(),
            onReturnToText: transitions.returnToText,
            onTranscript: vi.fn(),
            phase: "idle",
            projectTitle: "Project",
            threadTitle: "Thread",
          }),
        );
      }

      return React.createElement(
        React.Fragment,
        null,
        history,
        React.createElement(ComposerVoiceWakePhraseButton, {
          onEnterVoice: transitions.enterVoice,
          onPlaybackUnlock: vi.fn(async () => undefined),
        }),
      );
    },
  };
});

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
    render: () => renderToStaticMarkup(createElement(RouterProvider, { router })),
  };
}

function expectConversation(
  html: string,
  surface: "text" | "voice",
) {
  expect(html).toContain(`data-surface="${surface}"`);
  expect(html).toContain('data-environment-id="env-one"');
  expect(html).toContain('data-thread-id="thread-two"');
  expect(html).toContain("Keep this history");
  expect(html).toContain("History retained");
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
  await app.router.load();

  expectConversation(app.render(), "text");
  harness.controls.get("Open voice conversation")?.();
  await vi.waitFor(() => {
    expect(app.router.state.location.pathname).toBe(
      "/voice/env-one/thread-two",
    );
  });
  await app.router.load();

  expectConversation(app.render(), "voice");
  harness.controls.get(controlLabel)?.();
  await vi.waitFor(() => {
    expect(app.router.state.location.pathname).toBe("/env-one/thread-two");
  });
  await app.router.load();

  return app.render();
}

describe("voice thread navigation", () => {
  it.each([
    "Return to text conversation",
    "End voice and return to text conversation",
  ] as const)(
    "%s preserves the routed thread and rendered history",
    async (controlLabel) => {
      const html = await openVoice(controlLabel);

      expect(harness.micOff).toHaveBeenCalledOnce();
      expectConversation(html, "text");
    },
  );
});
