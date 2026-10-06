/** Shared service tool schemas. MCP discovery does not start the service. */
import type { ClassroomTool } from "./tools.ts";
export const serviceToolDefinitions: Array<Omit<ClassroomTool, "execute">> = [
  {
    name: "classroom_service",
    label: "Classroom Service",
    description:
      "Start, inspect, or explicitly stop the persistent classroom service. Stop affects every classroom it owns.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["start", "status", "stop"] } },
      required: ["action"],
    },
  },
  {
    name: "classroom_phone",
    label: "Classroom Phone Access",
    description:
      "Opt in to tailnet-only phone access. Return a checked complete classroom or lesson URL. Inspect or remove only this service's Serve route.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "stop"] },
        classroom: { type: "string" },
        lesson: { type: "string" },
        https_port: { type: "integer" },
      },
      required: ["action"],
    },
  },
];
