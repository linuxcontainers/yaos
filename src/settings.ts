import { App, PluginSettingTab, Setting } from "obsidian";
import type VaultCrdtSyncPlugin from "./main";

export interface VaultSyncSettings {
	/** PartyKit server host, e.g. "https://vault-crdt-sync.yourname.partykit.dev" */
	host: string;
	/** Shared secret token for auth. */
	token: string;
	/** Unique vault identifier. Generated randomly if empty on first load. */
	vaultId: string;
	/** Human-readable device name shown in awareness/cursors. */
	deviceName: string;
	/** Enable verbose console.log output for debugging. */
	debug: boolean;
	/** Comma-separated path prefixes to exclude from sync. */
	excludePatterns: string;
	/** Maximum file size in KB to sync via CRDT. Files larger are skipped. */
	maxFileSizeKB: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	host: "",
	token: "",
	vaultId: "",
	deviceName: "",
	debug: false,
	excludePatterns: "",
	maxFileSizeKB: 2048,
};

/** Generate a random vault ID (16 bytes, base64url). */
export function generateVaultId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let b64 = btoa(String.fromCharCode(...bytes));
	b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return b64;
}

/** Returns true if the host URL is unencrypted and not localhost. */
function isInsecureRemoteHost(host: string): boolean {
	if (!host) return false;
	try {
		const url = new URL(host);
		if (url.protocol !== "http:") return false;
		const h = url.hostname;
		if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") return false;
		return true;
	} catch {
		return false;
	}
}

export class VaultSyncSettingTab extends PluginSettingTab {
	plugin: VaultCrdtSyncPlugin;

	constructor(app: App, plugin: VaultCrdtSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Vault CRDT sync" });

		new Setting(containerEl)
			.setName("Server host")
			.setDesc(
				"PartyKit server URL (e.g. https://vault-crdt-sync.yourname.partykit.dev or http://127.0.0.1:1999 for local dev).",
			)
			.addText((text) =>
				text
					.setPlaceholder("https://...")
					.setValue(this.plugin.settings.host)
					.onChange(async (value) => {
						this.plugin.settings.host = value.trim();
						await this.plugin.saveSettings();
						// Re-render to update the warning
						this.display();
					}),
			);

		// WSS/HTTPS warning for non-localhost HTTP connections
		if (isInsecureRemoteHost(this.plugin.settings.host)) {
			const warning = containerEl.createEl("p", {
				text: "Warning: using unencrypted connection. Your sync token will be sent in plaintext. Use https:// for production.",
			});
			warning.style.color = "var(--text-error)";
			warning.style.fontSize = "12px";
			warning.style.marginTop = "-8px";
		}

		new Setting(containerEl)
			.setName("Token")
			.setDesc("Shared secret token. Must match SYNC_TOKEN on the server.")
			.addText((text) =>
				text
					.setPlaceholder("your-secret-token")
					.setValue(this.plugin.settings.token)
					.onChange(async (value) => {
						this.plugin.settings.token = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vault ID")
			.setDesc(
				"Unique identifier for this vault. All devices syncing the same vault must use the same ID. Auto-generated if left empty.",
			)
			.addText((text) =>
				text
					.setPlaceholder("auto-generated")
					.setValue(this.plugin.settings.vaultId)
					.onChange(async (value) => {
						this.plugin.settings.vaultId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc(
				"Name shown to other connected devices (e.g. in remote cursors).",
			)
			.addText((text) =>
				text
					.setPlaceholder("My laptop")
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h3", { text: "Filters" });

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc(
				"Comma-separated path prefixes to exclude from sync. Example: templates/, daily-notes/, .trash/",
			)
			.addText((text) =>
				text
					.setPlaceholder("templates/, .trash/")
					.setValue(this.plugin.settings.excludePatterns)
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Max file size (KB)")
			.setDesc(
				"Files larger than this are skipped for CRDT sync. Default 2048 (2 MB). CRDT overhead on very large texts is significant.",
			)
			.addText((text) =>
				text
					.setPlaceholder("2048")
					.setValue(String(this.plugin.settings.maxFileSizeKB))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.maxFileSizeKB = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		containerEl.createEl("h3", { text: "Advanced" });

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Enable verbose console logging for troubleshooting.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debug).onChange(async (value) => {
					this.plugin.settings.debug = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl("p", {
			text: "Changes to host, token, or vault ID require reloading the plugin (disable then re-enable, or restart Obsidian).",
			cls: "setting-item-description",
		});
	}
}
