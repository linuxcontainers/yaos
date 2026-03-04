The client-side attachment (blob) upload and download queues intentionally use a simple batch-based model.

If a user uploads a 50MB video and a 50KB image in the same batch, the image file waits for the video to finish before the *next* batch can start.

It's dumb, but it's better than building an asynchronous lock-free worker pool with exponential backoff and persistent state reconciliation. These are notorious for introducing subtle retry and resume bugs.

Because disk writes now run through a universal per-path lock, blob sync is primarily a throughput and backpressure concern, not a core text-correctness concern.

We use the network bandwidth slightly less efficiently because of batch boundaries, though

- It doesn't permanently leak concurrency slots.
- It doesn't create race conditions between the in-memory queue and the IndexedDB persisted state.
- It doesn't re-order operations in a way that breaks your expected timeline.

This can be worked on, if we care about high blob I/O.
