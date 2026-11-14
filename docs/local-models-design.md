# Local models (Ollama manager)

Status: built. Tested against fake servers and fake Windows data, plus read-only checks on the real machine (drive scan, GPU and
RAM, hardware badges, the popup in the real app). Ollama was not installed on the development machine, so installing, updating,
uninstalling, starting and stopping the real program have not been run. The first real use is the real test.

A "Local models" button next to Settings and Notifications opens a popup (same style as Settings and the agent profile). It finds,
starts, stops, updates and uninstalls Ollama, lists the downloaded models, and offers a list of models to download with a
"fits your machine" badge. Ollama itself runs as a hidden background process; the popup is only the control panel.

## Facts this is built on, and how sure they are

Confirmed from Ollama's own docs or release API (fetched 2026-11-13):
- API (`http://localhost:11434`): `GET /api/version` returns `{version}`; `GET /api/tags` returns `{models:[{name, size, digest, details:{parameter_size, quantization_level, family}}]}`; `GET /api/ps` returns loaded models with `size` and `size_vram`; `POST /api/pull` `{model, stream}` streams NDJSON (`status`, `digest`, `total`, `completed`, then `success`); `DELETE /api/delete` `{model}`.
- `/v1/chat/completions` is supported and supports tools (not `tool_choice`).
- Models live in `%USERPROFILE%\.ollama\models` unless the user environment variable `OLLAMA_MODELS` says otherwise. Default keep-alive is 5 minutes. Binds 127.0.0.1:11434.
- The Windows tray app updates itself ("Restart to update"). The installer accepts `/DIR="..."`.
- The latest release is read from `api.github.com/repos/ollama/ollama/releases/latest`. Each asset has a `sha256:` digest and a size.
- Library names and download sizes in the catalog were read from ollama.com/library pages on 2026-11-13. Kimi's official models are cloud only (and kimi-k2 is retired); there is no official hy/hunyuan model (community uploads only).

NOT confirmed (the design must not depend on them):
- The exact registry key, the uninstaller's file name, silent-install switches, and the process names. So: the uninstall entry is found by its display name, the uninstaller is run with its own window (no silent switches), and processes are matched by name AND by the verified install folder.
- Ollama is not installed on the development machine, so none of the install paths could be exercised for real.
- Memory needs per model are estimates (file size x 1.15 + 0.8 GB, for a context of a few thousand tokens). Longer context needs more.

## Finding Ollama on any drive

Ordered by how much we trust the source. Detection never runs a found program; the version is read from the file's version
resource.

1. The Windows uninstall list (HKCU, HKLM, WOW6432): an entry whose name is "Ollama". Gives the install folder and the uninstaller.
2. A running `ollama.exe` / `ollama app.exe` and its path.
3. The PATH, and the default folder `%LOCALAPPDATA%\Programs\Ollama`.
4. A bounded scan of every fixed drive: well-known folder names (`Ollama`, `Program Files\Ollama`, `Programs\Ollama`, `Apps\Ollama`) and a two-level listing of each drive for a folder called "ollama". Skips Windows, Recycle Bin, node_modules, reparse points.
5. A path the user picks by hand ("Browse to ollama.exe"). The file picker is opened by the main process, so the page never supplies a path; the file must be named ollama.exe, be a real file (not a link) on a local drive, and the user confirms in a native dialog. The choice is remembered and takes priority.

Sources 1 to 3 are trusted. A hit from 4 or 5 is shown as "Found at ..." and needs the user's click ("Use this one") before the app
will ever run it. The chosen folder is saved. A saved folder is re-checked every time (file exists, still named ollama.exe).

## Controls

- **Start**: runs `ollama.exe serve` from the chosen folder, hidden, no console, output discarded; waits up to 20 s for the API.
  If a server already answers, nothing is started.
- **Stop**: ends only processes that (a) are named ollama.exe or ollama app.exe and (b) run from the chosen folder, tray app first
  so it does not restart the server, children included. Then checks the API stopped answering.
- If the app started it, it stops it when the app quits. A server that was already running is left alone.
- Optional setting "start when the app opens", only if an agent uses a local model. Off by default.

## Models

- Downloaded models come from `/api/tags`; "loaded now" and the memory in use come from `/api/ps`.
- Each shows disk size, estimated memory, and the fit badge. Delete uses `/api/delete` after a confirmation.
- Download uses `/api/pull` with progress. One download at a time. Cancel closes the connection (Ollama resumes partial downloads
  later). Refused if the models drive has less free space than the download needs plus margin. Names from the catalog only,
  plus an "add by name" field limited to `name` or `namespace/name`, with an optional `:tag` (no third-party registry hosts).
- Catalog: a table in `shared/ollama.ts` with name, tag, size, whether the model advertises tools, a note, and a "checked" date.
  Easy to update, like the Meshy credit table.

## Fit badge

Inputs: RAM (OS), GPU names and VRAM (nvidia-smi; for other cards the 64-bit memory size in the display-adapter registry key;
otherwise unknown), and the estimated memory.

- **Fits on GPU**: estimate <= 90% of the largest GPU's VRAM.
- **Fits in RAM (slower)**: otherwise, estimate <= 80% of total RAM. Ollama may still put some layers on the GPU.
- **Too big**: neither.
- **Unknown**: hardware could not be read.

## Update, install, uninstall

All three go through a confirmation that shows exactly what will happen, issued as a one-time token (2 minutes) so what was shown
is what runs.

- **Check for update**: only when clicked. One request to the GitHub release API. Compares versions numerically.
- **Update / Install**: the installer is downloaded from the release asset (https, `github.com` or `*.githubusercontent.com`,
  redirects re-checked), size and SHA-256 checked against the release's own digest, then its Authenticode signature is read.
  The popup then shows "ready: hash verified, signature: X" and a **Run installer** button. A bad signature (not trusted, hash
  mismatch) blocks it; "not signed" is allowed with a visible warning. The installer shows its own windows. Optional install
  folder (passed as `/DIR`).
- **Uninstall**: the confirmation lists the agents that use a local model (they are reset to their normal tier afterwards) and has
  a checkbox, ticked by default, "also delete downloaded models (N GB, cannot be undone)". The Ollama server is stopped, the
  registered uninstaller is run (its own window), and only when the uninstall entry is gone are the models deleted. The models
  folder is deleted only if it passes strict checks (absolute, not a drive root, not a link, contains `manifests` and `blobs`,
  is the `.ollama\models` folder or the folder named by `OLLAMA_MODELS`). The rest of `.ollama` (keys, history) is kept.

## Security

- Every action starts from a click in this popup. Agents have no tool for any of it.
- The renderer sends only validated arguments (model names, tokens, booleans). It never sends paths to run; a path is only ever
  one the main process found, or one chosen in a folder picker.
- API calls go only to the loopback address. Replies are untrusted data.
- Downloads: https, host allowlist, size and hash checks. No credentials are sent anywhere.
- Process control and deletion are limited to verified paths, as above.

## Integration with agents

Installed models appear in an agent's model list under "Open source (local)" (that list already reads the local server). The
popup shows whether the local address is saved; without it the app stays in Mock mode, and a button saves the default address.
The existing rule stays: local models default to tools off, switchable per model.

## Tests

- Unit: version parsing and compare, memory estimate, fit rules, catalog sanity, name validation.
- Manager with a fake system (drives, registry, processes, files) and a fake Ollama server: detection order and trust, a planted
  folder is not run, start/stop only touch verified processes, models listing, pull with progress and cancel, disk-space refusal,
  delete, update compare, installer download with wrong hash / wrong host / bad redirect, uninstall flow and the models-folder
  safety checks, agent reset.
- Real machine, read-only: drive scan, GPU and RAM reading, "not installed" display (Ollama is not installed here).
- Self-test: the button opens the popup; sections, badges and buttons render; Escape closes.

## Changes made after review

Two independent reviews (correctness and security) found real problems; these were fixed and have tests:

- The main process asks again, in its own native dialog, before it uses a found copy, runs the installer, or uninstalls. The text is
  built by the main process from the real folder and choices, so the page cannot change what the user agrees to.
- A saved folder counts only if something else also points at it (uninstall list, default folder, running copy, PATH, scan), so a
  folder written into the settings file or a restored backup is ignored.
- A failed read of the uninstall list is "don't know", never "uninstalled"; two clean reads in a row are needed. A "Stop waiting"
  button ends the wait if the uninstaller was closed.
- The models folder is deleted only after comparing real paths (so short names, links in a parent folder and network paths cannot
  hide what is being removed), and only if it is named `models` or holds model files.
- Servers and installers are started with the app's environment minus anything that looks like a secret, and the server gets the
  models folder the panel shows. Windows programs are started by full path, not by bare name.
- Installer path with a space (the app's data folder is "Ronin Council"): Node would hand the installer a split command line when
  arguments are verbatim. Quoting the program path ourselves fixes it, checked on this machine.
- Replies from the Ollama port are size-limited; an installer exit code other than 0 is reported; a release older than the
  installed version is never offered; downloaded installers are removed after they run.
- A model can be deleted whenever Ollama lists it, even if its name could not be used for a download.

Known limits (not fixed, on purpose):

- The installer's digital signature is checked but the publisher name is not pinned, because Ollama was not installed on the
  development machine to read the real one. An unsigned installer is allowed with a visible warning; the SHA-256 from the release
  still has to match. The fingerprint and the file come from the same GitHub release, so it protects against corruption and a bad
  mirror, not against a compromised release.
- `ollama.exe` and its uninstaller are trusted by where they are (registry, default folder, a copy you chose), not by signature. A
  program that can already write to your user folders could swap them, which it could do anyway.
- Ollama on a non-default port (`OLLAMA_HOST`) is not supported; the panel always uses 127.0.0.1:11434.
- If you installed Ollama yourself and it was installed for all users with a different uninstaller, "Uninstall" is not offered and
  the panel points you to Windows Settings, Apps.
