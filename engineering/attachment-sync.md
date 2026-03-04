# Attachment Sync: Content-Addressing and Bounded Fan-Out

Markdown text belong in the CRDT. Images, PDFs and other binary file-types are handled via a separate, content-addressed blob synchronization pipeline backed by Cloudflare R2 object storage.

### The Framework Migration: PartyKit to Native Workers

The first version of YAOS was built on Partykit. PartyKit provided an incredible early abstraction - it wrapped Cloudflare's complex Durable Objects behind a simple "Room" API and made real-time multiplayer trivially easy to bootstrap.

Partykit supports deploying to your own Cloudflare account, so you control your data, the server, and Cloudflare's generous limits should easily cover a personal usecase.

However the deployment works through their proprietary CLI. The problem is that running partykit inside a wrangler based project is not supported at this time, so you cannot set-up a "One Click Deployment" for users. They must login through partykit-cli to deploy.

This violated our core onboarding goal: Zero-terminal, consumer-grade self-hosting.

To unlock Cloudflare's magical "Deploy to Cloudflare" one-click button, we stripped out the PartyKit framework and ported the entire transport layer to raw Cloudflare Workers using y-partyserver. This allowed us to define the entire infrastructure (Workers, Durable Objects, and Storage) in a standard wrangler.toml file, eliminating the CLI entirely.

Cloudflare acquired Partykit in 2024. They didn't buy it to keep maintaining a separate partykit deploy CLI wrapper. They bought it to rip out the underlying Durable Objects synchronization math and bake it natively into Cloudflare Workers.

That is exactly what `partyserver` and `y-partyserver` are. They are the native, officially supported Cloudflare Worker libraries.

The fact that PartyKit's old docs still say "Run inside a wrangler project: Future Development" is just typical documentation rot. The marketing site is abandoned, but the engineering team has already shipped the replacement on npm.

### The Native Worker Proxy

Earlier iterations of YAOS used a complex two-phase commit involving S3 presigned URLs, because PartyKit's managed infrastructure obscured the underlying Cloudflare bindings, our server could not natively talk to our R2 storage bucket. We had to treat R2 like a generic external AWS S3 bucket.

The client would ask the server for permission, the server would cryptographically sign an AWS S3 fetch URL, and the client would talk directly to the bucket.

We deleted that brittle state machine. YAOS now utilizes direct native R2 bindings inside the Cloudflare Worker. The client computes the SHA-256 hash of the file and does a simple authenticated `PUT` directly to the Worker. The Worker then natively proxies the bytes to `env.YAOS_BUCKET`.

This native proxy approach drastically simplifies the client logic, eliminates the need for external `aws4fetch` signing libraries, and completely removes the need to parse S3 XML responses.

![Attachment upload lifecycle: presigned S3 flow vs native Worker proxy](./diagrams/attachment-upload-lifecycle-presigned-s3-flow-vs-native-worker-proxy.webp)

### The Credit Card Wall (Optional R2 Provisioning)

Because YAOS utilizes native `wrangler.toml` bindings, Cloudflare can automatically provision Durable Objects and R2 buckets upon deployment. This enables the holy  one-click "Deploy to Cloudflare" button.

However, we made the intentional product decision **not** to force the R2 bucket binding in the default deployment template.

While R2 has a generous free tier, Cloudflare enforces a strict requirement: users must have a primary payment method (credit card) on file to provision an R2 bucket. If YAOS required this binding by default, the "Deploy to Cloudflare" button would fail for any user without a configured billing profile, hampering our slick "One Click Deployment".

Instead, YAOS degrades gracefully. The default deployment provisions only the text-sync CRDT engine. The server exposes a `/api/capabilities` endpoint. If the R2 bucket is unbound, the server reports `{ attachments: false }`, and the Obsidian plugin cleanly disables the attachment sync UI. Power users can explicitly enable R2 later via the Cloudflare Dashboard in **one-step (Just add an R2 binding to the Worker)** to unlock attachment and snapshot capabilities.

### Bounding the Cloudflare Fan-Out

When checking which blobs already exist in R2 (to achieve content-addressed deduplication), the naive approach is to use an unbounded `Promise.all(...)` fan-out to check multiple hashes at once.

This is an anti-pattern for Cloudflare Workers. A single Worker invocation is strictly limited to 6 simultaneous open connections. Native R2 operations—including `head()`, `get()`, `put()`, `delete()`, and `list()`—all count toward that absolute ceiling. Unbounded scatter/gather bursts consume the subrequest budget, create massive connection pressure, and cause the Worker to crash.

To solve this, YAOS uses a strict, concurrency-limited worker pool. Concurrent R2 operations are capped at 4. This intentionally sits below Cloudflare's 6-connection ceiling, ensuring the Worker always maintains headroom for other concurrent tasks and gracefully handles high-volume existence checks without dropping requests.

### The Block-Level Chunking Trap

I really like how Dropbox and Onedrive do block-level file sync. 

Imagine you had a 50 MB PDF, and you open it to read, and you make one highlight. The file is updated, so it has to be uploaded to the server. If we chunked a 50MB PDF into 50 separate 1MB blobs (actually, the blocks are much smaller, like 4KB) in R2, we would only have to upload the modified chunks when the file changes. However, this introduces a massive architectural burden: **Distributed Garbage Collection**.

If a user deletes or modifies that PDF, the server must track which of those 1MB chunks are now orphaned and which are still actively shared by other files in the vault. We would have to build a highly-available Reference Counting Garbage Collector. A single race condition in the GC would permanently corrupt users' files by deleting a chunk that is still in use.

Moreover, building this in JS would be really inefficient. Bandwidth is cheap; distributed garbage collection is a nightmare. Instead, YAOS uses standard Last-Writer-Wins full file overwrites.

![Why YAOS avoids block-level chunking](./diagrams/why-yaos-avoids-block-level-chunking.webp)

### Hardened Upload Limits and Integrity

To protect the server infrastructure and prevent accidental giant uploads from generating needless bandwidth churn, the server enforces a hard maximum upload size of 10 MB on the Worker proxy route. This explicitly matches the plugin's default attachment policy. (This cap applies exclusively to blob attachments, not to the live CRDT WebSocket stream or server-side snapshot creation). This can be easily increased.

Finally, to ensure absolute integrity of the snapshot safety net, snapshot IDs are generated using cryptographic randomness rather than predictable `Math.random()` calls.

## Snapshot Semantics and The Recovery Model

Sync is nice. Recovery is the real reason you self-host your data.

Obsidian's local File Recovery plugin is excellent for small "oops" moments (like accidentally deleting a paragraph). YAOS does not try to replace it. YAOS snapshots are designed for catastrophic recovery: "I accidentally wiped my folder structure and need to intelligently restore the vault to yesterday's state."

Snapshots are the operational safety-net for the CRDT graph, not a second attachment transport. YAOS serializes the full Y.Doc state, gzips the payload, and writes two objects to R2:
- crdt.bin.gz (the compressed CRDT state)
- index.json (snapshot metadata and blob references)

The key design point: Snapshot creation does not duplicate blob bytes.

If snapshots copied full binary payloads each time, a daily snapshot would explode storage costs for vaults with large static media. Instead, the index.json acts as a point-in-time manifest. It records the content hashes currently referenced by the CRDT (pathToBlob). Because R2 attachments are content-addressed, this provides inherent deduplication.

At restore time, the CRDT state is authoritative. The plugin applies the restored graph, reconstructing the exact folder structure and text, and then reconciles attachment files by pulling the missing hash pointers from R2.

A few invariants keep this model correct under failure:
- Snapshot IDs are generated using cryptographic randomness, not Math.random().
- Snapshot operations share the exact same storage substrate as blob sync. If R2 is unbound, snapshots are disabled entirely (snapshots: false), preventing ambiguous recovery guarantees.
- Missing blob objects during restore are surfaced as localized data gaps, not silent structural failures.

The result is a system where text collaboration remains real-time and cheap, attachment sync remains content-addressed, and snapshots provide deterministic vault recovery without introducing a second complex storage engine.
