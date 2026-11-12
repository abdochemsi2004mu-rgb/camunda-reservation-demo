// deploy.js
// ---------------------------------------------------------------------------
// Standalone deployment script: npm run deploy
//
// The server also deploys automatically on startup. This script exists so you
// can deploy a changed BPMN file without restarting the workers.
// ---------------------------------------------------------------------------

import { deployReservation } from "./camunda.js";

try {
  await deployReservation();
  console.log("[deploy] Done. Open Operate at http://localhost:8080/operate");
  process.exit(0);
} catch (error) {
  console.error("[deploy] Failed:", error.message);
  console.error(
    "[deploy] Is Camunda 8 Run running? Check http://localhost:8080/v2/topology"
  );
  process.exit(1);
}
