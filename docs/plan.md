# Build plan — test build 0.1

1. Scaffold: package.json, tsconfigs, vite, vitest, index.html
2. `shared/types.ts`
3. `electron/store.ts` (+ seed) — structure rules; **tests**
4. `electron/orchestrator.ts` + providers (mock, Claude) — routing, audit pairs, caps, loop detect, permissions; **tests**
5. `electron/vault.ts` — list/read/write guard, cross-vault index; **tests**
6. `electron/main.ts`, `preload.ts`, `api.ts` — IPC surface, secrets, dialogs
7. Renderer: sidebar (drag/drop, collapse), chat, right panel, settings, agent popup, notifications
8. Gates: `npm run check` = typecheck + tests + build; launch the app and smoke-test in Mock mode
9. Independent code review pass; fix findings; report
