import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import type { ToolContext } from "@opencode-ai/plugin"
import { OpenCodeEchoes } from "../index.ts"
import { EchoesRuntimeError, runEchoes, runEchoesJson } from "../runtime.ts"

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const RUNTIME_SHA256 = "9f9a91016ae4b503f942d4343ea13759dbe0e235864b2c521f4b172f655e0f58"

const withWorkspace = async (run: (workspace: string) => Promise<void>): Promise<void> => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "echoes-opencode-test-"))
  try {
    await run(workspace)
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

const exists = async (file: string): Promise<boolean> =>
  await fs
    .access(file)
    .then(() => true)
    .catch(() => false)

test("bundles the byte-identical EchoesVault reference runtime", async () => {
  const content = await fs.readFile(path.join(ROOT, "scripts", "echoes_vault.py"))
  assert.equal(createHash("sha256").update(content).digest("hex"), RUNTIME_SHA256)
})

test("plugin load registers tools without initializing or mutating the project", async () => {
  await withWorkspace(async (workspace) => {
    const hooks = await OpenCodeEchoes({ directory: workspace, worktree: workspace } as Parameters<
      typeof OpenCodeEchoes
    >[0])

    assert.ok(hooks.tool?.echoes_activate_vault)
    assert.equal(await exists(path.join(workspace, "EchoesVault")), false)
    assert.equal(await exists(path.join(workspace, ".echoes-vault")), false)
    assert.equal(await exists(path.join(workspace, ".opencode")), false)
  })
})

test("runtime refuses the filesystem root as a workspace", async () => {
  const filesystemRoot = path.parse(process.cwd()).root
  await assert.rejects(
    runEchoes(filesystemRoot, "init"),
    (error: unknown) =>
      error instanceof EchoesRuntimeError && /Refusing to use the filesystem root/.test(error.message),
  )
})

test("lifecycle writes prefer the session directory over a root worktree hint", async () => {
  await withWorkspace(async (workspace) => {
    const filesystemRoot = path.parse(workspace).root
    const hooks = await OpenCodeEchoes({
      directory: workspace,
      worktree: filesystemRoot,
    } as Parameters<typeof OpenCodeEchoes>[0])
    const activate = hooks.tool?.echoes_activate_vault
    assert.ok(activate)

    const context: ToolContext = {
      sessionID: "session-1",
      messageID: "message-1",
      agent: "build",
      directory: workspace,
      worktree: filesystemRoot,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    }

    await assert.rejects(activate.execute({}, context), /explicit \/echoes-init/)
    assert.equal(await exists(path.join(workspace, "EchoesVault")), false)

    await hooks["command.execute.before"]?.(
      { command: "echoes-init", sessionID: context.sessionID, arguments: "" },
      { parts: [] },
    )
    await activate.execute({}, context)

    assert.equal(await exists(path.join(workspace, "EchoesVault", ".echoes-vault.json")), true)
    await assert.rejects(activate.execute({}, context), /explicit \/echoes-init/)
  })
})

test("OpenCode initializes the shared runtime and writes unique protocol daily entries", async () => {
  await withWorkspace(async (workspace) => {
    await runEchoesJson(workspace, "init", { adapterVersion: "2.0.0" })
    const first = await runEchoesJson<{ dailyLog: string }>(workspace, "append", {
      adapterVersion: "2.0.0",
      args: ["--payload", "-"],
      payload: { entry: "- First verified milestone." },
    })
    const second = await runEchoesJson<{ dailyLog: string }>(workspace, "append", {
      adapterVersion: "2.0.0",
      args: ["--payload", "-"],
      payload: { entry: "- Second verified milestone." },
    })

    assert.notEqual(first.dailyLog, second.dailyLog)
    assert.match(first.dailyLog, /EchoesVault\/daily\/\d{4}-\d{2}-\d{2}\/.*-opencode-.*\.md$/)

    const marker = JSON.parse(
      await fs.readFile(path.join(workspace, "EchoesVault", ".echoes-vault.json"), "utf-8"),
    ) as { protocolVersion: string }
    const state = JSON.parse(
      await fs.readFile(path.join(workspace, ".echoes-vault", "state.json"), "utf-8"),
    ) as {
      version: number
      protocolVersion: string
      engineVersion: string
      lastWriter: { agent: string; adapterVersion: string }
    }

    assert.equal(marker.protocolVersion, "1.0.0")
    assert.equal(state.version, 4)
    assert.equal(state.protocolVersion, "1.0.0")
    assert.equal(state.engineVersion, "1.1.1")
    assert.deepEqual(state.lastWriter, { agent: "opencode", adapterVersion: "2.0.0" })
  })
})

test("explicit init migrates legacy OpenCode state and index summaries", async () => {
  await withWorkspace(async (workspace) => {
    await fs.mkdir(path.join(workspace, "EchoesVault", "pages"), { recursive: true })
    await fs.mkdir(path.join(workspace, ".opencode"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "EchoesVault", "pages", "architecture.md"),
      "---\ntype: architecture\nstack: [typescript]\nstatus: active\n---\n\n# Architecture\n",
    )
    await fs.writeFile(
      path.join(workspace, "EchoesVault", "index.md"),
      "# EchoesVault Index\n\n- [[architecture]]: Shared plugin architecture.\n",
    )
    await fs.writeFile(
      path.join(workspace, ".opencode", "echoes-state.json"),
      JSON.stringify({
        version: 1,
        pluginVersion: "1.2.3",
        initialized: true,
        session: {
          started: true,
          saved: false,
          lastStart: "2026-09-04T12:00:00+03:00",
          lastSave: null,
        },
      }),
    )

    await runEchoesJson(workspace, "init", { adapterVersion: "2.0.0" })

    const page = await fs.readFile(
      path.join(workspace, "EchoesVault", "pages", "architecture.md"),
      "utf-8",
    )
    const state = JSON.parse(
      await fs.readFile(path.join(workspace, ".echoes-vault", "state.json"), "utf-8"),
    ) as { session: { started: boolean; lastStart: string | null } }

    assert.match(page, /summary: ["']Shared plugin architecture\.["']/)
    assert.equal(state.session.started, true)
    assert.equal(state.session.lastStart, "2026-09-04T12:00:00+03:00")
  })
})

test("page replacement requires the current hash", async () => {
  await withWorkspace(async (workspace) => {
    await runEchoesJson(workspace, "init", { adapterVersion: "2.0.0" })
    const firstContent =
      "---\ntype: architecture\nstack: [typescript]\nstatus: active\nsummary: Initial shared architecture.\n---\n\n# Architecture\n"
    const nextContent = firstContent.replace("Initial shared", "Updated shared")

    await runEchoesJson(workspace, "upsert", {
      adapterVersion: "2.0.0",
      args: ["--payload", "-"],
      payload: { filename: "architecture.md", content: firstContent },
    })

    await assert.rejects(
      runEchoes(workspace, "upsert", {
        adapterVersion: "2.0.0",
        args: ["--payload", "-"],
        payload: { filename: "architecture.md", content: nextContent },
      }),
      (error: unknown) =>
        error instanceof EchoesRuntimeError && /expectedSha256/.test(error.message),
    )

    const hash = await runEchoesJson<{ sha256: string }>(workspace, "hash", {
      adapterVersion: "2.0.0",
      args: ["architecture.md"],
    })
    await runEchoesJson(workspace, "upsert", {
      adapterVersion: "2.0.0",
      args: ["--payload", "-"],
      payload: {
        filename: "architecture.md",
        content: nextContent,
        expectedSha256: hash.sha256,
      },
    })

    assert.equal(
      await fs.readFile(path.join(workspace, "EchoesVault", "pages", "architecture.md"), "utf-8"),
      nextContent,
    )
  })
})
