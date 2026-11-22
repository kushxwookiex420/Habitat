/**
 * OpenAPI 3.1 description of the Ax command surface, served at /ax/command/openapi.json.
 *
 * ChatGPT's GPT Actions read this schema; the bearer credential is configured in the ChatGPT UI,
 * never in the document. Constraints from OpenAI's action docs are respected here:
 *   - operation ids are unique, descriptions stay under 300 characters
 *   - no custom headers, no bodies over 100k, no request longer than 45 seconds
 * Because of the 45-second limit there is deliberately no "wait for the result" endpoint: submit
 * returns an id immediately and the caller polls GET /ax/command/tasks/{id}.
 */

const ERROR_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "ok", "code", "error"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    ok: { type: "boolean", const: false },
    code: { type: "string" },
    error: { type: "string" }
  }
};

const errorResponse = description => ({
  description,
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" }
    }
  }
});

export function buildAxOpenApiSpec({ origin = "https://habitat-1-szzd.onrender.com" } = {}) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Habitat — Ax command bridge",
      version: "1.0.0",
      description:
        "Submit objectives to NEXUS, follow their progress with a cursor, and read the evidence they produced. Read-only execution only."
    },
    servers: [{ url: String(origin).replace(/\/+$/, "") }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      },
      schemas: {
        Error: ERROR_SCHEMA,
        SubmitRequest: {
          type: "object",
          required: ["objective", "idempotencyKey"],
          properties: {
            objective: {
              type: "string",
              maxLength: 2000,
              description: "What NEXUS should do, in one sentence. It cannot name a side-effecting adapter."
            },
            role: {
              type: "string",
              enum: ["ax", "atlas", "orion", "sentinel"],
              default: "ax",
              description: "Which role owns the objective. Ax submits as ax."
            },
            adapter: {
              type: "string",
              nullable: true,
              description: "Optional tool name such as runtime.health. Omit to let NEXUS choose; a task with no adapter waits for a human."
            },
            idempotencyKey: {
              type: "string",
              maxLength: 128,
              description: "Unique per objective. Reusing it on a retry returns the original task instead of creating a duplicate."
            }
          }
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string" },
            objective: { type: "string" },
            status: {
              type: "string",
              enum: ["queued", "working", "needs_approval", "done", "failed", "cancelled"]
            },
            role: { type: "string" },
            adapter: { type: "string", nullable: true },
            attempts: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            error: { type: "string", nullable: true },
            result: {
              type: "object",
              nullable: true,
              properties: {
                summary: { type: "string" },
                evidence: { type: "array", items: { type: "string" } }
              }
            },
            history: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string", nullable: true },
                  to: { type: "string" },
                  at: { type: "string", format: "date-time" },
                  by: { type: "string" },
                  reason: { type: "string", nullable: true }
                }
              }
            }
          }
        }
      }
    },
    paths: {
      "/ax/command/messages": {
        post: {
          operationId: "sendNexusMessage",
          summary: "Send a message to NEXUS",
          description:
            "Stores a durable, correlated message for the NEXUS runtime and returns its id. Reusing an idempotencyKey returns the same message. kind=task must name one read-only adapter from the deployment allowlist; the message channel cannot execute arbitrary commands.",
          "x-openai-isConsequential": false,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["kind", "body", "idempotencyKey"],
                  properties: {
                    kind: { type: "string", enum: ["task", "question", "note"] },
                    body: { type: "string", maxLength: 4000 },
                    objective: { type: "string", maxLength: 2000, description: "Required for kind=task." },
                    adapter: { type: "string", description: "Read-only adapter name, required for kind=task." },
                    correlationId: { type: "string", description: "Thread id; generated when omitted." },
                    idempotencyKey: { type: "string", maxLength: 160 },
                    project: { type: "string" }
                  }
                }
              }
            }
          },
          responses: {
            "201": { description: "Message stored and queued" },
            "200": { description: "Replayed: the idempotency key already named this message" },
            "400": errorResponse("Invalid kind, body, objective, adapter or idempotency key"),
            "401": errorResponse("Missing or invalid command token"),
            "403": errorResponse("Adapter is not on the read-only allowlist"),
            "429": errorResponse("Per-origin rate limit reached"),
            "503": errorResponse("The message channel is not mounted")
          }
        },
        get: {
          operationId: "listNexusMessages",
          summary: "List messages",
          description: "Most recently updated messages, newest first.",
          parameters: [
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            { name: "correlationId", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } }
          ],
          responses: {
            "200": { description: "A bounded list of messages" },
            "401": errorResponse("Missing or invalid command token"),
            "503": errorResponse("The message channel is not mounted")
          }
        }
      },
      "/ax/command/messages/thread/{correlationId}": {
        get: {
          operationId: "getNexusThread",
          summary: "Retrieve a whole exchange by correlation id",
          description:
            "Returns every message in the thread oldest first, plus a terminal summary and any question waiting for Ax's decision.",
          parameters: [
            {
              name: "correlationId",
              in: "path",
              required: true,
              schema: { type: "string", maxLength: 120 }
            }
          ],
          responses: {
            "200": { description: "The thread, its terminal results and any awaiting decision" },
            "400": errorResponse("Invalid correlation id"),
            "401": errorResponse("Missing or invalid command token"),
            "503": errorResponse("The message channel is not mounted")
          }
        }
      },
      "/ax/command/messages/{id}/answer": {
        post: {
          operationId: "answerNexusQuestion",
          summary: "Answer a NEXUS question or approval request",
          description: "Answers a message whose status is awaiting_answer. A question may be answered once.",
          "x-openai-isConsequential": true,
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["answer"],
                  properties: { answer: { type: "string", maxLength: 4000 } }
                }
              }
            }
          },
          responses: {
            "200": { description: "The answer is recorded" },
            "401": errorResponse("Missing or invalid command token"),
            "404": errorResponse("No message with that id"),
            "409": errorResponse("The message is not awaiting an answer"),
            "503": errorResponse("The message channel is not mounted")
          }
        }
      },
      "/ax/command/tasks": {
        post: {
          operationId: "submitTask",
          summary: "Submit an objective",
          description:
            "Creates a command task owned by Ax and returns its id immediately. Reusing an idempotencyKey returns the same task.",
          "x-openai-isConsequential": true,
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SubmitRequest" } }
            }
          },
          responses: {
            "201": {
              description: "Task accepted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      schemaVersion: { type: "integer", const: 1 },
                      ok: { type: "boolean", const: true },
                      task: { $ref: "#/components/schemas/Task" }
                    }
                  }
                }
              }
            },
            "200": {
              description: "Replayed: the idempotency key already named this task",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      schemaVersion: { type: "integer", const: 1 },
                      ok: { type: "boolean" },
                      replayed: { type: "boolean", const: true },
                      task: { $ref: "#/components/schemas/Task" }
                    }
                  }
                }
              }
            },
            "400": errorResponse("Invalid objective or role"),
            "401": errorResponse("Missing or invalid command token"),
            "503": errorResponse("Command API or storage is not configured")
          }
        },
        get: {
          operationId: "listTasks",
          summary: "List recent tasks",
          description: "Most recently updated command tasks, optionally filtered by status.",
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: {
                type: "string",
                enum: ["queued", "working", "needs_approval", "done", "failed", "cancelled"]
              },
              description: "Only return tasks in this state."
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
              description: "Maximum tasks to return."
            }
          ],
          responses: {
            "200": {
              description: "Tasks, newest first",
              content: { "application/json": { schema: { type: "object" } } }
            },
            "401": errorResponse("Missing or invalid command token")
          }
        }
      },
      "/ax/command/tasks/{id}": {
        get: {
          operationId: "getTask",
          summary: "Read one task",
          description:
            "Returns the task's current state, its history, its error if it failed, and result.evidence when it completed.",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "The task id returned by submitTask."
            }
          ],
          responses: {
            "200": {
              description: "The task",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      schemaVersion: { type: "integer", const: 1 },
                      ok: { type: "boolean", const: true },
                      task: { $ref: "#/components/schemas/Task" }
                    }
                  }
                }
              }
            },
            "401": errorResponse("Missing or invalid command token"),
            "404": errorResponse("No task with that id")
          }
        }
      },
      "/ax/command/events": {
        get: {
          operationId: "getEvents",
          summary: "Read changes since a cursor",
          description:
            "Tasks whose state changed after the cursor, oldest first. Pass nextSince and nextAfterId back to continue.",
          parameters: [
            {
              name: "since",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
              description: "ISO-8601 timestamp from a previous nextSince."
            },
            {
              name: "afterId",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Task id from a previous nextAfterId, breaking ties in the same millisecond."
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
              description: "Maximum changed tasks per page."
            }
          ],
          responses: {
            "200": {
              description: "Changed tasks with a cursor for the next page",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      schemaVersion: { type: "integer", const: 1 },
                      ok: { type: "boolean", const: true },
                      events: { type: "array", items: { type: "object" } },
                      nextSince: { type: "string", format: "date-time" },
                      nextAfterId: { type: "string" },
                      hasMore: { type: "boolean" }
                    }
                  }
                }
              }
            },
            "400": errorResponse("since is not an ISO-8601 timestamp"),
            "401": errorResponse("Missing or invalid command token")
          }
        }
      },
      "/ax/command/presence": {
        get: {
          operationId: "getPresence",
          summary: "Ask whether NEXUS is available",
          description:
            "Reports the executor state, heartbeat freshness and queue depth. A sleeping or unstarted executor is reported as such, never as success.",
          responses: {
            "200": {
              description: "Availability facts",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      schemaVersion: { type: "integer", const: 1 },
                      ok: { type: "boolean", const: true },
                      presence: {
                        type: "object",
                        properties: {
                          reachable: { type: "boolean" },
                          canExecute: {
                            type: "boolean",
                            description: "True only when a heartbeat is fresh; a stale one means nothing is running."
                          },
                          executor: { type: "object" },
                          heartbeat: { type: "object" },
                          queue: { type: "object" },
                          observedAt: { type: "string", format: "date-time" }
                        }
                      }
                    }
                  }
                }
              }
            },
            "401": errorResponse("Missing or invalid command token")
          }
        }
      },
      "/ax/command/tools": {
        get: {
          operationId: "listTools",
          summary: "List available adapters",
          description: "The read-only adapters a task may name. Side-effecting adapters are absent by design.",
          responses: {
            "200": {
              description: "Adapter summary",
              content: { "application/json": { schema: { type: "object" } } }
            },
            "401": errorResponse("Missing or invalid command token")
          }
        }
      }
    }
  };
}
