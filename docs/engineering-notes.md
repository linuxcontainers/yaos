# Engineering notes

This document explains the main architecture choices and recent hardening work in Vault CRDT Sync.

It is not a user guide. It is a developer-facing summary of what changed, why it changed, and which tradeoffs are intentional.

## Recent hardening changes

### Diffing no longer uses a quadratic DP matrix

The old diff implementation built a full `O(N*M)` dynamic-programming table for large edits. That was risky on the Obsidian client because a large note could stall the UI thread or blow up memory on mobile.

The plugin now uses `fast-diff`:

- synchronous and small
- based on a proven diff algorithm rather than a custom LCS implementation
- preserves localized edits better than a destructive whole-document replace

This keeps `applyDiffToYText(...)` atomic while removing the old matrix-sized memory spike.

### Disk self-event suppression is now state-acknowledged

The original disk write suppression model used `path + TTL` to guess whether a vault event came from our own write.

That was acceptable as a heuristic, but it meant the answer to "is this event ours?" was still mostly time-based.

The write path now records an expected fingerprint for the exact content we wrote. On vault `create` / `modify`, the plugin only suppresses the event if the observed file content matches that expected write.

That means:

- timing still exists as a cleanup window
- ownership for write suppression is now based on observed state, not just elapsed time

Delete suppression is still a narrower heuristic exception, because there is no file content left to acknowledge after a delete.

### Plugin persistence writes are serialized

The plugin persists several pieces of state into `data.json`:

- settings
- disk index
- blob hash cache
- persisted blob transfer queue

Those saves originally used separate `loadData() -> merge -> saveData()` paths, which could clobber each other if they interleaved.

The plugin now routes these writes through one serialized persistence chain. This prevents settings writes, queue persistence, and disk-index saves from stomping on each other.

### HTTP auth moved to `Authorization: Bearer`

For HTTP endpoints, the client now sends:

- `Authorization: Bearer <token>`

instead of putting the token in the query string.

This avoids leaking the shared token into:

- logs
- browser history
- proxies / analytics tooling

The server still accepts `?token=` as a compatibility fallback for HTTP during rollout, and WebSocket bootstrap still uses `?token=` because browser WebSocket APIs do not provide a clean way to attach custom headers to the initial upgrade request.

### Server fan-out is bounded for Cloudflare

The server used to use unbounded `Promise.all(...)` fan-out for some R2-heavy paths.

That is a poor fit for Cloudflare Workers because:

- a Worker invocation only gets 6 simultaneous open connections
- R2 `head()`, `get()`, `put()`, `delete()`, and `list()` count toward that limit
- large scatter/gather bursts can consume subrequest budget and create connection pressure

The server now uses a small concurrency-limited worker pool (`4` concurrent operations) for:

- blob existence checks
- snapshot index fetches

This is intentionally below Cloudflare's 6-connection ceiling so the request still has headroom for other work.

### Blob upload size is capped server-side

The plugin already had client-side attachment size limits.

The server now enforces a hard max upload size for `/blob/presign-put`:

- `10 MB`

This matches the plugin's default attachment policy and prevents accidental giant uploads from turning into R2 cost surprises or needless bandwidth churn.

This cap applies to blob attachments, not to the live CRDT websocket stream and not to server-side snapshot creation.

### Snapshot IDs and XML parsing were hardened

Two small but worthwhile server fixes:

- snapshot IDs no longer use `Math.random()`; they now use cryptographic randomness
- R2 XML listing no longer uses regex extraction; it now uses `fast-xml-parser`

These changes make snapshot handling more robust without changing the external API.

### CI now runs the real local regression suite

CI and release workflows now do more than "build succeeds".

They run:

- plugin build
- the local deterministic regression suite
- server typecheck

That means CI now checks the logic we actually rely on, instead of only proving that the bundle compiles.

### Build inputs are pinned for reproducibility

Two small reproducibility improvements:

- CI now uses Node 20 LTS instead of Node 22
- the `obsidian` dependency is pinned to a known-good version instead of `"latest"`

This reduces "works yesterday, fails today" drift.

## Current operational limits and intentional tradeoffs

### The vault lives in one `Y.Doc`

The current architecture uses one shared `Y.Doc` for:

- file metadata
- blob references
- all markdown `Y.Text` values

This is intentional.

For small and medium personal vaults, this gives:

- simple synchronization semantics
- strong real-time collaboration behavior
- easy snapshotting

The tradeoff is that this design has a scaling ceiling. Very large or long-lived vaults will eventually pay more in startup cost and memory because CRDT state is centralized.

This is a known architectural limit, not an accidental oversight.

It is not being changed right now because sharding the CRDT would be a major, high-risk rewrite with much more complex consistency boundaries.

### Tombstones are retained on purpose

Markdown tombstones are intentionally kept so stale offline clients do not resurrect deleted paths.

That means:

- deletes remain safe across reconnects
- tombstone lookups are not the absolute cheapest possible path

This is a deliberate correctness tradeoff. Any future tombstone compaction work must preserve the anti-resurrection guarantee.

### The blob queues are still simple by design

The attachment upload/download queues still use a relatively simple batch-based model.

This is not the same risk level as the old disk-write concurrency hole, because:

- disk writes now have a universal per-path lock
- blob sync is primarily a throughput/backpressure concern, not a core text-correctness concern

A more advanced worker-pool scheduler may happen later, but it is intentionally not part of the current hardening pass because queue refactors are easy places to introduce subtle retry and resume bugs.

### `y-indexeddb` internal access remains a contained wart

The plugin still reaches into a private `y-indexeddb` internal (`_db`) to detect IndexedDB startup failure reliably.

This is not ideal, but it is currently the most practical way to preserve the plugin's safety guarantees around local persistence startup.

The important constraint is that this hack should stay isolated and obvious so it can be replaced or updated if the upstream library changes.

## Why the current architecture is still the right one

This plugin is optimized for:

- personal or small-team note vaults
- real-time text collaboration
- local-first editing

It is not trying to be a generic "sync any arbitrary 50 GB filesystem forever" engine.

That is why some design choices are intentionally different from file-pushing sync tools:

- text lives in CRDTs, not last-writer-wins file copies
- attachments are content-addressed in object storage
- snapshots capture CRDT state directly

That gives better collaboration ergonomics for normal note-taking workloads.

The known ceiling is very large vault scale.

The key point is that architecture only makes sense relative to the constraints it is optimizing for.
This plugin is not "a better Obsidian Sync" in the abstract. It is a different architecture aimed at a different workload.

## Why the single `Y.Doc` is reasonable here

For a typical personal or small-team note vault, a single shared `Y.Doc` is a practical tradeoff:

- it gives real-time, character-level conflict resolution across the whole vault
- it keeps the sync model simple: one CRDT state graph, one websocket room, one persistence layer
- it avoids layering a collaborative model on top of a file-pushing protocol that was never designed for that job

That is why this plugin feels more like a local-first collaborative editor and less like a traditional "sync files around and hope conflicts are rare" tool.

## Why Obsidian itself cannot optimize the same way

An official sync product has to support a much broader range of users, including extremely large vaults with huge numbers of generated files and attachments.

That changes the constraints completely:

- a monolithic in-memory CRDT for a very large vault can become expensive in RAM and startup time, especially on mobile
- file-level syncing has a simpler memory ceiling because each file can be treated independently
- the tradeoff is worse collaboration ergonomics, because file-level tools rely on coarse conflict handling instead of structured merge semantics

In other words, a file-pushing sync engine scales farther, but it gives up the collaboration behavior this plugin is optimized for.

## The Apple Notes comparison

Apple Notes also solves this by narrowing the scope of its collaborative state.

At a high level, the model is closer to:

- local-first database storage for note lists, folders, and metadata
- richer merge logic for note content itself
- simpler timestamp-style conflict handling for metadata
- aggressive pruning of old sync state once the server has acknowledged it

That is the same general lesson: if you need to scale to very large collections safely on constrained devices, you partition the problem instead of loading one giant collaborative graph forever.

## The actual tradeoff

This plugin intentionally trades some large-vault scalability for much better real-time collaboration ergonomics in the workloads it targets.

That is a conscious choice:

- PartyKit Durable Objects hold the shared source of truth
- Yjs handles the text merge semantics
- blobs are content-addressed in R2 instead of being forced through the text CRDT

The result is a real distributed system, not a thin wrapper over file copy semantics.

The cost is that there is a hard ceiling. If this project ever needs to support very large vaults at the same reliability level, the likely next architecture is:

- shard CRDT state so each file (or small file group) has its own document
- move more folder and metadata state into a cheaper index structure

Until that scale becomes a real product requirement, the current single-`Y.Doc` design is an intentional and defensible tradeoff.

## What is intentionally not "pure"

Some implementation details are pragmatic rather than academically clean:

- WebSocket auth still uses a query param because browser APIs make custom-header auth awkward there
- filesystem-facing code is intentionally mixed: markdown ingest now uses a dirty-set drain loop for backpressure-aware coalescing, while some blob paths still keep quiet-window checks because partial attachment reads are costlier than partial text reads
- some large files remain large (`main.ts`) because correctness and context locality have mattered more than artificial file splitting

These choices are intentional. The goal is to keep correctness explicit and heuristics confined to noisy edges, not to chase purity for its own sake.
