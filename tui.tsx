/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import * as fs from "node:fs"
import * as path from "node:path"

type EchoesState = {
  version: number
  protocolVersion: string
  engineVersion: string
  initialized: boolean
  session: {
    started: boolean
    saved: boolean
    lastStart: string | null
    lastSave: string | null
  }
  stats?: {
    totalPages: number
    totalDailyLogs: number
    deprecatedPages: number
  }
  lastWriter?: {
    agent: string | null
    adapterVersion: string | null
  }
}

type EchoesMarker = {
  protocolVersion?: string
}

type VaultSnapshot = {
  marker: EchoesMarker | null
  state: EchoesState | null
}

const readJson = <Value,>(file: string): Value | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Value
  } catch {
    return null
  }
}

const readSnapshot = (workspace: string): VaultSnapshot => ({
  marker: readJson<EchoesMarker>(path.join(workspace, "EchoesVault", ".echoes-vault.json")),
  state: readJson<EchoesState>(path.join(workspace, ".echoes-vault", "state.json")),
})

const tui: TuiPlugin = async (api, _options, meta) => {
  const theme = api.theme.current
  const workspace = api.state.path.worktree || api.state.path.directory || process.cwd()

  api.slots.register({
    slots: {
      sidebar_content() {
        const [snapshot, setSnapshot] = createSignal<VaultSnapshot>(readSnapshot(workspace))
        const interval = setInterval(() => setSnapshot(readSnapshot(workspace)), 3000)
        onCleanup(() => clearInterval(interval))

        const markerReady = () => snapshot().marker?.protocolVersion === "1.0.0"
        const state = () => snapshot().state

        const statusColor = () => {
          if (!markerReady()) return theme.error
          if (state()?.session.saved) return theme.accent
          if (state()?.session.started) return theme.success
          return theme.warning
        }

        const statusLabel = () => {
          const marker = snapshot().marker
          if (!marker) return "Not Initialized"
          if (!markerReady()) return `Unsupported Protocol ${marker.protocolVersion ?? "?"}`
          if (!state()) return "Ready — Local State Missing"
          if (state()?.session.saved) return "Memory Saved"
          if (state()?.session.started) return "Active"
          return "Session Not Started"
        }

        const pages = () => state()?.stats?.totalPages ?? 0
        const vaultHealthColor = () => {
          if (pages() > 200) return theme.error
          if (pages() >= 170) return theme.warning
          return theme.success
        }

        const statusCommand = () => {
          if (!snapshot().marker) return ["/echoes-init", "to initialize or migrate"] as const
          if (!markerReady()) return ["/echoes-status", "to inspect compatibility"] as const
          if (state()?.session.saved) return null
          if (state()?.session.started) return ["/echoes-end", "before closing"] as const
          return ["/echoes-start", "to restore context"] as const
        }

        const lastWriter = () => {
          const writer = state()?.lastWriter
          if (!writer?.agent) return null
          return `${writer.agent}${writer.adapterVersion ? ` ${writer.adapterVersion}` : ""}`
        }

        return (
          <box flexDirection="column">
            <box flexDirection="row">
              <text fg={statusColor()}><b>{"• "}</b></text>
              <text fg={theme.textMuted}><b>Echoes</b></text>
              <text fg={theme.text}><b>Vault</b></text>
              <text fg={theme.textMuted}>{meta.version ? ` v${meta.version}` : ""}</text>
            </box>
            <text fg={statusColor()}>{statusLabel()}</text>
            {statusCommand() ? (
              <box flexDirection="row">
                <text fg={theme.textMuted}>Run </text>
                <text fg={theme.text}>{statusCommand()?.[0]}</text>
                <text fg={theme.textMuted}> {statusCommand()?.[1]}</text>
              </box>
            ) : null}
            {markerReady() ? (
              <box flexDirection="column">
                <text>{""}</text>
                <box flexDirection="row">
                  <text fg={vaultHealthColor()}>{"• "}</text>
                  <text fg={theme.text}><b>Vault Health</b></text>
                </box>
                <text fg={theme.textMuted}>Pages: {pages()}</text>
                <text fg={theme.textMuted}>Daily entries: {state()?.stats?.totalDailyLogs ?? 0}</text>
                <text fg={theme.textMuted}>Protocol: {snapshot().marker?.protocolVersion}</text>
                {state()?.engineVersion ? (
                  <text fg={theme.textMuted}>Engine: {state()?.engineVersion}</text>
                ) : null}
                {lastWriter() ? <text fg={theme.textMuted}>Last writer: {lastWriter()}</text> : null}
                {pages() > 200 ? (
                  <text fg={theme.textMuted}>Prefer targeted search over loading all pages</text>
                ) : null}
              </box>
            ) : null}
          </box>
        )
      },
    },
  })
}

export default { id: "echoes-vault-ui", tui }
