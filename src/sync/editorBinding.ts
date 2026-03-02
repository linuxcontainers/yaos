import { Compartment, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { yCollab, ySyncFacet } from "y-codemirror.next";
import * as Y from "yjs";
import { Notice, type MarkdownView } from "obsidian";
import type { VaultSync } from "./vaultSync";
import { applyDiffToYText } from "./diff";
import type { TraceRecord } from "../debug/trace";

/**
 * Manages per-editor CM6 bindings via yCollab.
 *
 * Strategy:
 *   - One global Compartment registered via registerEditorExtension.
 *   - When a MarkdownView is opened/focused, we reconfigure that
 *     editor's compartment to yCollab(ytext, awareness, {undoManager}).
 *   - When the view is closed or switches files, reconfigure to empty.
 */

/**
 * Freshly reconfigured editors can briefly report no ySyncFacet even though
 * the compartment update is still settling into the live view state.
 */
const BINDING_SETTLE_WINDOW_MS = 250;
const POST_BIND_HEALTH_CHECK_DELAY_MS = BINDING_SETTLE_WINDOW_MS + 50;

/** Map from MarkdownView instance id to its binding state. */
interface EditorBinding {
	view: MarkdownView;
	path: string;
	undoManager: Y.UndoManager;
	cm: EditorView;
	cmId: string;
	fileId?: string;
	lastBoundAt: string;
	lastBoundAtMs: number;
	lastEditorChangeAtMs: number;
}

export interface BindingDebugInfo {
	leafId: string;
	path: string;
	fileId?: string;
	storedCmId: string;
	liveCmId: string | null;
	cmMatches: boolean;
	lastBoundAt: string;
}

export interface CollabDebugInfo {
	leafId: string;
	path: string;
	cmId: string | null;
	hasSyncFacet: boolean;
	awarenessMatchesProvider: boolean | null;
	yTextMatchesExpected: boolean | null;
	undoManagerMatchesFacet: boolean | null;
	facetFileId: string | null;
	expectedFileId: string | null;
	facetTextLength: number | null;
	cmDocLength: number | null;
}

export interface BindingHealthStatus {
	bound: boolean;
	healthy: boolean;
	settling: boolean;
	issues: string[];
}

interface BindingHealthCheck {
	healthy: boolean;
	settling: boolean;
	issues: string[];
	deferredIssues: string[];
}

interface BindingTarget {
	ytext: Y.Text;
	fileId?: string;
}

export class EditorBindingManager {
	/** The CM6 compartment that holds yCollab for each editor. */
	readonly compartment = new Compartment();

	/** Track which views are currently bound. Keyed by MarkdownView leaf id. */
	private bindings = new Map<string, EditorBinding>();
	private cmIds = new WeakMap<EditorView, string>();
	private cmToLeafId = new WeakMap<EditorView, string>();
	private cmCounter = 0;
	private pendingHealthChecks = new Map<string, ReturnType<typeof setTimeout>>();
	private healthWorkInFlight = new Set<string>();
	private lastDeviceName = "unknown";
	private cmDegradedWarned = false;

	private readonly debug: boolean;

	constructor(
		private vaultSync: VaultSync,
		debug: boolean,
		private trace?: TraceRecord,
	) {
		this.debug = debug;
	}

	/**
	 * Returns the base extension to register globally.
	 * Starts as empty; reconfigured per-editor when a note is opened.
	 */
	getBaseExtension(): Extension {
		return [
			this.compartment.of([]),
			EditorView.updateListener.of((update: ViewUpdate) => {
				this.handleLiveEditorUpdate(update);
			}),
		];
	}

	/**
	 * Bind a MarkdownView's editor to the correct Y.Text.
	 * Call this when a leaf becomes active or a file is opened.
	 */
	bind(view: MarkdownView, deviceName: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;

		// Only bind .md files
		if (!file.path.endsWith(".md")) return;

		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`bind: no CM EditorView for "${file.path}"`);
			this.warnCmDegraded();
			return;
		}
		this.cmDegradedWarned = false;
		const cmId = this.getCmId(cm);
		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);

		if (existing && existing.path === file.path && existing.cm === cm) {
			const health = this.inspectBindingHealth(view, existing);
			if (health.healthy) {
				if (health.settling) {
					const deferred = health.deferredIssues.join(",");
					this.log(
						`bind: waiting for "${file.path}" to settle ` +
						`(leaf=${leafId}, cm=${cmId}, deferred=${deferred})`,
					);
					return;
				}

				this.log(`bind: already bound "${file.path}" (leaf=${leafId}, cm=${cmId})`);
				return;
			}

			const reason = health.issues.join(",") || "unknown";
			this.log(
				`bind: repairing unhealthy binding "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}, issues=${reason})`,
			);
			if (this.heal(view, deviceName, `bind-health:${reason}`)) {
				return;
			}

			this.log(
				`bind: repair failed for "${file.path}" ` +
				`(leaf=${leafId}, cm=${cmId}) — falling back to rebind`,
			);
		}

		if (existing && existing.path === file.path && existing.cm !== cm) {
			this.log(
				`bind: editor view changed for "${file.path}" ` +
				`(leaf=${leafId}, stored=${existing.cmId}, live=${cmId})`,
			);
		}

		// Unbind previous if switching files in the same leaf
		if (existing) {
			this.unbind(view);
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			"bind",
		);
		if (!target) {
			return;
		}

		this.applyBinding({
			action: "bind",
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
		});
	}

	repair(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!file.path.endsWith(".md")) return false;

		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`repair: no CM EditorView for "${file.path}"`);
			this.warnCmDegraded();
			return false;
		}
		this.cmDegradedWarned = false;

		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		if (!existing) {
			this.log(
				`repair: no tracked binding for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason})`,
			);
			this.bind(view, deviceName);
			const rebound = this.bindings.get(leafId);
			return rebound?.path === file.path && rebound.cm === cm;
		}

		if (existing.path !== file.path || existing.cm !== cm) {
			this.log(
				`repair: binding target changed for "${file.path}" ` +
				`(leaf=${leafId}, reason=${reason}) — forcing rebind`,
			);
			this.rebind(view, deviceName, reason);
			return true;
		}

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`repair:${reason}`,
		);
		if (!target) {
			return this.isHardTombstonedPath(file.path);
		}

		return this.applyBinding({
			action: "repair",
			deviceName,
			view,
			cm,
			cmId: this.getCmId(cm),
			leafId,
			filePath: file.path,
			ytext: target.ytext,
			fileId: target.fileId,
			existing,
			reason,
		});
	}

	heal(view: MarkdownView, deviceName: string, reason: string): boolean {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return false;
		if (!file.path.endsWith(".md")) return false;

		const target = this.resolveBindingTarget(
			view,
			deviceName,
			`heal:${reason}`,
		);
		if (!target) {
			return this.isHardTombstonedPath(file.path);
		}

		const currentContent = view.editor.getValue();
		const crdtContent = target.ytext.toString();
		if (crdtContent !== currentContent) {
			this.log(
				`heal: applying local editor content to "${file.path}" ` +
				`(${crdtContent.length} -> ${currentContent.length} chars, reason=${reason})`,
			);
			applyDiffToYText(target.ytext, crdtContent, currentContent, "editor-health-heal");
		}

		return this.repair(view, deviceName, reason);
	}

	rebind(view: MarkdownView, deviceName: string, reason: string): void {
		this.lastDeviceName = deviceName;
		const file = view.file;
		if (!file) return;
		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, `rebind:${reason}`);
			return;
		}

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		this.log(`rebind: forcing "${file.path}" (leaf=${leafId}, reason=${reason})`);
		this.unbind(view);
		this.bind(view, deviceName);
	}

	/**
	 * Unbind a MarkdownView's editor (clear yCollab extension).
	 */
	unbind(view: MarkdownView): void {
		const file = view.file;
		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file?.path ?? "unknown";

		const binding = this.bindings.get(leafId);
		if (!binding) return;

		this.clearScheduledHealthCheck(leafId);
		this.healthWorkInFlight.delete(leafId);
		binding.undoManager.destroy();
		this.bindings.delete(leafId);
		this.cmToLeafId.delete(binding.cm);

		try {
			binding.cm.dispatch({
				effects: this.compartment.reconfigure([]),
			});
		} catch {
			// View may already be destroyed
		}

		this.clearLocalCursor("unbind");

		this.log(`unbind: unbound "${binding.path}" (leaf=${leafId}, cm=${binding.cmId})`);
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		for (const [leafId, binding] of this.bindings) {
			this.clearScheduledHealthCheck(leafId);
			this.healthWorkInFlight.delete(leafId);
			this.cmToLeafId.delete(binding.cm);
			binding.undoManager.destroy();
			this.log(`unbindAll: destroyed binding for "${binding.path}"`);
		}
		this.bindings.clear();
	}

	/**
	 * Unbind any editors that are bound to the given path.
	 * Called when a file is deleted (locally or remotely).
	 */
	unbindByPath(path: string): void {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path === path) {
				this.clearScheduledHealthCheck(leafId);
				this.healthWorkInFlight.delete(leafId);
				binding.undoManager.destroy();
				try {
					binding.cm.dispatch({
						effects: this.compartment.reconfigure([]),
					});
				} catch {
					// View may already be destroyed
				}
				this.cmToLeafId.delete(binding.cm);
				this.bindings.delete(leafId);
				this.log(`unbindByPath: unbound "${path}" (leaf=${leafId})`);
				// Don't break — a path could theoretically be open in multiple leaves
			}
		}
	}

	/**
	 * Check if a path is currently bound to an active editor.
	 */
	isBound(path: string): boolean {
		for (const binding of this.bindings.values()) {
			if (binding.path === path) return true;
		}
		return false;
	}

	/**
	 * Update binding metadata after a batch rename. If any bound editor's
	 * tracked path was renamed, update the tracking. The yCollab binding
	 * itself doesn't need to change (stable file IDs), but our bookkeeping does.
	 */
	updatePathsAfterRename(renames: Map<string, string>): void {
		for (const [leafId, binding] of this.bindings) {
			const newPath = renames.get(binding.path);
			if (newPath) {
				this.log(`updatePaths: "${binding.path}" -> "${newPath}" (leaf=${leafId})`);
				binding.path = newPath;
			}
		}
	}

	getBindingDebugInfoForView(view: MarkdownView): BindingDebugInfo | null {
		const file = view.file;
		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) return null;

		const liveCm = this.getCmView(view);
		const liveCmId = liveCm ? this.getCmId(liveCm) : null;
		return {
			leafId,
			path: binding.path,
			fileId: binding.fileId,
			storedCmId: binding.cmId,
			liveCmId,
			cmMatches: liveCm === binding.cm,
			lastBoundAt: binding.lastBoundAt,
		};
	}

	getBindingDebugInfo(path: string): BindingDebugInfo | null {
		for (const [leafId, binding] of this.bindings) {
			if (binding.path !== path) continue;
			return {
				leafId,
				path: binding.path,
				fileId: binding.fileId,
				storedCmId: binding.cmId,
				liveCmId: binding.cmId,
				cmMatches: true,
				lastBoundAt: binding.lastBoundAt,
			};
		}
		return null;
	}

	getBindingHealthForView(view: MarkdownView): BindingHealthStatus {
		const file = view.file;
		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file?.path ?? "unknown";
		const binding = this.bindings.get(leafId);
		if (!binding) {
			return {
				bound: false,
				healthy: false,
				settling: false,
				issues: ["missing-binding"],
			};
		}

		const health = this.inspectBindingHealth(view, binding);
		return {
			bound: true,
			healthy: health.healthy,
			settling: health.settling,
			issues: health.issues,
		};
	}

	auditBindings(source: string): number {
		let triggered = 0;
		const snapshot = Array.from(this.bindings.entries());
		for (const [leafId, binding] of snapshot) {
			if (this.bindings.get(leafId) !== binding) continue;
			if (this.healthWorkInFlight.has(leafId)) continue;

			const health = this.inspectBindingHealth(binding.view, binding);
			if (health.healthy || health.settling) continue;
			if (!this.isAuditActionable(binding.view, health.issues)) continue;

			triggered += 1;
			this.maybeHealBinding(leafId, binding, source);
		}
		return triggered;
	}

	getLastEditorActivityForPath(path: string): number | null {
		let latest: number | null = null;
		for (const binding of this.bindings.values()) {
			if (binding.path !== path) continue;
			if (latest == null || binding.lastEditorChangeAtMs > latest) {
				latest = binding.lastEditorChangeAtMs;
			}
		}
		return latest;
	}

	getCollabDebugInfoForView(view: MarkdownView): CollabDebugInfo | null {
		const file = view.file;
		if (!file) return null;

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		const cm = this.getCmView(view);
		if (!cm) {
			return {
				leafId,
				path: file.path,
				cmId: null,
				hasSyncFacet: false,
				awarenessMatchesProvider: null,
				yTextMatchesExpected: null,
				undoManagerMatchesFacet: null,
				facetFileId: null,
				expectedFileId: this.vaultSync.pathToId.get(file.path) ?? null,
				facetTextLength: null,
				cmDocLength: null,
			};
		}

		type SyncFacetLike = {
			ytext?: Y.Text;
			awareness?: unknown;
			undoManager?: Y.UndoManager;
		} | undefined;

		let syncFacet: SyncFacetLike;
		try {
			syncFacet = cm.state.facet(ySyncFacet) as SyncFacetLike;
		} catch {
			syncFacet = undefined;
		}

		const binding = this.bindings.get(leafId);
		const expectedText = this.vaultSync.getTextForPath(file.path);
		const expectedFileId =
			this.vaultSync.pathToId.get(file.path)
			?? (expectedText ? this.vaultSync.getFileIdForText(expectedText) : undefined)
			?? null;
		const facetText = syncFacet?.ytext ?? null;
		const facetFileId =
			facetText instanceof Y.Text
				? (this.vaultSync.getFileIdForText(facetText) ?? null)
				: null;

		const facetUndoManager =
			syncFacet && "undoManager" in syncFacet
				? (syncFacet.undoManager ?? null)
				: null;

		return {
			leafId,
			path: file.path,
			cmId: this.getCmId(cm),
			hasSyncFacet: !!syncFacet,
			awarenessMatchesProvider: syncFacet
				? syncFacet.awareness === this.vaultSync.provider.awareness
				: null,
			yTextMatchesExpected: syncFacet
				? (expectedText ? syncFacet.ytext === expectedText : false)
				: null,
			undoManagerMatchesFacet: syncFacet
				? ("undoManager" in syncFacet
					? (binding ? facetUndoManager === binding.undoManager : null)
					: null)
				: null,
			facetFileId,
			expectedFileId,
			facetTextLength:
				facetText instanceof Y.Text
					? facetText.toString().length
					: null,
			cmDocLength: cm.state.doc.length,
		};
	}

	clearLocalCursor(reason: string): void {
		try {
			this.vaultSync.provider.awareness.setLocalStateField("cursor", null);
			this.trace?.("editor", "cursor-cleared", { reason });
		} catch {
			// Provider may be disconnected
		}
	}

	/**
	 * Get the CM6 EditorView from a MarkdownView.
	 * This relies on Obsidian internals, so we check the current `.cm` shape
	 * first and then fall back to a cautious heuristic search.
	 */
	private getCmView(view: MarkdownView): EditorView | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const editor = view.editor as any;
		if (!editor) return null;

		if (editor.cm?.dispatch) return editor.cm as EditorView;
		if (editor._cm?.dispatch) return editor._cm as EditorView;
		if (editor.editorView?.dispatch) return editor.editorView as EditorView;

		for (const key of Object.keys(editor)) {
			const prop = editor[key];
			if (
				prop
				&& typeof prop === "object"
				&& typeof prop.dispatch === "function"
				&& prop.state
				&& prop.dom
			) {
				return prop as EditorView;
			}
		}

		return null;
	}

	private warnCmDegraded(): void {
		if (this.cmDegradedWarned) return;
		this.cmDegradedWarned = true;
		new Notice(
			"YAOS: Obsidian may have changed an internal editor API. " +
			"Live collaborative editing is unavailable. Background sync may still continue, " +
			"but live cursors and editor binding are degraded. Please check for a plugin update.",
			10000,
		);
		console.error(
			"[yaos] Critical: Could not locate CodeMirror 6 EditorView. Live binding disabled.",
		);
	}

	private getCmId(cm: EditorView): string {
		const existing = this.cmIds.get(cm);
		if (existing) return existing;
		const cmId = `cm-${++this.cmCounter}`;
		this.cmIds.set(cm, cmId);
		return cmId;
	}

	private inspectBindingHealth(
		view: MarkdownView,
		binding: EditorBinding,
	): BindingHealthCheck {
		const issues: string[] = [];
		const deferredIssues: string[] = [];
		const file = view.file;
		const liveCm = this.getCmView(view);
		const collab = this.getCollabDebugInfoForView(view);
		const withinSettleWindow =
			Date.now() - binding.lastBoundAtMs < BINDING_SETTLE_WINDOW_MS;

		if (!file) {
			issues.push("missing-file");
		} else if (binding.path !== file.path) {
			issues.push("path-changed");
		}

		if (!liveCm) {
			issues.push("missing-cm");
		} else if (liveCm !== binding.cm) {
			issues.push("cm-changed");
		}

		if (!collab) {
			issues.push("missing-collab-info");
		} else {
			if (!collab.hasSyncFacet) {
				if (withinSettleWindow) {
					deferredIssues.push("missing-sync-facet");
				} else {
					issues.push("missing-sync-facet");
				}
			}
			if (collab.awarenessMatchesProvider === false) {
				issues.push("awareness-mismatch");
			}
			if (collab.yTextMatchesExpected === false) {
				issues.push("ytext-mismatch");
			}
		}

		return {
			healthy: issues.length === 0,
			settling: issues.length === 0 && deferredIssues.length > 0,
			issues,
			deferredIssues,
		};
	}

	private handleLiveEditorUpdate(update: ViewUpdate): void {
		const match = this.findBindingForCm(update.view);
		if (!match) return;
		if (update.docChanged) {
			match.binding.lastEditorChangeAtMs = Date.now();
		}
		this.maybeHealBinding(match.leafId, match.binding, "live-update");
	}

	private maybeHealBinding(
		leafId: string,
		binding: EditorBinding,
		source: string,
	): void {
		if (this.healthWorkInFlight.has(leafId)) return;
		if (this.bindings.get(leafId) !== binding) return;

		const health = this.inspectBindingHealth(binding.view, binding);
		if (health.healthy || health.settling) return;

		const issues = health.issues.join(",") || "unknown";
		const traceDetails = this.buildHealthTraceDetails(leafId, binding, source, health.issues);
		this.healthWorkInFlight.add(leafId);
		this.trace?.("editor", "binding-health-failed", traceDetails);
		this.log(
			`binding-health-failed: "${binding.path}" ` +
			`(leaf=${leafId}, cm=${binding.cmId}, source=${source}, issues=${issues})`,
		);

		try {
			const healed = this.heal(
				binding.view,
				this.lastDeviceName,
				`${source}:${issues}`,
			);
			if (!healed) {
				this.rebind(binding.view, this.lastDeviceName, `${source}:${issues}`);
			}
			const latestBinding = this.bindings.get(leafId);
			this.trace?.("editor", "binding-health-restored", {
				...traceDetails,
				action: healed
					? (!latestBinding
						? "unbound"
						: (latestBinding.path === binding.path
							&& latestBinding.fileId === binding.fileId
							? "heal"
							: "rebound-target"))
					: "rebind",
				post: this.getCollabDebugInfoForView(binding.view),
			});
		} finally {
			this.healthWorkInFlight.delete(leafId);
		}
	}

	private applyBinding(options: {
		action: "bind" | "repair";
		deviceName: string;
		view: MarkdownView;
		cm: EditorView;
		cmId: string;
		leafId: string;
		filePath: string;
		ytext: Y.Text;
		fileId?: string;
		existing?: EditorBinding;
		reason?: string;
	}): boolean {
		const {
			action,
			deviceName,
			view,
			cm,
			cmId,
			leafId,
			filePath,
			ytext,
			fileId,
			existing,
			reason,
		} = options;

		const undoManager = new Y.UndoManager(ytext);

		this.vaultSync.provider.awareness.setLocalStateField("user", {
			name: deviceName,
			// TODO: configurable color
			color: "#30bced",
			colorLight: "#30bced33",
		});

		const collabExtension = yCollab(ytext, this.vaultSync.provider.awareness, {
			undoManager,
		});

		try {
			this.clearLocalCursor(`${action}-pre-reconfigure`);
			cm.dispatch({
				effects: this.compartment.reconfigure(collabExtension),
			});
		} catch (err) {
			undoManager.destroy();
			this.log(
				`${action}: failed "${filePath}" ` +
				`(leaf=${leafId}, cm=${cmId}, reason=${reason ?? "n/a"}): ${String(err)}`,
			);
			return false;
		}

		existing?.undoManager.destroy();
		if (existing) {
			this.cmToLeafId.delete(existing.cm);
		}
		const boundAtMs = Date.now();
		this.bindings.set(leafId, {
			view,
			path: filePath,
			undoManager,
			cm,
			cmId,
			fileId,
			lastBoundAt: new Date(boundAtMs).toISOString(),
			lastBoundAtMs: boundAtMs,
			lastEditorChangeAtMs: boundAtMs,
		});
		this.cmToLeafId.set(cm, leafId);
		this.schedulePostBindHealthCheck(leafId);
		this.trace?.("editor", "binding-applied", {
			action,
			leafId,
			path: filePath,
			cmId,
			fileId: fileId ?? null,
			reason: reason ?? null,
		});

		const result = action === "repair" ? "repaired" : "bound";
		const reasonSuffix = reason ? `, reason=${reason}` : "";
		this.log(
			`${action}: ${result} "${filePath}" ` +
			`(leaf=${leafId}, cm=${cmId}${fileId ? `, fileId=${fileId}` : ""}${reasonSuffix})`,
		);
		return true;
	}

	private log(msg: string): void {
		this.trace?.("editor", msg);
		if (this.debug) {
			console.log(`[yaos:editor] ${msg}`);
		}
	}

	private schedulePostBindHealthCheck(leafId: string): void {
		this.clearScheduledHealthCheck(leafId);
		const timer = setTimeout(() => {
			this.pendingHealthChecks.delete(leafId);
			const binding = this.bindings.get(leafId);
			if (!binding) return;
			this.maybeHealBinding(leafId, binding, "post-bind-health");
		}, POST_BIND_HEALTH_CHECK_DELAY_MS);
		this.pendingHealthChecks.set(leafId, timer);
	}

	private clearScheduledHealthCheck(leafId: string): void {
		const timer = this.pendingHealthChecks.get(leafId);
		if (timer) {
			clearTimeout(timer);
			this.pendingHealthChecks.delete(leafId);
		}
	}

	private findBindingForCm(cm: EditorView): { leafId: string; binding: EditorBinding } | null {
		const leafId = this.cmToLeafId.get(cm);
		if (leafId) {
			const binding = this.bindings.get(leafId);
			if (binding && binding.cm === cm) {
				return { leafId, binding };
			}
		}

		for (const [fallbackLeafId, binding] of this.bindings) {
			if (binding.cm === cm) {
				this.cmToLeafId.set(cm, fallbackLeafId);
				return { leafId: fallbackLeafId, binding };
			}
		}

		return null;
	}

	private resolveBindingTarget(
		view: MarkdownView,
		deviceName: string,
		reason: string,
	): BindingTarget | null {
		const file = view.file;
		if (!file) return null;

		const existingText = this.vaultSync.getTextForPath(file.path);
		if (existingText) {
			return {
				ytext: existingText,
				fileId:
					this.vaultSync.pathToId.get(file.path)
					?? this.vaultSync.getFileIdForText(existingText),
			};
		}

		if (this.isHardTombstonedPath(file.path)) {
			this.handleTombstonedBinding(view, reason);
			return null;
		}

		const currentContent = view.editor.getValue();
		const ytext = this.vaultSync.ensureFile(file.path, currentContent, deviceName);
		if (!ytext) {
			if (this.isHardTombstonedPath(file.path)) {
				this.handleTombstonedBinding(view, `${reason}:ensureFile-null`);
			} else {
				this.log(`resolveBindingTarget: ensureFile returned null for "${file.path}" (reason=${reason})`);
				this.trace?.("editor", "binding-target-missing", {
					path: file.path,
					reason,
					leafId:
						(view.leaf as unknown as { id: string }).id ?? file.path,
				});
			}
			return null;
		}

		return {
			ytext,
			fileId:
				this.vaultSync.pathToId.get(file.path)
				?? this.vaultSync.getFileIdForText(ytext),
		};
	}

	private isHardTombstonedPath(path: string): boolean {
		return (
			!this.vaultSync.getTextForPath(path)
			&& !this.vaultSync.isPendingRenameTarget(path)
			&& this.vaultSync.isMarkdownTombstoned(path)
		);
	}

	private handleTombstonedBinding(view: MarkdownView, reason: string): void {
		const file = view.file;
		if (!file) return;

		const leafId =
			(view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);
		this.trace?.("editor", "binding-blocked-tombstone", {
			path: file.path,
			leafId,
			reason,
			hadBinding: !!existing,
			pendingRenameTarget: this.vaultSync.isPendingRenameTarget(file.path),
		});
		this.log(
			`binding blocked by tombstone for "${file.path}" ` +
			`(leaf=${leafId}, reason=${reason})`,
		);
		if (existing) {
			this.unbind(view);
		}
	}

	private buildHealthTraceDetails(
		leafId: string,
		binding: EditorBinding,
		source: string,
		issues: string[],
	): Record<string, unknown> {
		const activeLeaf =
			(binding.view.leaf as unknown as { workspace?: { activeLeaf?: unknown } })
				.workspace?.activeLeaf;
		return {
			leafId,
			path: binding.path,
			cmId: binding.cmId,
			source,
			issues,
			binding: this.getBindingDebugInfoForView(binding.view),
			collab: this.getCollabDebugInfoForView(binding.view),
			isActiveLeaf: binding.view.leaf === activeLeaf,
			documentHasFocus: typeof document !== "undefined" ? document.hasFocus() : null,
		};
	}

	private isAuditActionable(view: MarkdownView, issues: string[]): boolean {
		const file = view.file;
		if (!file) {
			return false;
		}

		const activeLeaf =
			(view.leaf as unknown as { workspace?: { activeLeaf?: unknown } }).workspace?.activeLeaf;
		const isActiveLeaf = view.leaf === activeLeaf;
		if (isActiveLeaf) {
			return true;
		}

		return issues.some(
			(issue) =>
				issue !== "missing-file"
				&& issue !== "missing-collab-info",
		);
	}
}
