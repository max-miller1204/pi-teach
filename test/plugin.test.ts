/**
 * The Claude Code and Codex plugin manifests. They are JSON that no compiler checks, so
 * these tests catch a renamed entry point or a version that drifted from package.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import { MAX_WAIT_SECONDS } from "../src/mcp.ts";
import { packageRoot } from "../src/paths.ts";

const readJson = (relative: string) =>
  JSON.parse(fs.readFileSync(path.join(packageRoot(), relative), "utf8")) as Record<string, any>;

const pkg = readJson("package.json");

describe("Claude Code plugin", () => {
  const manifest = readJson(".claude-plugin/plugin.json");

  it("runs the MCP launcher from the plugin root", () => {
    expect(manifest["mcpServers"].classroom.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp/launch.mjs"]);
    expect(fs.existsSync(path.join(packageRoot(), "mcp/launch.mjs"))).toBe(true);
  });

  it("lets the longest wait_for_learner call finish", () => {
    expect(manifest["mcpServers"].classroom.timeout).toBeGreaterThan(MAX_WAIT_SECONDS * 1000);
  });

  it("is listed by the marketplace at the repository root", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(marketplace["plugins"]).toEqual([
      expect.objectContaining({ name: manifest["name"], source: "./" }),
    ]);
  });
});

describe("Codex plugin", () => {
  const manifest = readJson(".codex-plugin/plugin.json");

  it("matches the package version", () => {
    expect(manifest["version"]).toBe(pkg["version"]);
  });

  it("runs the MCP launcher and forwards the classroom settings", () => {
    const mcp = readJson(manifest["mcpServers"]);
    expect(mcp["mcpServers"].classroom).toMatchObject({
      args: ["./mcp/launch.mjs"],
      cwd: ".",
      env_vars: ["PI_CLASSROOMS_DIR", "PI_CLASSROOM_AUTO_OPEN"],
    });
  });

  it("lets the longest wait_for_learner call finish", () => {
    const mcp = readJson(manifest["mcpServers"]);
    expect(mcp["mcpServers"].classroom.tool_timeout_sec).toBeGreaterThan(MAX_WAIT_SECONDS);
  });

  it("is listed by the marketplace at the repository root", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json");
    expect(marketplace["plugins"]).toEqual([
      expect.objectContaining({ name: manifest["name"], source: { source: "local", path: "./" } }),
    ]);
  });
});

describe("skills", () => {
  it.each(["teach", "classroom"])("%s names only tools the MCP server lists", (skill) => {
    const body = fs.readFileSync(path.join(packageRoot(), "skills", skill, "SKILL.md"), "utf8");
    expect(body).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\n---\\n`));
    const tools = [...body.matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1])
      .filter((t) => t.includes("_"));
    const known = [
      "answer_lesson_question",
      "begin_teaching",
      "grade_lesson_quiz",
      "lesson_health",
      "list_classrooms",
      "open_classroom",
      "scaffold_classroom",
      "scaffold_lesson",
      "scaffold_review",
      "wait_for_learner",
    ];
    for (const tool of tools) expect(known).toContain(tool);
  });
});
