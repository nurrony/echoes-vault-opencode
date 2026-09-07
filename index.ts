import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveEchoesWorkspace, runEchoes } from "./runtime.ts"

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url))

const parseCommandFrontmatter = (
  command: string,
): { template: string; description?: string; agent?: string } => {
  const match = command.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { template: command }

  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":")
    if (key && rest.length) frontmatter[key.trim()] = rest.join(":").trim()
  }
  return {
    template: match[2],
    description: frontmatter.description,
    agent: frontmatter.agent,
  }
}

const displayOutput = (output: string): string => output.trimEnd()

const statusActions = {
  "echoes-init": "init",
  "echoes-start": "start",
  "echoes-end": "end",
} as const

type StatusAction = (typeof statusActions)[keyof typeof statusActions]

const OpenCodeEchoes: Plugin = async ({ directory, worktree }) => {
  const readPromptFile = async (relativePath: string): Promise<string> =>
    await fs.readFile(path.join(PLUGIN_ROOT, "prompts", relativePath), "utf-8")

  const commands: Record<string, string> = {
    "echoes-init.md": await readPromptFile("commands/echoes-init.md"),
    "echoes-start.md": await readPromptFile("commands/echoes-start.md"),
    "echoes-end.md": await readPromptFile("commands/echoes-end.md"),
    "echoes-status.md": await readPromptFile("commands/echoes-status.md"),
  }

  // Lifecycle tools are one-shot capabilities granted only by the matching explicit slash command.
  const authorizedStatusActions = new Map<string, StatusAction>()
  const workspaceFor = (contextDirectory?: string, contextWorktree?: string): string =>
    resolveEchoesWorkspace(contextDirectory, contextWorktree, directory, worktree)

  const requireAuthorization = (sessionID: string, expected: StatusAction): void => {
    if (authorizedStatusActions.get(sessionID) !== expected) {
      throw new Error(
        `EchoesVault ${expected} requires the explicit /echoes-${expected} command from the user.`,
      )
    }
  }

  return {
    config: async (input) => {
      input.command ||= {}
      for (const [name, command] of Object.entries(commands)) {
        const { template, description, agent } = parseCommandFrontmatter(command)
        input.command[name.replace(/\.md$/, "")] = { template, description, agent }
      }
    },

    "command.execute.before": async (input) => {
      const command = input.command.replace(/^\//, "") as keyof typeof statusActions
      const action = statusActions[command]
      if (action) authorizedStatusActions.set(input.sessionID, action)
    },

    tool: {
      echoes_activate_vault: tool({
        description:
          "Initialize or explicitly migrate EchoesVault through the shared portable runtime. Available only after /echoes-init.",
        args: {},
        async execute(_args, ctx) {
          requireAuthorization(ctx.sessionID, "init")
          const output = displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "init", {
              signal: ctx.abort,
            }),
          )
          authorizedStatusActions.delete(ctx.sessionID)
          return output
        },
      }),

      echoes_start_session: tool({
        description:
          "Restore the generated index and three most recent EchoesVault session entries. Available only after /echoes-start.",
        args: {},
        async execute(_args, ctx) {
          requireAuthorization(ctx.sessionID, "start")
          const output = displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "start", {
              args: ["--recent", "3"],
              signal: ctx.abort,
            }),
          )
          authorizedStatusActions.delete(ctx.sessionID)
          return output
        },
      }),

      echoes_vault_status: tool({
        description:
          "Inspect EchoesVault protocol, storage, metadata, index, Git readiness, conflicts, and scale without modifying files.",
        args: {},
        async execute(_args, ctx) {
          return displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "status", {
              args: ["--format", "card"],
              signal: ctx.abort,
            }),
          )
        },
      }),

      commit_memory_to_echoes_vault: tool({
        description:
          "Finalize an EchoesVault session with one daily summary and optional curated pages. Available only after explicit /echoes-end.",
        args: {
          dailySummary: tool.schema
            .string()
            .min(1)
            .describe("Dense final outcomes, unresolved blockers, and next steps; never a transcript."),
          pages: tool.schema
            .array(
              tool.schema.object({
                filename: tool.schema.string().min(1).describe("Safe page filename ending in .md."),
                content: tool.schema
                  .string()
                  .min(1)
                  .describe("Complete page with type, stack, status, and summary frontmatter."),
                expectedSha256: tool.schema
                  .string()
                  .optional()
                  .describe("Fresh current hash, required when replacing an existing page."),
              }),
            )
            .optional(),
        },
        async execute(args, ctx) {
          requireAuthorization(ctx.sessionID, "end")
          const output = displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "end", {
              args: ["--confirm-explicit-user-end", "--payload", "-"],
              payload: {
                dailySummary: args.dailySummary,
                pages: args.pages ?? [],
              },
              signal: ctx.abort,
            }),
          )
          authorizedStatusActions.delete(ctx.sessionID)
          return output
        },
      }),

      echoes_append_to_daily_log: tool({
        description:
          "Write one intermediate technical milestone to a unique EchoesVault daily entry without ending the session.",
        args: {
          logEntry: tool.schema
            .string()
            .min(1)
            .describe("Concise Markdown facts, decisions, blockers, or next steps."),
        },
        async execute(args, ctx) {
          return displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "append", {
              args: ["--payload", "-"],
              payload: { entry: args.logEntry },
              signal: ctx.abort,
            }),
          )
        },
      }),

      echoes_search_vault_pages: tool({
        description:
          "Search EchoesVault knowledge pages with a narrow keyword or phrase before reading a relevant page.",
        args: {
          query: tool.schema.string().min(1).describe("Specific keyword or short phrase."),
          limit: tool.schema.number().int().min(1).max(500).optional(),
        },
        async execute(args, ctx) {
          const runtimeArgs = [args.query]
          if (args.limit !== undefined) runtimeArgs.push("--limit", String(args.limit))
          return displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "search", {
              args: runtimeArgs,
              signal: ctx.abort,
            }),
          )
        },
      }),

      echoes_hash_vault_page: tool({
        description:
          "Calculate the current SHA-256 of an EchoesVault page before replacing that existing page.",
        args: {
          filename: tool.schema.string().min(1).describe("Existing page filename."),
        },
        async execute(args, ctx) {
          return displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "hash", {
              args: [args.filename],
              signal: ctx.abort,
            }),
          )
        },
      }),

      echoes_create_or_update_page: tool({
        description:
          "Create a validated EchoesVault page or replace one using its fresh expected SHA-256; the runtime regenerates the index.",
        args: {
          filename: tool.schema.string().min(1).describe("Exact page filename without paths."),
          content: tool.schema
            .string()
            .min(1)
            .describe("Complete Markdown page with all required frontmatter."),
          expectedSha256: tool.schema
            .string()
            .optional()
            .describe("Fresh current hash, required when replacing an existing page."),
        },
        async execute(args, ctx) {
          return displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "upsert", {
              args: ["--payload", "-"],
              payload: {
                filename: args.filename,
                content: args.content,
                ...(args.expectedSha256 ? { expectedSha256: args.expectedSha256 } : {}),
              },
              signal: ctx.abort,
            }),
          )
        },
      }),

      echoes_hydrate_vault: tool({
        description:
          "Rebuild only ignored local EchoesVault index/state files for an already initialized checkout.",
        args: {},
        async execute(_args, ctx) {
          return displayOutput(
            await runEchoes(workspaceFor(ctx.directory, ctx.worktree), "hydrate", {
              signal: ctx.abort,
            }),
          )
        },
      }),
    },
  }
}

export default { server: OpenCodeEchoes }
export { OpenCodeEchoes }
