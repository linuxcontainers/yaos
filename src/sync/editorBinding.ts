import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { MarkdownView } from "obsidian";
import type { VaultSync } from "./vaultSync";

/**
 * Manages per-editor CM6 bindings via yCollab.
 *
 * Strategy:
 *   - One global Compartment registered via registerEditorExtension.
 *   - When a MarkdownView is opened/focused, we reconfigure that
 *     editor's compartment to yCollab(ytext, awareness, {undoManager}).
 *   - When the view is closed or switches files, reconfigure to empty.
 */

/** Map from MarkdownView instance id to its binding state. */
interface EditorBinding {
	path: string;
	undoManager: Y.UndoManager;
}

export class EditorBindingManager {
	/** The CM6 compartment that holds yCollab for each editor. */
	readonly compartment = new Compartment();

	/** Track which views are currently bound. Keyed by MarkdownView leaf id. */
	private bindings = new Map<string, EditorBinding>();

	private readonly debug: boolean;

	constructor(
		private vaultSync: VaultSync,
		debug: boolean,
	) {
		this.debug = debug;
	}

	/**
	 * Returns the base extension to register globally.
	 * Starts as empty; reconfigured per-editor when a note is opened.
	 */
	getBaseExtension(): Extension {
		return this.compartment.of([]);
	}

	/**
	 * Bind a MarkdownView's editor to the correct Y.Text.
	 * Call this when a leaf becomes active or a file is opened.
	 */
	bind(view: MarkdownView, deviceName: string): void {
		const file = view.file;
		if (!file) return;

		// Only bind .md files
		if (!file.path.endsWith(".md")) return;

		const leafId = (view.leaf as unknown as { id: string }).id ?? file.path;
		const existing = this.bindings.get(leafId);

		// Already bound to the same path — skip
		if (existing && existing.path === file.path) return;

		// Unbind previous if switching files in the same leaf
		if (existing) {
			this.unbind(view);
		}

		const cm = this.getCmView(view);
		if (!cm) {
			this.log(`bind: no CM EditorView for "${file.path}"`);
			return;
		}

		// Get or seed the Y.Text
		const currentContent = view.editor.getValue();
		const ytext = this.vaultSync.ensureFile(
			file.path,
			currentContent,
			deviceName,
		);

		if (!ytext) {
			this.log(`bind: ensureFile returned null for "${file.path}" (tombstoned?)`);
			return;
		}

		// Create an UndoManager scoped to this Y.Text
		const undoManager = new Y.UndoManager(ytext);

		// Set awareness local state
		this.vaultSync.provider.awareness.setLocalStateField("user", {
			name: deviceName,
			// TODO: configurable color
			color: "#30bced",
			colorLight: "#30bced33",
		});

		// Reconfigure the compartment for this editor
		const collabExtension = yCollab(ytext, this.vaultSync.provider.awareness, {
			undoManager,
		});

		cm.dispatch({
			effects: this.compartment.reconfigure(collabExtension),
		});

		this.bindings.set(leafId, {
			path: file.path,
			undoManager,
		});

		this.log(`bind: bound "${file.path}" (leaf=${leafId})`);
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

		binding.undoManager.destroy();
		this.bindings.delete(leafId);

		const cm = this.getCmView(view);
		if (cm) {
			try {
				cm.dispatch({
					effects: this.compartment.reconfigure([]),
				});
			} catch {
				// View may already be destroyed
			}
		}

		// Clear cursor from awareness to avoid stale cursor positions
		// being displayed to other clients after switching files.
		try {
			this.vaultSync.provider.awareness.setLocalStateField("cursor", null);
		} catch {
			// Provider may be disconnected
		}

		this.log(`unbind: unbound "${binding.path}" (leaf=${leafId})`);
	}

	/**
	 * Unbind all editors. Called on plugin unload.
	 */
	unbindAll(): void {
		for (const [leafId, binding] of this.bindings) {
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
				binding.undoManager.destroy();
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

	/**
	 * Get the CM6 EditorView from a MarkdownView.
	 * This accesses the internal .cm property which is standard
	 * in Obsidian's CM6 integration but not in the public API types.
	 */
	private getCmView(view: MarkdownView): EditorView | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const cm = (view.editor as any)?.cm as EditorView | undefined;
		return cm ?? null;
	}

	private log(msg: string): void {
		if (this.debug) {
			console.log(`[vault-crdt-sync:editor] ${msg}`);
		}
	}
}
