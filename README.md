# Vault CRDT Sync

Real-time Obsidian vault sync using [Yjs](https://yjs.dev/) CRDTs and [PartyKit](https://partykit.io/). Every markdown file is backed by a conflict-free replicated data type — edits merge automatically across devices with no last-write-wins conflicts.

## Features

- **Real-time sync** — Changes propagate instantly over WebSocket
- **Conflict-free** — CRDT-based merging, not last-write-wins
- **Offline-first** — Full offline support with IndexedDB persistence; syncs when reconnected
- **Attachment sync** — Images, PDFs, and other files sync via R2 object storage (optional)
- **Snapshots** — Daily automatic + on-demand backups to R2 with selective restore
- **Remote cursors** — See where collaborators are editing (optional)
- **Mobile support** — Works on Android/iOS with reconnection hardening

## Performance

The production bundle is currently about **235 KB raw / 69 KB gzipped** — small enough to stay invisible at startup.
It keeps that footprint by externalizing Obsidian and CodeMirror, so the shipped code is just the sync engine: Yjs, persistence/network bindings, fast diffing, and snapshot compression.

For the engineering rationale behind the recent hardening work (diff rewrite, persistence serialization, HTTP auth changes, server limits, and known architectural tradeoffs), see **[docs/engineering-notes.md](docs/engineering-notes.md)**.

## Requirements

- Obsidian 1.5.0+
- A sync server (see [Server setup](#server-setup))
- For attachment sync / snapshots: R2 bucket configured on the server

## Installation

### Manual install (recommended for personal use)

1. Download from the [latest release](https://github.com/kavinsood/do-sync/releases):
   - `main.js`
   - `manifest.json`
   - `styles.css`

2. Create the plugin folder in your vault:
   ```
   <vault>/.obsidian/plugins/vault-crdt-sync/
   ```

3. Copy the three files into that folder.

4. Restart Obsidian, then enable the plugin in **Settings → Community plugins**.

To update: download new release files and replace the old ones.

### Build from source

```bash
git clone https://github.com/kavinsood/do-sync.git
cd do-sync
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

## Configuration

After enabling, go to **Settings → Vault CRDT sync**:

| Setting | Description |
|---------|-------------|
| **Server host** | Your server URL (e.g., `https://sync.yourdomain.com`) |
| **Token** | Shared secret — must match `SYNC_TOKEN` on the server |
| **Vault ID** | Unique ID for this vault (auto-generated if blank). Same ID = same vault across devices. |
| **Device name** | Shown in remote cursors |

### Optional settings

| Setting | Description |
|---------|-------------|
| **Exclude patterns** | Comma-separated prefixes to skip (e.g., `templates/, .trash/`) |
| **Max file size** | Skip files larger than this (default 2 MB) |
| **Max attachment size** | Skip attachments larger than this (default 10 MB) |
| **External edit policy** | How to handle edits from git/other tools: Always, Only when closed, Never |
| **Sync attachments** | Enable R2-based sync for non-markdown files |
| **Show remote cursors** | Display collaborator cursor positions |
| **Debug logging** | Verbose console output |

Changes to host/token/vault ID require reloading the plugin.

## Commands

Access via command palette (Ctrl/Cmd+P):

| Command | Description |
|---------|-------------|
| **Reconnect to sync server** | Force reconnect after network changes |
| **Force reconcile** | Re-merge disk state with CRDT |
| **Show sync debug info** | Connection state, file counts, queue status |
| **Take snapshot now** | Create an immediate backup to R2 |
| **Browse and restore snapshots** | View snapshots, diff against current state, selective restore |
| **Reset local cache** | Clear IndexedDB, re-sync from server |
| **Nuclear reset** | Wipe all CRDT state everywhere, re-seed from disk |

## Snapshots

Snapshots are point-in-time backups of your vault's CRDT state, stored in R2.

- **Daily automatic**: A snapshot is taken automatically once per day when Obsidian opens
- **On-demand**: Use "Take snapshot now" before risky operations (AI refactors, bulk edits)
- **Selective restore**: Browse snapshots, see a diff of what changed, restore individual files
- **Undelete**: Restore files that were deleted since the snapshot
- **Pre-restore backup**: Before restoring, current file content is saved to `.obsidian/plugins/vault-crdt-sync/restore-backups/`

Requires R2 to be configured on the server.

## Mobile (Android/iOS)

The plugin works on mobile with some considerations:

- **Reconnection**: Automatically reconnects when the app resumes from background
- **Battery**: Reduce "Concurrent transfers" in settings to lower battery use during attachment sync
- **Large vaults**: Initial sync may take longer; subsequent syncs are incremental
- **Offline**: Full offline editing works; changes sync when back online

If sync seems stuck after switching networks, use "Reconnect to sync server" from the command palette.

## Server setup

The plugin needs a PartyKit server. See **[server/README.md](server/README.md)** for:

- Local development setup
- Deploy to PartyKit (managed hosting)
- Deploy to your own Cloudflare account
- R2 bucket setup for attachments and snapshots
- Secret management and rotation
- Server-side limits and hardening behavior

## How it works

1. Each markdown file gets a stable ID and a `Y.Text` CRDT for its content
2. Today, those per-file `Y.Text` values live inside one shared vault-level `Y.Doc`, which keeps collaboration simple and fast for normal-sized note vaults
3. Local markdown filesystem events are coalesced by path and drained into the CRDT at I/O speed, so bursty create/modify storms do not trigger one import per event
4. Live editor edits flow through the Yjs binding to that shared document
5. The PartyKit server relays updates to all connected devices
6. Updates are persisted in Durable Object storage (survives server restarts)
7. Offline edits are stored in IndexedDB and sync on reconnect
8. Attachments sync separately via content-addressed R2 storage

## Releasing

Releases are automated. To cut a release:

```bash
npm version patch  # or minor/major
git push --follow-tags
```

The workflow builds and attaches `main.js`, `manifest.json`, `styles.css` to a GitHub Release.

## Troubleshooting

**"Unauthorized" errors**: Token mismatch between plugin and server. Check both match exactly.

**"R2 not configured"**: Server doesn't have R2 env vars. See server README for setup.

**Sync stops on mobile**: Use "Reconnect to sync server" command. Check you have network connectivity.

**Files not syncing**: Check exclude patterns. Files over max size are skipped. Use debug logging to see what's happening.

**Conflicts after offline edits**: CRDTs merge automatically but the result depends on operation order. Review merged content if needed.

## License

[0-BSD](LICENSE)
