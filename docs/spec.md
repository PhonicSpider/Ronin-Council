# Ronin Council — Design Spec (test build 0.1)

A private, local, Discord/Teams-style desktop app. You plus a council of Claude agents,
organised into **categories (projects)** and **channels (aspects of a project)**, supervised by **Widow**.

Approved by the user in conversation (sections 1–3). The user then authorised building a test version
and skipping the separate review of this document; it records what was agreed.

## Goals
- One window, three panes: left (top bar + categories/channels), centre (chat), right (viewer on top, notes below).
- 13 seeded agents, fully editable from Settings; Widow cannot be removed.
- Talk-only agents in this build. Real-work tools (file edits, commands) are phase 6.

## Roster (seed, all editable)
Widow (supervisor) · Programming · QA/Test · Librarian · Research ×2 · UX ×2 · Engineering ×2 · Security ×2 · Art.
Paired auditors review each other's *deliverables* (not casual chat); each partner has a different stance
(builder vs. breaker). Widow breaks ties; unresolved disagreement goes to the user as a notification.

## Structure rules (enforced in the store, tested)
- A channel belongs to exactly one category for life; it can only be reordered inside that category.
- Categories can be reordered and collapsed. Channels collapse with their category.
- Widow is a member of every channel and cannot be removed from one. Widow also has a DM outside all categories.
- Members are added/removed by the user per channel.

## Conversation routing (orchestrator)
1. `@Agent` mention → those agents reply directly.
2. Otherwise Widow routes: if only one non-Widow candidate, no model call; else a cheap routing pass returns names.
3. Agents may `@` other members; those replies join the queue.
4. A reply starting `DELIVERABLE:` is tagged and reviewed by its partner (if a member, else Widow).
   Non-approval → Widow decides accept/revise → author revises once → partner re-reviews once → else notify user.
5. Safeguards: turn cap per user message (default 8), daily and per-category spend caps, repeat-loop detection, stop button.

## Permissions
Agent request → Widow audits (pass/deny) → if passed, shown inline when the user is in that channel, otherwise in the
notifications centre → user approves/denies. In this build nothing executes; the flow is exercised by a dev button.

## Memory
- One vault (plain markdown folder) per category; path set in Settings (default: app-data folder).
- `_Other Vaults.md` is generated in each vault by the Librarian and verified by Widow (index of the other vaults).
- Any agent can read any vault (digest in prompt; viewer can open files). Writes only through Librarian/Widow code path.

## Models & cost
Tiers map to models, editable in Settings: fast = claude-haiku-5-5, standard = claude-sonnet-5-5, top = claude-opus-5-5
(Widow). Prices are estimates from the API docs and are editable. With no API key the app runs in **Mock mode**
(deterministic fake agents) so the whole UI and orchestration can be tested for free.

## Storage
Single JSON file in app data behind the `Store` class (SQLite swap is a later, contained change).
API key kept in a separate file encrypted with Electron `safeStorage`, never sent to the renderer.

## Out of scope for 0.1
Real-work tools, second-provider (Gemini etc.) research partner, prompt caching, SQLite, light theme, packaging/installer.
