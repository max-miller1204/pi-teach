/** Explicit local service controls. */
import { control, ensureService, serviceStatus } from "../src/service-client.ts";
const action = process.argv[2];
if (action === "start") console.log(JSON.stringify(await ensureService(), null, 2));
else if (action === "status") console.log(JSON.stringify(await serviceStatus(), null, 2));
else if (action === "stop") {
  const status = await serviceStatus();
  console.log(JSON.stringify(status.running ? await control("/stop", {}) : status, null, 2));
} else throw new Error("Usage: node scripts/classroom-service.ts <start|status|stop>");
