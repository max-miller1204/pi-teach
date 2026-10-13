import { describe, it, expect, afterEach, beforeEach } from "vitest";

import * as server from "../src/server.ts";
import {
  WIDGET_KEY,
  attachStatusWidget,
  detachStatusWidget,
  refreshStatusWidget,
  type WidgetHost,
} from "../src/status-widget.ts";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.ts";

interface Call {
  key: string;
  content: string[] | undefined;
  placement?: string;
}

/** A stub `ctx.ui` recording every setWidget call. */
function stubHost(theme?: WidgetHost["theme"]): WidgetHost & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    theme,
    setWidget(key, content, options) {
      calls.push({ key, content, placement: options?.placement });
    },
  };
}

let fixture: Fixture;

beforeEach(() => {
  fixture = makeFixture();
  seedClassroom(fixture);
});

afterEach(async () => {
  detachStatusWidget();
  await server.close();
  fixture.cleanup();
});

describe("the widget's lifecycle", () => {
  it("appears with the live port once the server is up, and clears when it stops", async () => {
    const host = stubHost();

    attachStatusWidget(host);
    expect(host.calls).toEqual([{ key: WIDGET_KEY, content: undefined, placement: "belowEditor" }]);

    await server.start();
    refreshStatusWidget();
    const shown = host.calls.at(-1)!;
    expect(shown.key).toBe(WIDGET_KEY);
    // The port is read from the server, so it stays current after a restart.
    expect(shown.content).toEqual([`📚 classroom server running on port ${server.getPort()}`]);

    await server.close();
    refreshStatusWidget();
    expect(host.calls.at(-1)!.content).toBeUndefined();
  });

  it("clears the widget on shutdown and then stays quiet", () => {
    const host = stubHost();
    attachStatusWidget(host);
    detachStatusWidget();

    expect(host.calls.at(-1)).toEqual({ key: WIDGET_KEY, content: undefined });

    const after = host.calls.length;
    refreshStatusWidget();
    expect(host.calls).toHaveLength(after);
  });

  it("does nothing at all when the session has no UI", () => {
    expect(() => {
      attachStatusWidget(null);
      refreshStatusWidget();
    }).not.toThrow();
  });

  it("survives a UI that does not support widgets", async () => {
    const host: WidgetHost = {
      setWidget() {
        throw new Error("no widgets in this mode");
      },
    };

    attachStatusWidget(host);
    await server.start();
    expect(() => refreshStatusWidget()).not.toThrow();
    expect(server.isRunning()).toBe(true);
  });
});
