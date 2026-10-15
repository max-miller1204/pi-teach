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
      "Inspect or remove this service's tailnet-only Serve route, or start it on an explicit HTTPS port. Return a checked complete classroom or lesson URL. open_classroom starts the route automatically while Tailscale is connected.",
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
