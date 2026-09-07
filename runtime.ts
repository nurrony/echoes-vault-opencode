import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))
const BUNDLED_RUNTIME = path.join(PLUGIN_ROOT, "scripts", "echoes_vault.py")

export type EchoesCommand =
  | "init"
  | "migrate"
  | "upgrade"
  | "protocol"
  | "configure-agents"
  | "inspect"
  | "hydrate"
  | "start"
  | "status"
  | "search"
  | "append"
  | "upsert"
  | "end"
  | "hash"
  | "rebuild-index"

export type RunEchoesOptions = {
  args?: string[]
  payload?: Record<string, unknown>
  signal?: AbortSignal
  adapterVersion?: string
  launcherPath?: string
}

export class EchoesRuntimeError extends Error {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(message: string, exitCode: number | null, stdout: string, stderr: string) {
    super(message)
    this.name = "EchoesRuntimeError"
    this.exitCode = exitCode
    this.stdout = stdout
    this.stderr = stderr
  }
}

/**
 * Prefer OpenCode's current session directory over its worktree hint. Some global-plugin launches
 * report `/` as the worktree even when the session directory points at the real project.
 */
export const resolveEchoesWorkspace = (...candidates: Array<string | undefined>): string => {
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue
    const resolved = path.resolve(candidate)
    if (resolved !== path.parse(resolved).root) return resolved
  }
  throw new EchoesRuntimeError(
    "OpenCode did not provide a safe project directory. Refusing to use the filesystem root as the EchoesVault workspace.",
    null,
    "",
    "",
  )
}

let adapterVersionPromise: Promise<string> | undefined

export const getAdapterVersion = async (): Promise<string> => {
  adapterVersionPromise ??= fs
    .readFile(path.join(PLUGIN_ROOT, "package.json"), "utf-8")
    .then((raw) => {
      const value = (JSON.parse(raw) as { version?: unknown }).version
      return typeof value === "string" && value.trim() ? value : "0.0.0"
    })
    .catch(() => "0.0.0")
  return adapterVersionPromise
}

const runtimeMessage = (stderr: string, stdout: string, exitCode: number | null): string => {
  const raw = stderr.trim() || stdout.trim()
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { error?: unknown }
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error
    } catch {
      // The runtime may emit a plain Python/process error instead of protocol JSON.
    }
    return raw
  }
  return `EchoesVault runtime exited with code ${exitCode ?? "unknown"}.`
}

/**
 * Invoke the bundled launcher as an argv array. The launcher bootstraps or upgrades only for
 * explicit lifecycle commands and delegates normal operations to the project-local runtime.
 */
export const runEchoes = async (
  workspace: string,
  command: EchoesCommand,
  options: RunEchoesOptions = {},
): Promise<string> => {
  const resolvedWorkspace = resolveEchoesWorkspace(workspace)
  const adapterVersion = options.adapterVersion ?? (await getAdapterVersion())
  const launcher = options.launcherPath ?? BUNDLED_RUNTIME
  const commandArgs = options.args ?? []
  const payload = options.payload === undefined ? undefined : JSON.stringify(options.payload)
  const python = process.env.ECHOES_VAULT_PYTHON?.trim() || "python3"

  const argv = [
    launcher,
    "--workspace",
    resolvedWorkspace,
    "--agent",
    "opencode",
    "--adapter-version",
    adapterVersion,
    command,
    ...commandArgs,
  ]

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(python, argv, {
      cwd: resolvedWorkspace,
      stdio: [payload === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    const abort = () => child.kill("SIGTERM")
    options.signal?.addEventListener("abort", abort, { once: true })

    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort)
      reject(
        new EchoesRuntimeError(
          `Cannot start EchoesVault runtime with ${python}: ${error.message}`,
          null,
          Buffer.concat(stdout).toString("utf-8"),
          Buffer.concat(stderr).toString("utf-8"),
        ),
      )
    })
    child.once("close", (exitCode) => {
      options.signal?.removeEventListener("abort", abort)
      const output = Buffer.concat(stdout).toString("utf-8")
      const errors = Buffer.concat(stderr).toString("utf-8")
      if (exitCode === 0) {
        resolve(output)
        return
      }
      reject(new EchoesRuntimeError(runtimeMessage(errors, output, exitCode), exitCode, output, errors))
    })

    if (payload !== undefined) child.stdin!.end(payload)
  })
}

export const runEchoesJson = async <Value>(
  workspace: string,
  command: EchoesCommand,
  options: RunEchoesOptions = {},
): Promise<Value> => {
  const output = await runEchoes(workspace, command, options)
  try {
    return JSON.parse(output) as Value
  } catch {
    throw new EchoesRuntimeError(
      "EchoesVault runtime returned invalid JSON.",
      0,
      output,
      "",
    )
  }
}
