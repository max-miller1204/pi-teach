import { describe, expect, it } from "vitest";
import { packagedPageChecks } from "../scripts/harness.ts";

const command = 'node "/plugin/scripts/check-lesson.ts" os 002-forks';
const receipt = {
  classroom: "os",
  lesson: "002-forks",
  learnerStateChanged: false,
  initial: { quizzes: 1, contractErrors: 0, pageErrors: 0 },
  released: { quizzes: 2, contractErrors: 0, pageErrors: 0 },
};
function codex(output: unknown = receipt, executed = command, exit_code = 0): string {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      command: executed,
      exit_code,
      aggregated_output: JSON.stringify(output),
    },
  });
}

describe("packaged authoring check receipts", () => {
  it("accepts a successful Codex execution", () => {
    expect(packagedPageChecks("codex", codex())).toEqual([
      { classroom: "os", lesson: "002-forks" },
    ]);
  });
  it("matches Claude results to the script execution", () => {
    const events = [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "check", name: "Bash", input: { command } }] },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "other", content: JSON.stringify(receipt) },
            {
              type: "tool_result",
              tool_use_id: "check",
              content: [{ type: "text", text: JSON.stringify(receipt) }],
            },
          ],
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(packagedPageChecks("claude", events)).toHaveLength(1);
  });
  it("does not count reading the checker as execution", () => {
    expect(
      packagedPageChecks("codex", codex(receipt, "cat /plugin/scripts/check-lesson.ts")),
    ).toEqual([]);
  });
  it("rejects a failed process even with a receipt", () => {
    expect(packagedPageChecks("codex", codex(receipt, command, 1))).toEqual([]);
  });
  it.each([
    { ...receipt, learnerStateChanged: true },
    { ...receipt, initial: { ...receipt.initial, contractErrors: 1 } },
    { ...receipt, released: { ...receipt.released, pageErrors: 1 } },
    { ...receipt, released: undefined },
  ])("rejects incomplete or unsafe checks", (invalid) => {
    expect(packagedPageChecks("codex", codex(invalid))).toEqual([]);
  });
});
