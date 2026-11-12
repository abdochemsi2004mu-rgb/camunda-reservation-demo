# Drawing the process in Camunda Modeler

This guide shows how `reservation.bpmn` and `staff-decision.form` were drawn in Camunda Modeler. Follow it to recreate them from scratch or to understand what each part does.

Menu and panel labels can differ slightly between Modeler versions. The project files were made with Modeler 5.39 for Camunda 8.10.

## BPMN in 30 seconds

| Symbol | Name | Meaning |
| --- | --- | --- |
| Thin circle | Start event | Where the process begins |
| Thick circle | End event | Where a path finishes |
| Rounded box | Task | A unit of work |
| Diamond with X | Exclusive gateway | A decision: exactly one path is taken |
| Arrow | Sequence flow | The order of steps |

The process in this project:

```
Reservation requested → Check availability → Available?
   yes → Staff confirms → Approved?
            yes → Send confirmation → Confirmed
            no  → Record staff denial → Rejected by staff
   no  → Rejected
```

## 1. Create the diagram

1. Open Camunda Modeler.
2. Choose **File → New File → BPMN diagram (Camunda 8)**.
3. Click an empty area of the canvas and open the **properties panel** on the right.
4. Set the process **Name** to `Reservation` and the **ID** to `reservation`.

The code starts the process by this ID, so it must be exactly `reservation`.

## 2. Draw the elements

Use the palette on the left, or click an element and use the small arrows that appear to add the next one.

1. A **start event** is already on the canvas. Name it `Reservation requested`.
2. Add a **task**, change its type to **Service task** (wrench icon), and name it `Check availability`.
3. Add an **exclusive gateway** and name it `Available?`.
4. Add a **user task** and name it `Staff confirms`.
5. Add a second **exclusive gateway** and name it `Approved?`.
6. Add two more **service tasks**: `Send confirmation` and `Record staff denial`.
7. Add three **end events**: `Confirmed`, `Rejected` and `Rejected by staff`.

Connect them in this order, using the arrow handle that appears when you select an element:

| From | To |
| --- | --- |
| Reservation requested | Check availability |
| Check availability | Available? |
| Available? (yes path) | Staff confirms |
| Available? (no path) | Rejected |
| Staff confirms | Approved? |
| Approved? (yes path) | Send confirmation |
| Approved? (no path) | Record staff denial |
| Send confirmation | Confirmed |
| Record staff denial | Rejected by staff |

Name the paths coming out of each gateway `yes` / `no` so the diagram reads clearly.

## 3. Configure the service tasks

A service task creates a **job** that a worker picks up. The worker finds its jobs by **job type**.

For each service task: select it, open **Implementation** in the properties panel, choose **Job worker**, and set the **Task definition type**.

| Task | Job type |
| --- | --- |
| Check availability | `check-availability` |
| Send confirmation | `send-confirmation` |
| Record staff denial | `record-staff-denial` |

These strings must match the workers in `server.js` exactly.

## 4. Configure the gateways

A gateway decides using a condition written in **FEEL**, Camunda's expression language. A leading `=` marks it as an expression.

**Available?**
1. Select the **yes** path. In the properties panel, open **Condition**, set the type to **Expression**, and enter `= available = true`.
2. Select the **no** path, click the wrench icon, and choose **Default flow**. The default path is used when no condition matches.

**Approved?**
1. Select the **yes** path and set the condition to `= approved = true`.
2. Set the **no** path as the **Default flow**.

The variables `available` and `approved` come from the worker and the staff form.

## 5. Make the staff task a native user task

1. Select **Staff confirms**.
2. In the properties panel, set **Implementation** to **Camunda user task**.

This adds `<zeebe:userTask />` to the file. It is required: Camunda 8.10 only shows native user tasks in Tasklist, and the older job-worker style is deprecated and does not appear.

## 6. Draw the staff form

1. Choose **File → New File → Form (Camunda 8)**.
2. In the properties panel, set the form **ID** to `Form_StaffDecision`.
3. Drag these components onto the form:

| Component | Label | Key | Notes |
| --- | --- | --- | --- |
| Checkbox | Approve reservation? | `approved` | Default value: off |
| Text field | Reason if declined | `reason` | Optional. Under **Condition**, hide it with `=approved = true` |
| Button | Complete task | none | Type: Submit |

4. Save it as `staff-decision.form` in the project folder.

The **key** of each field is the name of the process variable it writes. That is how the gateway can read `approved` after staff submit the form.

## 7. Link the form to the task

1. Open `reservation.bpmn` and select **Staff confirms**.
2. In the **Form** section, choose a linked Camunda Form and set the **Form ID** to `Form_StaffDecision`.
3. Set the binding to **deployment**.

Deployment binding means the form is deployed together with the process. The app does this at startup. Embedded forms do not work with native user tasks in 8.10, so the form must be a separate file.

## 8. Keep these IDs

The status endpoint in `server.js` looks at which element is active. If you change these IDs, change the code too.

| Element | ID |
| --- | --- |
| Check availability | `Activity_CheckAvailability` |
| Available? | `Gateway_Available` |
| Staff confirms | `Activity_StaffConfirms` |
| Approved? | `Gateway_StaffApproved` |
| Send confirmation | `Activity_SendConfirmation` |
| Record staff denial | `Activity_RecordStaffDenial` |

To change an ID, select the element and edit **ID** in the properties panel.

## 9. Save and deploy

Save both files in the project folder. Then use either method:

- **From the app:** run `npm start` or `npm run deploy`. Both deploy the process and the form together. This is the recommended way.
- **From Modeler:** click **Deploy**, choose **Camunda 8 Self-Managed**, set the endpoint to `http://localhost:26500` and authentication to **None**. Include `staff-decision.form` in the deployment.

Each deployment creates a new process **version**. Running instances keep their old version, so start a new reservation to test changes.

## 10. Check it in Operate

1. Open http://localhost:8080/operate and find the **Reservation** process.
2. Start a reservation with party size 4.
3. Open the instance. The diagram shows where the process is, and a badge marks the active step.
4. Open **Staff confirms** in Tasklist at http://localhost:8080/tasklist and complete it. Watch the token move on in Operate.

If the diagram appears in Operate but nothing shows in Tasklist, recheck step 5. That is the most common mistake.
