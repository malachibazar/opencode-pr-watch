import { Schema } from "effect"
import { Rpc } from "@opencode/plugin/rpc"

const standard = Schema.toStandardSchemaV1

export const PullStatus = Schema.Literals([
  "failing",
  "conflict",
  "changes",
  "pending",
  "open",
  "draft",
  "ready",
  "closed",
  "merged",
])
export type PullStatus = typeof PullStatus.Type

export const Pull = Schema.Struct({
  url: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  branch: Schema.String,
  status: PullStatus,
  detail: Schema.String,
})
export type Pull = typeof Pull.Type

export const Watch = Schema.Struct({
  sessionID: Schema.String,
  autofix: Schema.Boolean,
  archiveOnMerge: Schema.Boolean,
  pulls: Schema.Array(Pull),
})
export type Watch = typeof Watch.Type

const SessionInput = standard(Schema.Struct({ sessionID: Schema.String }))
const WatchOutput = standard(Watch)

export const PrWatch = Rpc.define({
  id: "pr-watch",
  methods: {
    status: { input: SessionInput, output: WatchOutput },
    refresh: { input: SessionInput, output: WatchOutput },
    configure: {
      input: standard(
        Schema.Struct({
          sessionID: Schema.String,
          autofix: Schema.optionalKey(Schema.Boolean),
          archiveOnMerge: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      output: WatchOutput,
    },
    track: {
      input: standard(Schema.Struct({ sessionID: Schema.String, pull: Schema.String })),
      output: WatchOutput,
      errors: { invalid_pull: standard(Schema.Struct({ pull: Schema.String })) },
    },
    dismiss: {
      input: standard(Schema.Struct({ sessionID: Schema.String, url: Schema.String })),
      output: WatchOutput,
    },
  },
  events: {
    updated: { schema: WatchOutput },
    /** Feedback for the person, shown outside the session so it never becomes the agent's input. */
    notice: {
      schema: standard(Schema.Struct({ id: Schema.String, sessionID: Schema.String, text: Schema.String })),
    },
    changed: {
      schema: standard(
        Schema.Struct({
          id: Schema.String,
          sessionID: Schema.String,
          previous: PullStatus,
          pull: Pull,
        }),
      ),
    },
  },
})
