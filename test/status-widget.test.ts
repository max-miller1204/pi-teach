import { describe, it, expect, afterEach, beforeEach } from "vitest";

import * as server from "../src/server.js";
import {
  WIDGET_KEY,
  attachStatusWidget,
  detachStatusWidget,
  refreshStatusWidget,
  statusWidgetLines,
  type WidgetHost,
} from "../src/status-widget.js";
import { makeFixture, seedClassroom, type Fixture } from "./helpers.js";

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

describe("statusWidgetLines", () => {
  it("names the port, which is what tells two sessions apart", () => {
    expect(statusWidgetLines(4098)).toEqual(["📚 classroom server running on port 4098"]);
  });

  it("shows nothing when no server is running", () => {
    expect(statusWidgetLines(null)).toBeUndefined();
  });

  it("colours through the session's theme when there is one", () => {
    const lines = statusWidgetLines(4098, { fg: (color, text) => `<${color}>${text}</${color}>` })!;
    expect(lines[0]).toContain("<accent>📚 classroom</accent>");
    expect(lines[0]).toContain("<dim>server running on port</dim>");
    expect(lines[0]).toContain("<accent>4098</accent>");
  });
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
    // The port is read from the server, so an ephemeral-port fallback still reads true.
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
