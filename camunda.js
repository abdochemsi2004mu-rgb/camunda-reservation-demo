// camunda.js
// ---------------------------------------------------------------------------
// Shared Camunda client + deployment helper.
//
// Why this client?
// Camunda 8.10 recommends the Orchestration Cluster API for new Node.js apps.
// The package is @camunda8/orchestration-cluster-api and it speaks REST (HTTP)
// to the Orchestration Cluster API. Camunda 8 Run exposes that API at:
//
//     http://localhost:8080/v2
//
// The old gRPC endpoint (localhost:26500) still exists, but gRPC is only needed
// when you specifically want gRPC job streaming. The REST client also supports
// polling job workers, so we use REST for everything in this demo.
//
// Auth:
// Camunda 8 Run exposes the REST API WITHOUT authentication by default. The
// demo/demo login you use in Operate/Tasklist is the UI login, not an API
// credential. If you later enable auth in Camunda 8 Run, set the environment
// variables documented in README.md (BASIC or OAUTH) before starting this app.
// ---------------------------------------------------------------------------

import path from "node:path";
import { fileURLToPath } from "node:url";
import createCamundaClient from "@camunda8/orchestration-cluster-api";

// ESM does not define __dirname, so recreate it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Zero-config constructor:
// - reads CAMUNDA_* environment variables when present
// - otherwise defaults to Camunda 8 Run at http://localhost:8080/v2
// - defaults to CAMUNDA_AUTH_STRATEGY=NONE
export const camunda = createCamundaClient();

// The BPMN process id is defined in reservation.bpmn:
//   <bpmn:process id="reservation" ...>
// Starting by processDefinitionId always starts the latest deployed version.
export const PROCESS_ID = "reservation";

/**
 * Deploy reservation.bpmn and its linked staff-decision.form to the local
 * Camunda 8 Run cluster.
 *
 * Native Camunda user tasks link a Camunda Form with zeebe:formDefinition
 * formId="...". The form is a separate .form resource, so it must be deployed
 * together with the BPMN. Deployment creates a new version each time it runs;
 * existing instances keep their old version, new instances use the newest one.
 */
export async function deployReservation() {
  const bpmnPath = path.join(__dirname, "reservation.bpmn");
  const formPath = path.join(__dirname, "staff-decision.form");

  const deployment = await camunda.deployResourcesFromFiles([
    bpmnPath,
    formPath,
  ]);

  const process = deployment.processes.find(
    (candidate) => candidate.processDefinitionId === PROCESS_ID
  );

  if (!process) {
    throw new Error(
      `Deployment succeeded, but process "${PROCESS_ID}" was not found in it.`
    );
  }

  const form = deployment.forms?.find(
    (candidate) => candidate.formId === "Form_StaffDecision"
  );

  console.log(
    `[deploy] ${process.processDefinitionId} v${process.processDefinitionVersion} ` +
      `(definition key ${process.processDefinitionKey})` +
      (form ? ` + form ${form.formId} v${form.version}` : "")
  );

  return process;
}
