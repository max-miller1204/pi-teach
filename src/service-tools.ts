/** Shared service tool schemas. MCP discovery does not start the service. */
import type { ClassroomTool } from "./tools.ts";
export const serviceToolDefinitions: Array<Omit<ClassroomTool, "execute">> = [
  {
    name: "classroom_service",
    label: "Classroom Service",
    description:
      "Start, inspect, or explicitly stop the persistent classroom service. Status includes the tailnet route. Stop removes that route and affects every classroom it owns.",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["start", "status", "stop"] } },
      required: ["action"],
    },
  },
];
