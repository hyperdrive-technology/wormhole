# Wormhole — agent instructions

Import/migration layer for Hyperdrive: external or legacy PLC source → Edition 4–oriented `.plc`, diagnostics, preservation sidecars. Never emits `hyperdrive.ir.v1` (compiler-owned).

## Stack

- **TypeScript** end-to-end
- **TanStack Start** for [`apps/wormhole-ui/`](apps/wormhole-ui/)
- Library packages under [`packages/`](packages/) — importers call `@wormhole/migrate`, archives via `@wormhole/contract`

## Boundaries

- **Public repo (MIT).** Never commit secrets, customer/vendor project files, local paths, or details of private importers. Vendor importers (for example Rockwell L5X) live in separate, possibly private, repos that depend on this contract; see `docs/ARCHITECTURE.md` § Open and private importers.
- Standalone build: no imports from Hyperdrive core. Legacy construct translators live in `packages/migrate/src/legacy/` (moved from core on 2026-10-28).
- `packages/contract/schemas/` is the canonical copy of the `hyperdrive.importer-*.v1` schemas. Keep it identical to Hyperdrive core's `docs/schemas/` copy until core consumes this package.

## Commands

```bash
cd wormhole && pnpm install
pnpm dev                    # wormhole-ui on :3001
pnpm test                   # all package tests
pnpm test:compile-gate      # upgraded fixtures → Hyperdrive compiler (needs ../core or HYPERDRIVE_CORE_DIR; skips otherwise)
```
