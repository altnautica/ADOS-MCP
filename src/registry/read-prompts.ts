// The prompt catalog: reusable, plane-agnostic templates an AI client surfaces
// as slash commands. Each renders to a user message that directs the client to
// the right read (and, for tuning, read-then-confirm) tools. Prompts never act;
// they guide, and the gate still governs every tool the client then calls.

import type { PromptDefinition, PromptMessage } from "./types.js";
import type { PromptRegistry } from "./prompts.js";

function user(text: string): PromptMessage {
  return { role: "user", content: { type: "text", text } };
}

const NODE_ARG = { name: "node", description: "The device id (or host) to target.", required: true };

export function registerReadPrompts(reg: PromptRegistry): void {
  const defs: PromptDefinition[] = [
    {
      name: "fleet_health",
      title: "Fleet health summary",
      description: "Summarize the health of every node in the fleet and flag anything degraded.",
      arguments: [],
      render: () => ({
        description: "Fleet health summary",
        messages: [
          user(
            "Give me a health summary of my fleet. Call fleet.list_nodes, then for each node read " +
              "status.health and status.system. Flag anything degraded — link, battery, flight-controller " +
              "connection, temperature, disk. Present a short per-node table and call out what needs attention.",
          ),
        ],
      }),
    },
    {
      name: "preflight_brief",
      title: "Pre-flight brief",
      description: "A go/no-go pre-flight brief for one node.",
      arguments: [NODE_ARG],
      render: (a) => ({
        description: `Pre-flight brief for ${a.node ?? "the node"}`,
        messages: [
          user(
            `Pre-flight brief for node ${a.node ?? "(unspecified)"}. Read status.full and telemetry.snapshot. ` +
              "Check battery level, GPS fix and satellite count, arming state, and flight mode. List anything " +
              "that would block a safe flight, and give a clear go / no-go with the reasons. Make no changes.",
          ),
        ],
      }),
    },
    {
      name: "postflight_debrief",
      title: "Post-flight debrief",
      description: "Summarize what happened on a node's most recent flight.",
      arguments: [NODE_ARG],
      render: (a) => ({
        description: `Post-flight debrief for ${a.node ?? "the node"}`,
        messages: [
          user(
            `Post-flight debrief for node ${a.node ?? "(unspecified)"}. Read the recent agent logs (logs.query) ` +
              "and this server's audit trail (audit.query). Summarize what happened, list any warnings or errors, " +
              "and note any configuration or parameter changes. Keep it concise.",
          ),
        ],
      }),
    },
    {
      name: "triage_issue",
      title: "Triage an issue",
      description: "Diagnose a reported symptom on one node without changing anything.",
      arguments: [NODE_ARG, { name: "symptom", description: "What is going wrong.", required: true }],
      render: (a) => ({
        description: `Triage: ${a.symptom ?? "an issue"} on ${a.node ?? "the node"}`,
        messages: [
          user(
            `Triage this issue on node ${a.node ?? "(unspecified)"}: "${a.symptom ?? "(unspecified)"}". ` +
              "Read status.full, status.system, services.list, and the recent logs. Identify the most likely " +
              "cause and the single best next diagnostic step. Do not make any change without confirming first.",
          ),
        ],
      }),
    },
    {
      name: "tune_and_optimize",
      title: "Read parameters and suggest tuning",
      description: "Read a node's flight-controller parameters and recommend tuning (read-only advice).",
      arguments: [NODE_ARG],
      render: (a) => ({
        description: `Tuning review for ${a.node ?? "the node"}`,
        messages: [
          user(
            `Review the flight-controller tuning for node ${a.node ?? "(unspecified)"}. Read all parameters ` +
              "(params.read_all) with their metadata, and the ones that differ from firmware defaults " +
              "(params.diff_from_default). Suggest concrete tuning improvements and explain each one. Do NOT " +
              "write any parameter — recommend only, and let the operator apply changes with explicit confirmation.",
          ),
        ],
      }),
    },
  ];
  for (const def of defs) reg.register(def);
}
