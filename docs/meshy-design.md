# Meshy art tools

Status: built (phases 1 to 3) and tested against a fake Meshy server. Not yet tried with a real key. The Blender character path is a written brief for now, as described below.

The text below is the design as approved; where the request fields were unknown at design time they were taken from Meshy's published endpoint documentation.

Goal: let chosen agents create 3D models and images through the Meshy API, with the same approval rules as every other
action. Iris (Art) gets it. Mira and Kade (UX/UI layout) do not: layout work is reasoning about structure, which suits a
language model. They can ask Iris for decorative assets.

## What the agent can do

Three tools, offered only to an agent that has the Meshy ability, in a channel whose category has a project folder:

| Tool | Cost | Needs approval |
|---|---|---|
| `meshy_generate` with `kind`: `text_to_3d`, `image_to_3d`, `text_to_image` (later: retexture, remesh, rig) | credits | yes |
| `meshy_fetch` (download a task that already finished, by id) | free | no |
| `meshy_balance` | free | no |

Meshy deletes API results after about 3 days on most plans, so every successful task is downloaded at once into
`<project>/assets/meshy/<name>-<taskid>.glb` (and a preview image), written with the same confinement rules as `write_file`.

## Choosing the generator (Meshy or the Blender character skill)

Not either/or. Every art request has a generator: `meshy`, `blender`, or `auto`.

- **Default rule (auto):** characters go to the Blender character skill, objects, props and scenery go to Meshy. This rule lives
  in Iris's specialty text, so it is visible and editable in her profile.
- **You override in plain words:** "make the sword with Meshy", "do the guard in Blender". An explicit choice always wins, and
  Iris says which generator she is using before she asks for approval.
- **The tool takes it as a field** (`meshy_generate` for Meshy, and a separate `blender_character` tool for the other path), so
  the approval card always shows which generator will run and what it costs. Blender costs no Meshy credits.
- **The Blender path cannot be designed in detail yet.** The skill lives in Claude Code, not in this app, and is not finished.
  Until it is, a character request produces a written brief saved to `assets/requests/` (after approval) and a message telling
  you to run the skill. Once the skill exists, `blender_character` can run it through the same approved-command route as
  `run_command`, and the finished file lands in the project like a Meshy result.
- Mira and Kade stay without either tool.

## Approval card

Shown before any credits are spent, and audited by Widow like every other request. It lists: the kind, the exact prompt,
the quality or model setting, the estimated credits (from a table in code, labelled an estimate), the credits left today, the
current Meshy balance, and, for image input, the file name and size ("this file is sent to Meshy"). It also says plainly that
pressing Stop ends the wait but Meshy may still finish and charge the task.

## Flow

1. Agent calls `meshy_generate`. The app validates the input (prompt length, a project image of an allowed type and size).
2. Approval (above). Nothing is sent before it.
3. Create the task, then poll every 5 seconds (honouring `Retry-After`). Stop aborts the polling.
4. On success, download the model and preview, save them in the project, post a preview in the channel, and tell the agent the
   path. On failure Meshy refunds, and the app subtracts the estimate again. On a timeout (10 minutes) the agent is given the
   task id and can use `meshy_fetch` later.

## Settings and access

- **Ability per agent**, a checkbox in the profile ("Can create art with Meshy; uses credits"). On for Iris. Existing councils
  get it for Iris once, and a later removal sticks (same idea as the one-time provisioning of new agents).
- **Key**: a "Meshy" row in API & Models, encrypted like the vendor keys. The key is only ever sent to `https://api.meshy.ai`.
  The key vault's ids widen from vendors to vendors plus `meshy`.
- **Budget in credits**, separate from dollars: a daily cap (default 100) in Settings, shown in Budgets next to spend. A request
  that would pass the cap is refused before approval. Meshy's own optional per-key credit limit is a second guard.
- **Mock mode** returns a tiny placeholder model and image, so the whole flow works free and is testable.

## Security

- Prompts and image input come from the agent, so they are shown in full on the card and treated as untrusted.
- Downloads: https only, no key sent to the download host, a size cap, and an allowed file type, saved inside the project only.
- The key never reaches the interface, logs or error text (same scrubbing as the vendor adapter).

## Tests

A fake Meshy server (as with the OpenAI adapter): create, poll, succeed, download; a failed task is refunded in the counter;
Stop mid-poll; timeout then `meshy_fetch`; no tool offered without the ability, key or project folder; no spend without
approval; path confinement of the saved file; budget refusal; mock mode; the self-test drives the profile checkbox and the
approval card.

## Unknowns to settle before coding

- The exact request and response fields per endpoint. The plan is to read Meshy's published OpenAPI spec first.
- Which host serves the finished files (so the download check is right). If it cannot be pinned down, any https host is
  allowed because no credential is sent to it.
- Credit prices change, so the estimate table must be easy to update, and the real figure comes from Meshy's balance.
- Rights to the generated models, including commercial use. Read Meshy's terms before shipping anything made with it.
- Real behaviour can only be checked with a key on a paid plan; tests use the fake server.

## Phases

1. Ability flag, Meshy key, credit budget, settings UI (no network).
2. Meshy client and the three tools, against the fake server.
3. Approval card, saving into the project, chat preview, mock mode.
4. Docs, self-test, and a first run with a real key.
