import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import { RangeSchema, SnapshotSchema } from "./schema"

export const Usage = Rpc.define({
  id: "account-usage",
  events: {},
  methods: {
    snapshot: {
      input: z.object({ range: RangeSchema.default("week") }),
      output: SnapshotSchema,
    },
    export: {
      input: z.object({ range: RangeSchema.default("week") }),
      output: z.object({ filename: z.string(), csv: z.string() }),
    },
  },
})
