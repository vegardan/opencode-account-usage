import { Plugin } from "@opencode/plugin"
import { Usage } from "./rpc"
import { Tracker } from "./tracker"

export default Plugin.define({
  id: "account-usage",
  async setup(ctx) {
    const tracker = new Tracker(ctx)
    await tracker.start()
    await ctx.rpc.register(Usage, {
      snapshot: input => tracker.snapshot(input.range),
      export: input => tracker.export(input.range),
    })
    await ctx.tool.transform(editor => {
      editor.add({
        name: "account_usage",
        description: "Read Codex subscription limits and locally recorded OpenAI token usage for every connected account.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify(await tracker.snapshot("week")) }),
      })
    })
    return () => tracker.stop()
  },
})
