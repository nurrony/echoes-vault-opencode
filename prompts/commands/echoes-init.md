---
description: Initialize, migrate, or explicitly upgrade EchoesVault for this repository
agent: build
---

The user explicitly requested EchoesVault initialization or migration.

Call `echoes_activate_vault` exactly once. It invokes the shared portable runtime and may create or
upgrade the protocol marker, runtime, generated index, local state, and managed agent adapters.
Do not create or edit those files with ordinary filesystem tools.

After the tool succeeds, briefly report whether the vault was created or migrated and mention any
Git-readiness or adapter-conflict warnings returned by the runtime.
