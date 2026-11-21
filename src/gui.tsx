import { Command, Panel, Plugin, SettingsPage, Style, TitlebarItem, type PanelTab } from "@opencode/plugin/gui"
import { Dashboard } from "./gui/dashboard"
import { Usage } from "./rpc"
import { createEffect, createSignal, onCleanup, onMount } from "solid-js"
import type { Account, Range, Snapshot } from "./schema"
import { selectedAccount, usageButton } from "./gui/selected-account"
import sidebarButtonStyles from "./gui/sidebar-button.css?inline"

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, sidebarButtonStyles)
    const [account, setAccount] = createSignal<Account>()
    const [offline, setOffline] = createSignal(false)
    const [now, setNow] = createSignal(Date.now())
    let stopped = false
    let sequence = 0
    const load = async (range: Range): Promise<Snapshot> => {
      const request = ++sequence
      try {
        const result = await ctx.client.rpc(Usage).snapshot({ range })
        if (!stopped && request === sequence) {
          setAccount(selectedAccount(result.accounts))
          setOffline(false)
          setNow(Date.now())
        }
        return result
      } catch (error) {
        if (!stopped && request === sequence) {
          setOffline(true)
          setNow(Date.now())
        }
        throw error
      }
    }
    const refreshButton = () => { void load("day").catch(() => {}) }
    onMount(() => {
      refreshButton()
      const timer = setInterval(refreshButton, 60_000)
      onCleanup(() => clearInterval(timer))
    })
    // Listen even while the dashboard is closed so the sidebar follows account changes.
    createEffect(() => {
      const client = ctx.client
      const controller = new AbortController()
      void (async () => {
        for await (const _event of client.event.subscribe({
          types: ["credential.switched", "credential.updated"],
          signal: controller.signal,
        })) {
          setAccount(undefined)
          refreshButton()
        }
      })().catch(() => { /* The minute-based refresh remains available if events disconnect. */ })
      onCleanup(() => controller.abort())
    })
    onCleanup(() => { stopped = true })
    const dashboard = () => <Dashboard
      load={load}
      exportData={range => ctx.client.rpc(Usage).export({ range })}
      openUsage={() => ctx.system.openExternal("https://chatgpt.com/settings/usage")}
      watchAccounts={onChange => {
        const controller = new AbortController()
        void (async () => {
          for await (const _event of ctx.client.event.subscribe({
            types: ["credential.switched", "credential.updated"],
            signal: controller.signal,
          })) onChange()
        })().catch(() => { /* The minute-based refresh remains available if events disconnect. */ })
        return () => controller.abort()
      }}
    />
    const tab: PanelTab = { id: "overview", title: "Account usage", closable: "compact", fallback: true }
    const open = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:overview`, session)
      else ctx.layout.settings("account-usage")
    }
    ctx.add(Panel, {
      id: "overview", region: "side", width: 780,
      list: input => input.open.includes("overview") ? [tab] : [],
      render: dashboard,
    })
    ctx.add(SettingsPage, {
      id: "account-usage", title: "Account usage", icon: "status",
      entries: [{ id: "overview", title: "OpenAI account usage", keywords: "codex chatgpt tokens quota limits accounts" }],
      render: dashboard,
    })
    ctx.add(Command, {
      id: "open", title: "Open account usage", keywords: "openai codex chatgpt tokens quota",
      slash: { name: "account-usage" }, run: open,
    })
    ctx.add(TitlebarItem, (): TitlebarItem => {
      const button = usageButton(account(), now(), offline())
      return {
        id: "usage", ...button, title: `OpenAI account usage: ${button.title}`, icon: "status", run: open,
      }
    })
  },
})
