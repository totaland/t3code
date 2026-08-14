import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { enterVoiceThread, returnToTextThread } from "./voiceThreadRoutes";

const messages = [
  { id: "message-1", role: "user", text: "Keep this history" },
  { id: "message-2", role: "assistant", text: "History retained" },
] as const;

const rootRoute = createRootRoute({ component: Outlet });
const voiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/voice/$environmentId/$threadId",
  component: () => <ConversationSurface route={voiceRoute} surface="voice" />,
});
const textRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$environmentId/$threadId",
  component: () => <ConversationSurface route={textRoute} surface="text" />,
});

function ConversationSurface(props: {
  route: typeof voiceRoute | typeof textRoute;
  surface: "text" | "voice";
}) {
  const params = props.route.useParams();
  return (
    <main
      data-environment-id={params.environmentId}
      data-surface={props.surface}
      data-thread-id={params.threadId}
    >
      {messages.map((message) => (
        <p key={message.id} data-message-id={message.id}>
          {message.text}
        </p>
      ))}
    </main>
  );
}

function createNavigationHarness() {
  const router = createRouter({
    routeTree: rootRoute.addChildren([voiceRoute, textRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    router,
    render: () => renderToStaticMarkup(<RouterProvider router={router} />),
  };
}

describe("voice thread navigation", () => {
  it("renders voice with the exact environment, thread, and history", async () => {
    const harness = createNavigationHarness();
    await harness.router.load();

    await enterVoiceThread(harness.router.navigate, "env-one", "thread-two");

    const html = harness.render();
    expect(html).toContain('data-surface="voice"');
    expect(html).toContain('data-environment-id="env-one"');
    expect(html).toContain('data-thread-id="thread-two"');
    expect(html).toContain("Keep this history");
    expect(html).toContain("History retained");
  });

  it.each(["Return", "End"])(
    "%s renders the same text thread with retained history",
    async () => {
      const harness = createNavigationHarness();
      await harness.router.load();
      await enterVoiceThread(harness.router.navigate, "env-one", "thread-two");

      await returnToTextThread(harness.router.navigate, "env-one", "thread-two");

      const html = harness.render();
      expect(html).toContain('data-surface="text"');
      expect(html).toContain('data-environment-id="env-one"');
      expect(html).toContain('data-thread-id="thread-two"');
      expect(html).toContain("Keep this history");
      expect(html).toContain("History retained");
    },
  );
});
