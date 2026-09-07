---
description: Explicitly finalize the session into EchoesVault
agent: build
---

The user explicitly authorized final session saving.

Distill the session into dense final outcomes, verified decisions, unresolved blockers, and next
steps—not a transcript. Prepare only durable knowledge pages that add or materially revise reusable
project knowledge. Every page must contain `type`, `stack`, `status`, and a one-line `summary` of at
most 160 characters.

Before replacing an existing page, read it and call `echoes_hash_vault_page`; include the returned
SHA-256 as `expectedSha256`. Then call `commit_memory_to_echoes_vault` exactly once. Never edit
`EchoesVault/index.md`; the shared runtime generates it.
