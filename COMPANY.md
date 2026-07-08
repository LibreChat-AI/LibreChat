# Company Customizations & Maintenance Guide

This fork of [LibreChat](https://github.com/danny-avila/LibreChat) carries company-specific
changes. This file is the **single source of truth** for what we changed and how to keep the
fork up to date with upstream. Every code customization carries a `// company:` marker comment
pointing back here — search the codebase for `company:` to find them all.

Baseline (branch `company/v0.8.7`): the official **v0.8.7 release tag** (`9e74cc0e5`).
Note: upstream rewrote the drag/paste upload plumbing after v0.8.7 (a shared
`getViableUploadOptions` chokepoint). On this branch the same policies are implemented in the
v0.8.7 structure instead (inline logic in `DragDropModal`, `useDragHelpers`, `useTextarea`).
A reference implementation on the newer structure exists on the `main` branch (commits
`b3ddb96d3` + `89e8a6b02`) — prefer porting to that shape when syncing to v0.8.8+.

---

## 1. Customization inventory

Spec reference: internal requirements #5 (upload menu) and #6 (version control process).

| # | File | Change | Spec | Re-apply guidance on merge conflict |
|---|------|--------|------|-------------------------------------|
| 1 | `librechat.yaml` (new, committed) | The live company config. Agents `capabilities` deliberately trimmed to `deferred_tools, execute_code, file_search, actions, tools` — this removes "Upload as Text" (`context`, spec 5.1) AND disables web search, artifacts, subagents, skills, memory, chain, and OCR (company decision, 2026-07-08). Contains the File Search kill-switch (spec 5.2). Also activates the example interface settings (custom welcome, ToS modal), example custom endpoints (groq, Mistral, OpenRouter, Helicone, Portkey, Claude-Compatible), and agents settings (recursionLimit 50, etc.). | 5.1, 5.2 | Company-owned file; upstream never touches it (upstream gitignores it). Review new upstream capabilities on sync and add deliberately — never `context`. |
| 1b | `.gitignore` | Removed the `librechat.yaml` ignore line so the live config is committed and ships with the fork. | 5.1, 5.2 | Re-apply the one-line removal (marked `# company:`). |
| 2 | `client/src/locales/en/translation.json` | Added keys `com_ui_add_files` ("Add Files"), `com_ui_add_photos` ("Add Photos"), and `com_error_files_unsupported` ("This file type can't be attached here." — same key/value upstream added after v0.8.7, so it merges cleanly on sync). | 5.3, 5.4 | Take both sides; our keys are alphabetically placed. |
| 3 | `client/src/components/Chat/Input/Files/AttachFileMenu.tsx` | (a) Upstream's provider/image if-else replaced by a single unconditional **"Add Photos"** item that always opens an images-only picker (`onAction('image')`); dead provider-detection locals and imports removed. (b) `handleUploadClick`: permissive-MIME endpoints may not widen the `image` accept filter. (c) Code Interpreter item label → `com_ui_add_files`. (d) File Search / Add Files gating: in ephemeral (non-saved-agent) chats they are offerable even when the per-chat tool toggles are off (upstream hides them until toggled); saved agents still gate on their actual tools. | 5.1, 5.3, 5.4 | Take upstream's structure, then re-apply the four `// company:` marked edits. This region is upstream-active — expect conflicts here first. |
| 4 | `client/src/components/Chat/Input/Files/DragDropModal.tsx` | Upstream's provider/image option branching replaced by a single **"Add Photos"** option whose `condition` requires all dropped files to be images; Code option label → `com_ui_add_files`; File Search/Code gating gets the same ephemeral-offerable rule as the attach menu. | 5.1, 5.3, 5.4 | Re-apply the `// company:` marked edits. Upstream rewrote this file after v0.8.7 — on sync, port the policy to the new structure (see `main` branch reference). |
| 5 | `client/src/hooks/Files/useDragHelpers.ts` | The no-modal fallback used to route non-image files directly to the provider; it now shows the `com_error_files_unsupported` toast instead (provider attachments are images-only). | 5.1, 5.4 | Re-apply the marked edit in `handleDrop`'s `!shouldShowModal` branch. |
| 5b | `client/src/hooks/Input/useTextarea.ts` | Pasted clipboard files are filtered to images before upload; non-image pastes show the `com_error_files_unsupported` toast. | 5.1, 5.4 | Re-apply the marked filter in `handlePaste`. |
| 6 | `client/src/components/Chat/Input/Files/__tests__/AttachFileMenu.spec.tsx` | Rewritten for the single "Add Photos" item; Code Interpreter assertions expect "Add Files". | tests | If upstream rewrites the suite, port our label expectations. |
| 7 | `e2e/specs/mock/chat.spec.ts` | Menu locator "Upload to Provider" → "Add Photos". | tests | Same as above. |

**Invariants**
- `context` must never be re-added to `capabilities` in `librechat.yaml`.
- `com_ui_add_files` / `com_ui_add_photos` are company-owned locale keys; never rename to upstream keys.
- Agent-builder side panels intentionally keep upstream labels ("Upload for File Search", "Upload to Code Environment") — only the chat attach surfaces are renamed.

**Known accepted side effects**
- Removing the `context` capability also hides the agent-builder "File Context" panel, and any imported agents with existing context files would stop injecting them (fresh deployment: none exist).
- The images-only restriction is client-side UX; a crafted API request can still upload other types. Server hardening was deliberately skipped to keep zero server diff.

## 2. Configuration

- The live config is **`librechat.yaml` at the repo root** — the server loads it by default
  (no `CONFIG_PATH` needed). Upstream gitignores this file; our fork removed that ignore line
  so the config is committed and shared.
- Config changes need a **backend restart only** — no client rebuild.
- **File Search kill-switch (spec 5.2):** when the Code Interpreter API is deployed, delete
  `"file_search"` from the `endpoints.agents.capabilities` list in `librechat.yaml` and restart
  the backend. "Upload for File Search" disappears from the attach menu and drag/paste modal
  (and the agent-builder File Search panel — expected). Restore + restart to bring it back.
- The capabilities list is intentionally lean (see inventory row 1): web search, artifacts,
  subagents, skills, memory, chain, and OCR are disabled deployment-wide in addition to
  `context`.

## 3. Version control process (spec #6)

### Remote layout
| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `https://github.com/COMPANY_ORG/librechat.git` *(placeholder — update when created)* | Company repo; protected `main` |
| `upstream` | `https://github.com/danny-avila/LibreChat.git` | Open-source LibreChat; read-only |

One-time setup on a fresh clone of the company repo:
```bash
git remote add upstream https://github.com/danny-avila/LibreChat.git
git fetch upstream --tags
```

### Branch model
- `main` — company mainline (what UAT/prod deploys). Protected; changes land via PR.
- `feat/*`, `fix/*` — short-lived feature branches off `main`.
- `chore/upstream-sync-vX.Y.Z` — upstream merge branches (below).

### Merging upstream updates (per upstream release)
```bash
git fetch upstream --tags
git checkout -b chore/upstream-sync-vX.Y.Z main
git merge vX.Y.Z            # merge the release TAG; never rebase main onto upstream
# resolve conflicts — expected ONLY in files listed in the inventory above
npm ci
npm run frontend            # full build must pass
npm run test:client         # client suite must pass
git push origin chore/upstream-sync-vX.Y.Z
# open PR into main; merge with a MERGE COMMIT (never squash — squashing discards the
# recorded merge base and re-conflicts every future sync)
```

Conflict resolution rules:
1. `client/src/locales/en/translation.json` — take both sides (our two keys + upstream's changes).
2. Customized components (`AttachFileMenu.tsx`, `DragDropModal.tsx`, `useDragHelpers.ts`,
   `useTextarea.ts`) — take upstream's structure first, then re-apply the `// company:` marked
   edits per the inventory.
3. Anything else conflicting means upstream touched an area we haven't customized — resolve
   normally, favoring upstream.
4. After any sync, run the verification checklist (section 4).

### Commit policy
- Commit messages describe the change only. **No Co-Authored-By or attribution trailers.**
- Track upstream **release tags**, not upstream `main`, for predictable, changelog-backed syncs.

## 4. Verification checklist (after any sync or upload-UX change)

1. `npm run test:client` — green.
2. Attach "+" menu shows exactly: **Add Photos**, **Upload for File Search** (until 5.2 flip), **Add Files**. No "Upload as Text", no "Upload to Provider".
3. "Add Photos" file picker accepts images only (input `accept="image/*,.heif,.heic"`), including on permissive custom endpoints.
4. Drag a PDF into the chat → modal offers only File Search / Add Files. Drag a PNG → "Add Photos" offered. Pasting a non-image file shows the "can't be attached here" toast; pasting an image uploads it.
5. Agent builder: File Search / Code panels keep upstream labels; File Context panel absent.
6. Kill-switch drill (config only, no rebuild): remove `- "file_search"` → restart backend → hard refresh → option gone; restore → returns.
