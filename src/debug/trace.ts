import { type App, normalizePath } from "obsidian";

export interface TraceHttpContext {
	traceId: string;
	bootId: string;
	deviceName: string;
	vaultId: string;
}

export interface TraceEventDetails {
	[key: string]: unknown;
}

export type TraceRecord = (
	source: string,
	msg: string,
	details?: TraceEventDetails,
) => void;

interface TraceEvent {
	ts: string;
	seq: number;
	source: string;
	msg: string;
	traceId: string;
	bootId: string;
	deviceName: string;
	vaultId: string;
	details?: TraceEventDetails;
}

const FLUSH_DELAY_MS = 400;
const STATE_WRITE_DELAY_MS = 600;

function randomId(prefix: string): string {
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	let b64 = btoa(String.fromCharCode(...bytes));
	b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${prefix}-${b64}`;
}

async function ensureDirRecursive(app: App, dir: string): Promise<void> {
	const normalized = normalizePath(dir);
	if (!normalized) return;
	if (await app.vault.adapter.exists(normalized)) return;

	const parts = normalized.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		// `exists` is cheaper than catching mkdir errors on repeated writes.
		if (!(await app.vault.adapter.exists(current))) {
			await app.vault.adapter.mkdir(current);
		}
	}
}

export function appendTraceParams(url: string, trace?: TraceHttpContext): string {
	if (!trace) return url;
	const target = new URL(url);
	target.searchParams.set("device", trace.deviceName);
	target.searchParams.set("trace", trace.traceId);
	target.searchParams.set("boot", trace.bootId);
	return target.toString();
}

export class PersistentTraceLogger {
	private readonly enabled: boolean;
	private readonly context: TraceHttpContext;
	private readonly rootDir: string;

	private pendingLines: string[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private stateTimer: ReturnType<typeof setTimeout> | null = null;
	private latestState: unknown = null;
	private seq = 0;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		options: {
			enabled: boolean;
			deviceName: string;
			vaultId: string;
		},
	) {
		this.enabled = options.enabled;
		this.context = {
			traceId: randomId("trace"),
			bootId: randomId("boot"),
			deviceName: options.deviceName,
			vaultId: options.vaultId,
		};
		this.rootDir = normalizePath(
			`${this.app.vault.configDir}/plugins/yaos/logs`,
		);
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	get httpContext(): TraceHttpContext {
		return this.context;
	}

	record(source: string, msg: string, details?: TraceEventDetails): void {
		if (!this.enabled) return;

		const event: TraceEvent = {
			ts: new Date().toISOString(),
			seq: ++this.seq,
			source,
			msg,
			traceId: this.context.traceId,
			bootId: this.context.bootId,
			deviceName: this.context.deviceName,
			vaultId: this.context.vaultId,
			details,
		};

		this.pendingLines.push(JSON.stringify(event) + "\n");
		this.scheduleFlush();
	}

	updateCurrentState(state: unknown): void {
		if (!this.enabled) return;
		this.latestState = state;
		if (this.stateTimer) clearTimeout(this.stateTimer);
		this.stateTimer = setTimeout(() => {
			this.stateTimer = null;
				void this.enqueueWrite(async () => {
					if (!this.latestState) return;
					const serialized = JSON.stringify(this.latestState, null, 2);
					const historyLine = JSON.stringify(this.latestState) + "\n";
					await ensureDirRecursive(this.app, this.rootDir);
					await this.app.vault.adapter.write(
						this.currentStatePath(),
						serialized,
					);
					await ensureDirRecursive(this.app, this.sessionDir());
					await this.app.vault.adapter.append(
						this.stateHistoryPath(),
						historyLine,
					);
				});
			}, STATE_WRITE_DELAY_MS);
	}

	captureCrash(kind: string, error: unknown, context?: TraceEventDetails): void {
		if (!this.enabled) return;

		const payload = {
			ts: new Date().toISOString(),
			kind,
			traceId: this.context.traceId,
			bootId: this.context.bootId,
			deviceName: this.context.deviceName,
			vaultId: this.context.vaultId,
			error: formatError(error),
			context,
		};

		void this.enqueueWrite(async () => {
			await ensureDirRecursive(this.app, this.rootDir);
			await this.app.vault.adapter.write(
				this.crashPath(),
				JSON.stringify(payload, null, 2),
			);
		});
	}

	async shutdown(): Promise<void> {
		if (!this.enabled) return;
		if (this.stateTimer) {
			clearTimeout(this.stateTimer);
			this.stateTimer = null;
		}
		this.record("trace", "trace-session-end");
		await this.flushNow();
		await this.writeChain;
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flushNow();
		}, FLUSH_DELAY_MS);
	}

	private async flushNow(): Promise<void> {
		if (!this.enabled || this.pendingLines.length === 0) return;
		const chunk = this.pendingLines.join("");
		this.pendingLines = [];
		await this.enqueueWrite(async () => {
			await ensureDirRecursive(this.app, this.sessionDir());
			await this.app.vault.adapter.append(this.sessionPath(), chunk);
		});
	}

	private enqueueWrite(task: () => Promise<void>): Promise<void> {
		const next = this.writeChain.then(task, task);
		this.writeChain = next.catch(() => {});
		return next;
	}

	private currentStatePath(): string {
		return normalizePath(`${this.rootDir}/current-state.json`);
	}

	private crashPath(): string {
		return normalizePath(`${this.rootDir}/last-crash.json`);
	}

	private sessionDir(): string {
		const day = new Date().toISOString().slice(0, 10);
		return normalizePath(`${this.rootDir}/${day}`);
	}

	private sessionPath(): string {
		return normalizePath(
			`${this.sessionDir()}/${this.context.bootId}.ndjson`,
		);
	}

	private stateHistoryPath(): string {
		return normalizePath(
			`${this.sessionDir()}/${this.context.bootId}-state.ndjson`,
		);
	}
}

function formatError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return { value: String(error) };
}
