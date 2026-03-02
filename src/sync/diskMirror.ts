import { type App, arrayBufferToHex, MarkdownView, TFile, normalizePath } from "obsidian";
import * as Y from "yjs";
import type { VaultSync } from "./vaultSync";
import type { EditorBindingManager } from "./editorBinding";
import { ORIGIN_SEED } from "../types";
import { ORIGIN_RESTORE } from "./snapshotClient";
import type { TraceRecord } from "../debug/trace";

/**
 * Handles writeback from Y.Text -> disk with:
 *   - Remote-only writes (skip local yCollab/seed/disk-sync origins)
 *   - Lazy per-file Y.Text observers
 *   - Concurrency-limited write queue (prevents burst I/O on git pull)
 *   - Loop suppression via timed path suppression
 */

const DEBOUNCE_MS = 300;
const DEBOUNCE_BURST_MS = 1000;
const OPEN_FILE_IDLE_MS = 1500;
const OPEN_FILE_ACTIVE_GRACE_MS = 1200;
const SUPPRESS_MS = 500;
const MAX_CONCURRENT_WRITES = 5;
const BURST_THRESHOLD = 20;

/** String origins that should NOT trigger a disk write. */
const LOCAL_STRING_ORIGINS = new Set([
	ORIGIN_SEED,
	"disk-sync",
	ORIGIN_RESTORE,
]);

/**
 * Determine whether a Yjs transaction origin is local (should NOT trigger
 * a disk write).
 *
 * The sync provider applies remote updates with `transactionOrigin = provider`.
 * y-codemirror applies local editor updates with `transactionOrigin = YSyncConfig`.
 *
 * We only treat provider-origin transactions as remote.
 */
function isLocalOrigin(origin: unknown, provider: unknown): boolean {
	if (origin === provider) return false; // remote update from server
	if (typeof origin === "string") return LOCAL_STRING_ORIGINS.has(origin);
	if (origin == null) return true; // local transact() without explicit origin
	// Non-null object origins (e.g. y-codemirror's YSyncConfig) are local.
	return true;
}

function describeOrigin(origin: unknown, provider: unknown): string {
	if (origin === provider) return "provider-remote";
	if (typeof origin === "string") return origin;
	if (origin == null) return "null";
	if (typeof origin === "object") {
		const constructorName =
			(origin as { constructor?: { name?: string } }).constructor?.name;
		return constructorName || "object";
	}
	return String(origin);
}

interface SuppressionEntry {
	kind: "write" | "delete";
	expiresAt: number;
	expectedBytes?: number;
	expectedHash?: string;
}

export class DiskMirror {
	private suppressedPaths = new Map<string, SuppressionEntry>();
	private openPaths = new Set<string>();

	/** Deduped write queue. Order doesn't matter — deduplication does. */
	private writeQueue = new Set<string>();
	private forcedWritePaths = new Set<string>();
	/** Debounce timers per path. */
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private openWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private pendingOpenWrites = new Set<string>();
	/** True while the drain loop is running. */
	private draining = false;
	private drainPromise: Promise<void> | null = null;
	private pathWriteLocks = new Map<string, Promise<void>>();

	/** Per-file Y.Text observers. Only attached for open/active files. */
	private textObservers = new Map<
		string,
		{ ytext: import("yjs").Text; handler: (event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => void }
	>();

	private mapObserverCleanups: (() => void)[] = [];

	private readonly debug: boolean;

	constructor(
		private app: App,
		private vaultSync: VaultSync,
		private editorBindings: EditorBindingManager,
		debug: boolean,
		private trace?: TraceRecord,
	) {
		this.debug = debug;
	}

	// -------------------------------------------------------------------
	// Map observers (structural: add/delete)
	// -------------------------------------------------------------------

	startMapObservers(): void {
		const pathObserver = (event: import("yjs").YMapEvent<string>) => {
			event.changes.keys.forEach((change, path) => {
					if (change.action === "add" || change.action === "update") {
						if (!isLocalOrigin(event.transaction.origin, this.vaultSync.provider)) {
							this.log(`map: remote path added "${path}"`);
							if (this.openPaths.has(path)) {
								this.observeText(path);
							}
							this.scheduleWrite(path);
						}
					}
				if (change.action === "delete") {
					this.unobserveText(path);
					if (!isLocalOrigin(event.transaction.origin, this.vaultSync.provider)) {
						void this.handleRemoteDelete(path);
					}
				}
			});
		};
		this.vaultSync.pathToId.observe(pathObserver);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.pathToId.unobserve(pathObserver),
		);

		const metaObserver = (event: import("yjs").YMapEvent<import("../types").FileMeta>) => {
			event.changes.keys.forEach((change, fileId) => {
				if (change.action === "add" || change.action === "update") {
					const meta = this.vaultSync.meta.get(fileId);
					if (
						meta?.deleted &&
						!isLocalOrigin(event.transaction.origin, this.vaultSync.provider)
					) {
						void this.handleRemoteDelete(meta.path);
					}
				}
			});
		};
		this.vaultSync.meta.observe(metaObserver);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.meta.unobserve(metaObserver),
		);

		// ---------------------------------------------------------------
		// afterTransaction: catch remote content edits to CLOSED files.
		//
		// Per-file Y.Text observers only cover open files. When a remote
		// device edits a note that is closed locally, the Y.Text changes
		// in memory but nothing writes it to disk. This handler inspects
		// every non-local transaction for changed Y.Text instances,
		// reverse-maps them to paths, and schedules writes for any path
		// that doesn't already have a per-file observer (i.e. closed).
		// ---------------------------------------------------------------
		const afterTxnHandler = (txn: Y.Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;

			for (const [changedType] of txn.changed) {
				if (!(changedType instanceof Y.Text)) continue;

				// Reverse lookup: find the fileId that owns this Y.Text
				const fileId = this.findFileIdForText(changedType);
				if (!fileId) continue;

				// Map fileId → path via meta (pathToId is path→id, not id→path)
				const meta = this.vaultSync.meta.get(fileId);
				if (!meta || meta.deleted) continue;

				const path = meta.path;

					// Skip if this path is already open (handled by per-file observer policy)
					if (this.openPaths.has(path)) continue;

				this.log(`afterTxn: remote content change to closed file "${path}"`);
				this.scheduleWrite(path);
			}
		};
		this.vaultSync.ydoc.on("afterTransaction", afterTxnHandler);
		this.mapObserverCleanups.push(() =>
			this.vaultSync.ydoc.off("afterTransaction", afterTxnHandler),
		);

		this.log("Map observers started");
	}

	/**
	 * Reverse-lookup: given a Y.Text instance, find the fileId.
	 * Uses VaultSync's WeakMap for O(1) lookup, with O(n) fallback.
	 */
	private findFileIdForText(ytext: Y.Text): string | null {
		// Fast path: WeakMap lookup
		const cached = this.vaultSync.getFileIdForText(ytext);
		if (cached) return cached;

		// Slow fallback: scan idToText (should rarely happen)
		for (const [fileId, text] of this.vaultSync.idToText.entries()) {
			if (text === ytext) return fileId;
		}
		return null;
	}

	// -------------------------------------------------------------------
	// Per-file observers (lazy)
	// -------------------------------------------------------------------

	notifyFileOpened(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileOpened", { path });
		this.openPaths.add(path);
		if (this.writeQueue.delete(path)) {
			this.forcedWritePaths.delete(path);
			this.scheduleOpenWrite(path);
		}
		const closedTimer = this.debounceTimers.get(path);
		if (closedTimer) {
			clearTimeout(closedTimer);
			this.debounceTimers.delete(path);
			this.writeQueue.delete(path);
			this.scheduleOpenWrite(path);
		}
		this.observeText(path);
	}

	notifyFileClosed(path: string): void {
		path = normalizePath(path);
		this.trace?.("disk", "notifyFileClosed", { path });
		this.openPaths.delete(path);
		// Flush any pending debounce for this path
		const timer = this.debounceTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		}
		const openTimer = this.openWriteTimers.get(path);
		if (openTimer) {
			clearTimeout(openTimer);
			this.openWriteTimers.delete(path);
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, "file-closed");
		} else if (this.pendingOpenWrites.delete(path)) {
			this.queueImmediateWrite(path, "file-closed");
		}
		this.unobserveText(path);
	}

	private observeText(path: string): void {
		if (this.textObservers.has(path)) return;

		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) return;

		const handler = (_event: import("yjs").YTextEvent, txn: import("yjs").Transaction) => {
			if (isLocalOrigin(txn.origin, this.vaultSync.provider)) return;
			const originLabel = describeOrigin(txn.origin, this.vaultSync.provider);
			this.log(`text observer: remote change to "${path}" (origin=${originLabel})`);
			this.scheduleWrite(path);
		};

		ytext.observe(handler);
		this.textObservers.set(path, { ytext, handler });
		this.log(`observeText: watching "${path}" (remote-only)`);
	}

	private unobserveText(path: string): void {
		const obs = this.textObservers.get(path);
		if (obs) {
			obs.ytext.unobserve(obs.handler);
			this.textObservers.delete(path);
			this.log(`unobserveText: stopped watching "${path}"`);
		}
	}

	/** Set of currently observed paths (for external cleanup). */
	getObservedPaths(): Set<string> {
		return new Set(this.textObservers.keys());
	}

	// -------------------------------------------------------------------
	// Write scheduling (debounce + concurrency-limited queue)
	// -------------------------------------------------------------------

	scheduleWrite(path: string): void {
		path = normalizePath(path);
		if (this.openPaths.has(path)) {
			this.scheduleOpenWrite(path);
			return;
		}

		this.scheduleClosedWrite(path);
	}

	private scheduleClosedWrite(path: string): void {
		// Clear existing debounce for this path
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);

		// Use longer debounce when queue is deep (burst scenario)
		const delay = this.writeQueue.size >= BURST_THRESHOLD ? DEBOUNCE_BURST_MS : DEBOUNCE_MS;

		this.debounceTimers.set(
			path,
			setTimeout(() => {
				this.debounceTimers.delete(path);
				this.writeQueue.add(path);
				this.kickDrain();
			}, delay),
		);
	}

	private scheduleOpenWrite(path: string): void {
		this.pendingOpenWrites.add(path);

		const existing = this.openWriteTimers.get(path);
		if (existing) clearTimeout(existing);

		this.openWriteTimers.set(
			path,
			setTimeout(() => {
				this.openWriteTimers.delete(path);
				if (!this.pendingOpenWrites.has(path)) return;

				if (this.isActivelyViewedPath(path)) {
					this.log(`open-write: deferring "${path}" (active editor focused)`);
					this.scheduleOpenWrite(path);
					return;
				}

				if (this.hasRecentEditorActivity(path)) {
					this.log(`open-write: deferring "${path}" (recent editor activity)`);
					this.scheduleOpenWrite(path);
					return;
				}

				this.pendingOpenWrites.delete(path);
				this.writeQueue.add(path);
				this.kickDrain();
			}, OPEN_FILE_IDLE_MS),
		);
	}

	/** Start the drain loop if not already running. */
	private kickDrain(): Promise<void> {
		if (this.drainPromise) return this.drainPromise;
		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
		});
		return this.drainPromise;
	}

	/**
	 * Drain the write queue with bounded concurrency.
	 * Processes up to MAX_CONCURRENT_WRITES in parallel, then loops.
	 */
	private async drain(): Promise<void> {
		this.draining = true;

		try {
			while (this.writeQueue.size > 0) {
				// If the queue is very deep, log a warning and pause briefly
				if (this.writeQueue.size > BURST_THRESHOLD) {
					this.log(`drain: ${this.writeQueue.size} writes queued (burst), cooling down 200ms`);
					await new Promise((r) => setTimeout(r, 200));
				}

				// Take up to MAX_CONCURRENT_WRITES from the queue
				const batch: string[] = [];
				for (const path of this.writeQueue) {
					batch.push(path);
					if (batch.length >= MAX_CONCURRENT_WRITES) break;
				}
				for (const path of batch) {
					this.writeQueue.delete(path);
				}

				// Execute writes in parallel
				await Promise.all(
					batch.map((path) => {
						const force = this.forcedWritePaths.delete(path);
						return this.flushWrite(path, force);
					}),
				);
			}
		} finally {
			this.draining = false;
		}
	}

	// -------------------------------------------------------------------
	// Disk write
	// -------------------------------------------------------------------

	async flushWrite(path: string, force = false): Promise<void> {
		path = normalizePath(path);
		return this.runPathWriteLocked(path, () => this.flushWriteUnlocked(path, force));
	}

	private async flushWriteUnlocked(path: string, force: boolean): Promise<void> {
		const ytext = this.vaultSync.getTextForPath(path);
		if (!ytext) {
			this.log(`flushWrite: no Y.Text for "${path}", skipping`);
			return;
		}

		if (!force && this.openPaths.has(path)) {
			if (this.isActivelyViewedPath(path)) {
				this.log(`flushWrite: deferring open "${path}" (active editor focused)`);
				this.scheduleOpenWrite(path);
				return;
			}
			if (this.hasRecentEditorActivity(path)) {
				this.log(`flushWrite: deferring open "${path}" (recent editor activity)`);
				this.scheduleOpenWrite(path);
				return;
			}
		}

		const content = ytext.toString();
		const normalized = normalizePath(path);

		try {
			const existing = this.app.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) {
				const currentContent = await this.app.vault.read(existing);
				if (currentContent === content) {
					this.log(`flushWrite: "${path}" unchanged, skipping`);
					return;
				}

				await this.suppressWrite(path, content);
				await this.app.vault.modify(existing, content);
				this.log(`flushWrite: updated "${path}" (${content.length} chars)`);
			} else {
				await this.suppressWrite(path, content);
				const dir = normalized.substring(0, normalized.lastIndexOf("/"));
				if (dir) {
					const dirExists =
						this.app.vault.getAbstractFileByPath(normalizePath(dir));
					if (!dirExists) {
						await this.app.vault.createFolder(dir);
					}
				}
				await this.app.vault.create(normalized, content);
				this.log(
					`flushWrite: created "${path}" on disk (${content.length} chars)`,
				);
			}
		} catch (err) {
			console.error(`[yaos] flushWrite failed for "${path}":`, err);
		}
	}

	private async handleRemoteDelete(path: string): Promise<void> {
		const normalized = normalizePath(path);
		this.trace?.("disk", "remote-delete", {
			path,
			normalizedPath: normalized,
			wasOpen: this.openPaths.has(path),
			wasObserved: this.textObservers.has(path),
			wasSuppressed: this.isSuppressed(path),
		});
		// Unbind editor before suppressed delete so the vault `delete` event
		// (which skips unbind due to suppression) doesn't leave a stale binding.
		this.editorBindings.unbindByPath(normalized);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			try {
				this.suppressDelete(path);
				await this.app.vault.delete(file);
				this.log(`handleRemoteDelete: deleted "${path}" from disk`);
			} catch (err) {
				console.error(
					`[yaos] handleRemoteDelete failed for "${path}":`,
					err,
				);
			}
		}
	}

	// -------------------------------------------------------------------
	// Suppression
	// -------------------------------------------------------------------

	isSuppressed(path: string): boolean {
		return this.getActiveSuppression(path) !== null;
	}

	async shouldSuppressModify(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "modify");
	}

	async shouldSuppressCreate(file: TFile): Promise<boolean> {
		return this.shouldSuppressWriteEvent(file, "create");
	}

	consumeDeleteSuppression(path: string): boolean {
		path = normalizePath(path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;

		this.suppressedPaths.delete(path);
		return entry.kind === "delete";
	}

	async flushOpenWrites(reason: string): Promise<void> {
		const targets = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			targets.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			targets.add(path);
		}
		if (targets.size === 0) return;

		for (const path of targets) {
			const timer = this.openWriteTimers.get(path);
			if (timer) {
				clearTimeout(timer);
				this.openWriteTimers.delete(path);
			}
			this.pendingOpenWrites.delete(path);
			this.queueImmediateWrite(path, reason, true);
		}

		await this.kickDrain();
	}

	async flushOpenPath(path: string, reason: string): Promise<void> {
		path = normalizePath(path);
		const timer = this.openWriteTimers.get(path);
		const hadTimer = !!timer;
		if (timer) {
			clearTimeout(timer);
			this.openWriteTimers.delete(path);
		}
		const wasPending = this.pendingOpenWrites.delete(path);
		const wasQueued = this.writeQueue.has(path);
		if (!wasPending && !hadTimer && !wasQueued) {
			return;
		}
		this.queueImmediateWrite(path, reason, true);
		await this.kickDrain();
	}

	// -------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------

	get activeObserverCount(): number {
		return this.textObservers.size;
	}

	get pendingWriteCount(): number {
		return (
			this.writeQueue.size
			+ this.debounceTimers.size
			+ this.openWriteTimers.size
		);
	}

	getDebugSnapshot(): {
		observedPaths: string[];
		openPaths: string[];
		openPendingPaths: string[];
		queuedWrites: string[];
		debounceCount: number;
		openDebounceCount: number;
		suppressedCount: number;
	} {
		return {
			observedPaths: Array.from(this.textObservers.keys()),
			openPaths: Array.from(this.openPaths.keys()),
			openPendingPaths: Array.from(this.pendingOpenWrites.keys()),
			queuedWrites: Array.from(this.writeQueue.keys()),
			debounceCount: this.debounceTimers.size,
			openDebounceCount: this.openWriteTimers.size,
			suppressedCount: this.suppressedPaths.size,
		};
	}

	// -------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------

	destroy(): void {
		const pendingFinalWrites = new Set<string>();
		for (const path of this.pendingOpenWrites) {
			pendingFinalWrites.add(path);
		}
		for (const path of this.openWriteTimers.keys()) {
			pendingFinalWrites.add(path);
		}
		for (const path of pendingFinalWrites) {
			void this.flushWrite(path, true);
		}

		for (const cleanup of this.mapObserverCleanups) {
			cleanup();
		}
		this.mapObserverCleanups = [];

		for (const [, obs] of this.textObservers) {
			obs.ytext.unobserve(obs.handler);
		}
		this.textObservers.clear();

		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const timer of this.openWriteTimers.values()) {
			clearTimeout(timer);
		}
		this.openWriteTimers.clear();

		this.writeQueue.clear();
		this.pendingOpenWrites.clear();
		this.openPaths.clear();
		this.forcedWritePaths.clear();
		this.suppressedPaths.clear();
		this.pathWriteLocks.clear();
		this.log("DiskMirror destroyed");
	}

	private log(msg: string): void {
		this.trace?.("disk", msg);
		if (this.debug) {
			console.log(`[yaos:disk] ${msg}`);
		}
	}

	private hasRecentEditorActivity(path: string): boolean {
		const lastEditorActivity = this.editorBindings.getLastEditorActivityForPath(path);
		if (lastEditorActivity == null) return false;
		return Date.now() - lastEditorActivity < OPEN_FILE_ACTIVE_GRACE_MS;
	}

	private isActivelyViewedPath(path: string): boolean {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return false;
		}
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		return activeView?.file?.path === path;
	}

	private queueImmediateWrite(path: string, reason: string, force = false): void {
		path = normalizePath(path);
		if (force) {
			this.forcedWritePaths.add(path);
		}
		this.writeQueue.add(path);
		this.log(`queueImmediateWrite: "${path}" (${reason}${force ? ", forced" : ""})`);
		this.kickDrain();
	}

	private getActiveSuppression(path: string): SuppressionEntry | null {
		path = normalizePath(path);
		const entry = this.suppressedPaths.get(path);
		if (!entry) return null;
		if (Date.now() < entry.expiresAt) {
			return entry;
		}
		this.suppressedPaths.delete(path);
		return null;
	}

	private async suppressWrite(path: string, content: string): Promise<void> {
		// Record the exact content we wrote so vault modify/create events can
		// acknowledge our own write by observed state, not just timing.
		const fingerprint = await this.fingerprintContent(content);
		this.suppressedPaths.set(normalizePath(path), {
			kind: "write",
			expiresAt: Date.now() + SUPPRESS_MS,
			expectedBytes: fingerprint.bytes,
			expectedHash: fingerprint.hash,
		});
	}

	private suppressDelete(path: string): void {
		this.suppressedPaths.set(normalizePath(path), {
			kind: "delete",
			expiresAt: Date.now() + SUPPRESS_MS,
		});
	}

	private async shouldSuppressWriteEvent(
		file: TFile,
		event: "modify" | "create",
	): Promise<boolean> {
		const path = normalizePath(file.path);
		const entry = this.getActiveSuppression(path);
		if (!entry) return false;

		if (entry.kind !== "write") {
			this.suppressedPaths.delete(path);
			this.log(`suppression: "${path}" ${event} did not match pending delete`);
			return false;
		}

		if (
			typeof file.stat?.size === "number"
			&& typeof entry.expectedBytes === "number"
			&& file.stat.size !== entry.expectedBytes
		) {
			this.suppressedPaths.delete(path);
			this.log(
				`suppression: "${path}" ${event} size mismatch ` +
				`(expected=${entry.expectedBytes}, observed=${file.stat.size})`,
			);
			return false;
		}

		try {
			// Read back the file only when a suppression candidate exists. This
			// keeps the hot path cheap while making self-event detection causal.
			const content = await this.app.vault.read(file);
			const fingerprint = await this.fingerprintContent(content);
			if (
				fingerprint.bytes === entry.expectedBytes
				&& fingerprint.hash === entry.expectedHash
			) {
				this.suppressedPaths.delete(path);
				this.log(`suppression: acknowledged "${path}" ${event}`);
				return true;
			}
		} catch {
			// If the file cannot be read here, fall through and let normal sync handle it.
		}

		this.suppressedPaths.delete(path);
		this.log(`suppression: "${path}" ${event} fingerprint mismatch`);
		return false;
	}

	private async fingerprintContent(content: string): Promise<{ bytes: number; hash: string }> {
		const bytes = new TextEncoder().encode(content);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return {
			bytes: bytes.length,
			hash: arrayBufferToHex(digest),
		};
	}

	private runPathWriteLocked(path: string, work: () => Promise<void>): Promise<void> {
		// All flush paths funnel through one per-path promise chain so direct
		// flushes cannot overlap with queued writes for the same file.
		const previous = this.pathWriteLocks.get(path) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		let tracked: Promise<void>;
		tracked = next.finally(() => {
			if (this.pathWriteLocks.get(path) === tracked) {
				this.pathWriteLocks.delete(path);
			}
		});
		this.pathWriteLocks.set(path, tracked);
		return tracked;
	}
}
