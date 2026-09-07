---
description: Inspect EchoesVault protocol, storage, metadata, conflicts, Git readiness, and scale
agent: build
---

Call `echoes_vault_status` exactly once and return its compact status card. This operation is
strictly read-only: do not initialize, migrate, hydrate, repair, or edit the vault while reporting
status.
