// server.js
// ---------------------------------------------------------------------------
// One Express server that:
//   1. verifies it can reach the Camunda Orchestration Cluster API
//   2. deploys reservation.bpmn
//   3. starts one REST job worker per service task
//   4. exposes POST /reserve to start a process instance
//   5. exposes GET /reservation/:key so the browser can follow the process
//   6. serves the static form in public/index.html
//
// No database and no auth: everything the process needs lives in process
// variables inside Camunda.
// ---------------------------------------------------------------------------

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { camunda, deployReservation, PROCESS_ID } from "./camunda.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);

const app = express();

// Parse JSON request bodies. The browser form uses fetch() + JSON.
app.use(express.json());

// Serve index.html and any other static assets from public/.
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// POST /reserve
// Body: { name: string, date: "YYYY-MM-DD", partySize: number }
//
// Starting a process instance is the "entry point" into Camunda. The variables
// object becomes the process variables available to every task in the process.
//
// We return the process instance key immediately. The process itself keeps
// running asynchronously in Camunda (and may wait for a human in Tasklist).
// ---------------------------------------------------------------------------
app.post("/reserve", async (request, response) => {
  try {
    const { name, date, partySize } = request.body ?? {};

    // Minimal validation so the demo gives useful feedback instead of a
    // Camunda incident caused by a missing variable.
    if (typeof name !== "string" || name.trim() === "") {
      return response.status(400).json({ error: "Please enter a name." });
    }

    if (typeof date !== "string" || date.trim() === "") {
      return response.status(400).json({ error: "Please choose a date." });
    }

    const parsedPartySize = Number(partySize);
    if (!Number.isInteger(parsedPartySize) || parsedPartySize < 1) {
      return response
        .status(400)
        .json({ error: "Party size must be a whole number of 1 or more." });
    }

    // createProcessInstance starts the latest deployed version of "reservation".
    // These three variables are exactly what the form collected.
    const instance = await camunda.createProcessInstance({
      processDefinitionId: PROCESS_ID,
      variables: {
        name: name.trim(),
        date: date.trim(),
        partySize: parsedPartySize,
      },
    });

    const processInstanceKey = String(instance.processInstanceKey);

    console.log(
      `[api] Started ${PROCESS_ID} for ${name.trim()} ` +
        `(party of ${parsedPartySize}) -> process instance ${processInstanceKey}`
    );

    // 201 Created is a good fit: a new process instance now exists.
    return response.status(201).json({ processInstanceKey });
  } catch (error) {
    console.error("[api] Could not start process instance:", error.message);
    return response.status(500).json({
      error:
        "Could not start the process. Is Camunda 8 Run running? " +
        "Check http://localhost:8080/v2/topology",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /reservation/:key
//
// Derives a customer-friendly status from the process instance state, its
// variables, and the element instance that is currently active.
//
// Response:
//   {
//     status: "pending-availability" | "awaiting-staff" | "confirmed" | "denied",
//     reason: string,
//     name: string,
//     date: string,
//     partySize: number
//   }
// ---------------------------------------------------------------------------

function parseVariableValue(value) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    // If Camunda ever returns a non-JSON value, keep the raw string.
    return value;
  }
}

function deriveReservationStatus({ state, variables, activeElementId }) {
  // The final workers always write "status" before the process ends.
  // The timeout path (Record timeout script task) also sets status="denied".
  if (variables.status === "confirmed" || variables.status === "denied") {
    return variables.status;
  }

  // Fallbacks for completed/terminated instances, e.g. older process versions.
  if (state === "COMPLETED") {
    return variables.available === false ? "denied" : "confirmed";
  }

  if (state === "TERMINATED") {
    return "denied";
  }

  if (variables.available === false) {
    return "denied";
  }

  // Once the availability worker has accepted the party, the instance is
  // either moving to the staff task or already waiting there.
  if (
    activeElementId === "Activity_StaffConfirms" ||
    activeElementId === "Gateway_StaffApproved" ||
    activeElementId === "Activity_SendConfirmation" ||
    activeElementId === "Activity_RecordStaffDenial"
  ) {
    return "awaiting-staff";
  }

  if (variables.approved !== undefined || variables.available === true) {
    return "awaiting-staff";
  }

  return "pending-availability";
}

app.get("/reservation/:key", async (request, response) => {
  const processInstanceKey = String(request.params.key ?? "").trim();

  if (processInstanceKey === "") {
    return response
      .status(400)
      .json({ error: "Missing process instance key." });
  }

  try {
    // Wait briefly for eventual consistency so the first poll after POST
    // /reserve can already see the instance.
    const instance = await camunda.getProcessInstance(
      { processInstanceKey },
      { consistency: { waitUpToMs: 2000, pollIntervalMs: 250 } }
    );

    const requiredVariableNames = ["name", "date", "partySize"];
    if (instance.state !== "ACTIVE") {
      // A finished instance must have its final status written.
      requiredVariableNames.push("status");
    }

    const variablesResult = await camunda.searchVariables(
      {
        filter: { processInstanceKey },
        page: { limit: 100 },
      },
      {
        consistency: {
          waitUpToMs: 2000,
          pollIntervalMs: 250,
          predicate: (result) => {
            const names = new Set(
              (result.items ?? []).map((item) => item.name)
            );
            return requiredVariableNames.every((name) => names.has(name));
          },
        },
      }
    );

    const elementsResult = await camunda.searchElementInstances(
      {
        filter: { processInstanceKey, state: "ACTIVE" },
        page: { limit: 50 },
      },
      { consistency: { waitUpToMs: 0 } }
    );

    const variables = {};
    for (const item of variablesResult.items ?? []) {
      variables[item.name] = parseVariableValue(item.value);
    }

    const activeElement = (elementsResult.items ?? []).find(
      (item) =>
        item.state === "ACTIVE" &&
        item.type !== "SEQUENCE_FLOW" &&
        item.type !== "PROCESS"
    );

    const status = deriveReservationStatus({
      state: instance.state,
      variables,
      activeElementId: activeElement?.elementId ?? null,
    });

    return response.json({
      status,
      reason: typeof variables.reason === "string" ? variables.reason : "",
      name: typeof variables.name === "string" ? variables.name : "",
      date: typeof variables.date === "string" ? variables.date : "",
      partySize: Number(variables.partySize) || 0,
    });
  } catch (error) {
    const isNotFound =
      error?.status === 404 ||
      error?.title === "NOT_FOUND" ||
      /not found/i.test(error?.message ?? "");

    if (isNotFound) {
      return response.status(404).json({ error: "Reservation not found." });
    }

    console.error(
      `[api] Could not read reservation ${processInstanceKey}:`,
      error.message
    );

    return response.status(503).json({
      error:
        "Could not read the reservation. Is the demo server still connected " +
        "to Camunda 8 Run?",
    });
  }
});

// ---------------------------------------------------------------------------
// Job worker: check-availability
//
// A service task in BPMN is a job with a "type". A worker subscribes to that
// type, receives jobs, does the work, and completes them with new variables.
//
// The gateway after this task reads the boolean variable "available". Both
// "available" and "reason" are always written so the customer-facing status
// endpoint has a useful explanation on every path.
// ---------------------------------------------------------------------------
function startCheckAvailabilityWorker() {
  camunda.createJobWorker({
    jobType: "check-availability",
    workerName: "reservation-check-availability",
    maxParallelJobs: 10,
    jobTimeoutMs: 30_000,
    pollIntervalMs: 500,
    jobHandler: async (job) => {
      const { name, partySize } = job.variables;

      // Business rule for the demo: groups larger than 10 are not accepted.
      const available = !(Number(partySize) > 10);
      const reason = available
        ? ""
        : "Party size exceeds the maximum of 10";

      console.log(
        `[check-availability] ${name ?? "guest"} / party of ${partySize} -> ` +
          `available=${available}` +
          (reason ? ` (${reason})` : "")
      );

      // Completing a job writes variables back into the process.
      // The exclusive gateway evaluates "= available = true" on this value.
      const variables = { available, reason };
      if (!available) {
        // This path ends immediately, so "denied" is final.
        variables.status = "denied";
      }

      return job.complete(variables);
    },
  });

  console.log("[worker] Listening for job type: check-availability");
}

// ---------------------------------------------------------------------------
// Job worker: send-confirmation
//
// This task only runs when "available" was true and staff approved the
// reservation. It sets the final confirmed status and reason.
// ---------------------------------------------------------------------------
function startSendConfirmationWorker() {
  camunda.createJobWorker({
    jobType: "send-confirmation",
    workerName: "reservation-send-confirmation",
    maxParallelJobs: 10,
    jobTimeoutMs: 30_000,
    pollIntervalMs: 500,
    jobHandler: async (job) => {
      const { name, date, partySize } = job.variables;

      console.log(
        `[send-confirmation] Reservation confirmed for ${name} on ${date} ` +
          `(party of ${partySize}, process instance ${
            job.processInstanceKey ?? "unknown"
          })`
      );

      return job.complete({
        status: "confirmed",
        reason: "Reservation confirmed",
      });
    },
  });

  console.log("[worker] Listening for job type: send-confirmation");
}

// ---------------------------------------------------------------------------
// Job worker: record-staff-denial
//
// Staff declined the reservation in Tasklist. The linked form wrote
// "approved = false" and optionally "reason". This worker persists the final
// denied status and a fallback reason when the staff member left the field
// empty.
// ---------------------------------------------------------------------------
function startRecordStaffDenialWorker() {
  camunda.createJobWorker({
    jobType: "record-staff-denial",
    workerName: "reservation-record-staff-denial",
    maxParallelJobs: 10,
    jobTimeoutMs: 30_000,
    pollIntervalMs: 500,
    jobHandler: async (job) => {
      const { name, reason } = job.variables;

      const declineReason =
        typeof reason === "string" && reason.trim() !== ""
          ? reason.trim()
          : "Declined by staff";

      console.log(
        `[record-staff-denial] Reservation declined for ${name ?? "guest"} ` +
          `(reason: ${declineReason})`
      );

      return job.complete({
        status: "denied",
        reason: declineReason,
      });
    },
  });

  console.log("[worker] Listening for job type: record-staff-denial");
}

// ---------------------------------------------------------------------------
// Job worker: record-timeout
//
// The timer boundary event fires when staff does not respond within 2 minutes.
// This worker persists the final denied status and a standard reason.
// ---------------------------------------------------------------------------
function startRecordTimeoutWorker() {
  camunda.createJobWorker({
    jobType: "record-timeout",
    workerName: "reservation-record-timeout",
    maxParallelJobs: 10,
    jobTimeoutMs: 30_000,
    pollIntervalMs: 500,
    jobHandler: async (job) => {
      const { name } = job.variables;

      console.log(
        `[record-timeout] Reservation timed out for ${name ?? "guest"}`
      );

      return job.complete({
        status: "denied",
        reason: "No staff response within 2 minutes",
      });
    },
  });

  console.log("[worker] Listening for job type: record-timeout");
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function main() {
  // Fail fast with a clear message if Camunda is not reachable. This also
  // proves that the REST API (not gRPC) is what we are talking to.
  const topology = await camunda.getTopology();
  console.log(
    `[camunda] Connected to ${topology.brokers?.length ?? 0} broker(s) via REST`
  );

  // Deploy before starting/using workers so the process definition exists.
  await deployReservation();

  // Start all workers inside this same Node.js process.
  startCheckAvailabilityWorker();
  startSendConfirmationWorker();
  startRecordStaffDenialWorker();
  startRecordTimeoutWorker();

  const server = app.listen(PORT, () => {
    console.log(`[web] Reservation demo: http://localhost:${PORT}`);
    console.log("[web] Operate:  http://localhost:8080/operate  (demo/demo)");
    console.log("[web] Tasklist: http://localhost:8080/tasklist (demo/demo)");
  });

  // Stop polling workers cleanly when the server is stopped with Ctrl+C.
  async function shutdown(signal) {
    console.log(`\n[server] ${signal} received, stopping workers...`);
    camunda.stopAllWorkers();
    server.close(() => process.exit(0));
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // "fetch failed" usually means Camunda is not running or the REST address is
  // wrong. Print the address and the underlying cause to make that obvious.
  const restAddress =
    process.env.CAMUNDA_REST_ADDRESS ?? "http://localhost:8080/v2";

  console.error("[startup] Failed:", error.message);
  console.error("[startup] REST address:", restAddress);
  if (error.cause) {
    console.error("[startup] Cause:", error.cause.message ?? error.cause);
  }
  console.error(
    "[startup] Start Camunda 8 Run first and verify " +
      "http://localhost:8080/v2/topology in your browser."
  );
  process.exit(1);
});
