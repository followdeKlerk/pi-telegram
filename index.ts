import {
	mkdir,
	open,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
	verbose?: boolean;
	streamAssistantText?: boolean;
	streamTelemetry?: boolean;
	streamToolCalls?: boolean;
	streamBash?: boolean;
	streamStdout?: boolean;
	showElapsed?: boolean;
	showTokenUsage?: boolean;
	telemetryIntervalMs?: number;
}

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: {
		retry_after?: number;
	};
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramCommandRequest {
	chatId: number;
	replyToMessageId: number;
	command: string;
}

type TelegramTelemetryStatus =
	| "queued"
	| "running"
	| "tool"
	| "bash"
	| "streaming"
	| "completed"
	| "aborted"
	| "error";

interface TelegramTelemetryToolEntry {
	name: string;
	command?: string;
	status: "running" | "done" | "error";
}

interface TelegramTelemetryState {
	startedAt: number;
	status: TelegramTelemetryStatus;
	telemetryMessageId?: number;
	lastEditAt: number;
	lastText?: string;
	toolHistory?: TelegramTelemetryToolEntry[];
	recentStdout?: string[];
	recentStderr?: string[];
	inputTokens?: number;
	outputTokens?: number;
	assistantOutputChars?: number;
	contextTokens?: number;
	contextWindowTokens?: number;
	errorMessage?: string;
	showElapsed?: boolean;
	showTokenUsage?: boolean;
	flushTimer?: ReturnType<typeof setInterval>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const LOCK_PATH = join(homedir(), ".pi", "agent", "telegram.lock");
const ENV_BOT_TOKEN = "PI_TELEGRAM_BOT_TOKEN";
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 5000;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
const DEFAULT_TELEMETRY_INTERVAL_MS = 5000;
const MAX_TELEMETRY_OUTPUT_LINES = 8;
const MAX_TELEMETRY_TOOL_HISTORY = 3;
const MAX_TELEMETRY_TREE_COMMAND_LENGTH = 120;
const MAX_TELEMETRY_ERROR_LENGTH = 900;

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(
	mimeType: string | undefined,
	fallback: string,
): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	const pad = (value: number): string => value.toString().padStart(2, "0");
	if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
	return `${pad(minutes)}:${pad(seconds)}`;
}

function truncateTelemetryText(text: string, maxLength: number): string {
	const normalized = text.replace(/\r\n/g, "\n").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function appendRecentLines(
	existing: string[] | undefined,
	text: string,
): string[] {
	const lines = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
	return [...(existing ?? []), ...lines].slice(-MAX_TELEMETRY_OUTPUT_LINES);
}

function estimateTokensFromCharCount(charCount: number): number {
	return Math.max(1, Math.ceil(charCount / 4));
}

function formatToolHistoryEntry(
	entry: TelegramTelemetryToolEntry,
	isLast: boolean,
): string {
	const branch = isLast ? "└─" : "├─";
	let status = "✓";
	if (entry.status === "running") status = "▶";
	else if (entry.status === "error") status = "✗";
	const label = entry.name === "bash" ? "bash" : `tool: ${entry.name}`;
	const command = entry.command
		? ` — $ ${truncateTelemetryText(entry.command, MAX_TELEMETRY_TREE_COMMAND_LENGTH)}`
		: "";
	return `${branch} ${status} ${label}${command}`;
}

function getTextContent(value: unknown): string {
	const content = (value as { content?: unknown })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				return (block as { text: string }).text;
			}
			return "";
		})
		.join("");
}

function formatTelemetry(state: TelegramTelemetryState): string {
	const lines: string[] = [];
	if (state.status === "completed") lines.push("✅ completed");
	else if (state.status === "aborted") lines.push("🛑 aborted");
	else if (state.status === "error") lines.push("❌ error");
	else if (state.status === "queued") lines.push("🟢 pi run started");

	if (state.showElapsed !== false) {
		lines.push(`⏱ ${formatElapsed(Date.now() - state.startedAt)}`);
	}

	if (!["completed", "aborted", "error"].includes(state.status)) {
		lines.push(`📍 status: ${state.status}`);
	}

	if (state.status !== "aborted" && state.status !== "error") {
		const toolHistory = state.toolHistory;
		if (toolHistory?.length) {
			lines.push(
				"🧰 tools",
				...toolHistory.map((entry, index) =>
					formatToolHistoryEntry(entry, index === toolHistory.length - 1),
				),
			);
		}
		if (state.recentStdout?.length) {
			lines.push("📤 stdout", ...state.recentStdout);
		}
		if (state.recentStderr?.length) {
			lines.push("📥 stderr", ...state.recentStderr);
		}
		if (state.showTokenUsage !== false) {
			const context =
				state.contextTokens !== undefined &&
				state.contextWindowTokens !== undefined
					? `${formatTokens(state.contextTokens)} / ${formatTokens(state.contextWindowTokens)}`
					: "unknown";
			lines.push(`🧠 context: ${context}`);
			let output = "unknown";
			if (state.outputTokens) {
				output = `${formatTokens(state.outputTokens)} tokens`;
			} else if (state.assistantOutputChars) {
				const estimatedOutputTokens = estimateTokensFromCharCount(
					state.assistantOutputChars,
				);
				const suffix = state.status === "streaming" ? " streaming" : "";
				output = `~${formatTokens(estimatedOutputTokens)} tokens${suffix}`;
			}
			lines.push(`🔢 output: ${output}`);
		}
	}

	if (state.status === "error" && state.errorMessage) {
		lines.push(
			truncateTelemetryText(state.errorMessage, MAX_TELEMETRY_ERROR_LENGTH),
		);
	}

	return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate =
				lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(
		CONFIG_PATH,
		JSON.stringify(config, null, "\t") + "\n",
		"utf8",
	);
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	let pairingCode: string | undefined;
	let hasPollingLock = false;
	let telemetryState: TelegramTelemetryState | undefined;
	let telegramRateLimitedUntil = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();
	const telegramCommandRequests = new Map<string, TelegramCommandRequest>();

	function isVerboseTelemetryEnabled(): boolean {
		return config.verbose === true;
	}

	function shouldStreamAssistantText(): boolean {
		return config.streamAssistantText === true;
	}

	function shouldStreamTelemetry(): boolean {
		return config.streamTelemetry ?? isVerboseTelemetryEnabled();
	}

	function shouldStreamToolCalls(): boolean {
		return config.streamToolCalls ?? isVerboseTelemetryEnabled();
	}

	function shouldStreamBash(): boolean {
		return config.streamBash ?? isVerboseTelemetryEnabled();
	}

	function shouldStreamStdout(): boolean {
		return config.streamStdout === true;
	}

	function shouldShowElapsed(): boolean {
		return config.showElapsed ?? isVerboseTelemetryEnabled();
	}

	function shouldShowTokenUsage(): boolean {
		return config.showTokenUsage ?? isVerboseTelemetryEnabled();
	}

	function getTelemetryIntervalMs(): number {
		const value = config.telemetryIntervalMs;
		return typeof value === "number" && value > 0
			? value
			: DEFAULT_TELEMETRY_INTERVAL_MS;
	}

	function getVerboseStatusText(): string {
		return [
			`verbose: ${isVerboseTelemetryEnabled() ? "on" : "off"}`,
			`streamAssistantText: ${shouldStreamAssistantText()}`,
			`streamTelemetry: ${shouldStreamTelemetry()}`,
			`streamToolCalls: ${shouldStreamToolCalls()}`,
			`streamBash: ${shouldStreamBash()}`,
			`streamStdout: ${shouldStreamStdout()}`,
			`showElapsed: ${shouldShowElapsed()}`,
			`showTokenUsage: ${shouldShowTokenUsage()}`,
			`telemetryIntervalMs: ${getTelemetryIntervalMs()}`,
		].join("\n");
	}

	function formatVerboseStatusReply(
		prefix = "Verbose Telegram telemetry status",
	): string {
		return `${prefix}.\n\n${getVerboseStatusText()}`;
	}

	function parseTelegramVerboseAction(
		rawText: string,
	): "on" | "off" | "status" | "unknown" {
		const parts = rawText.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const command = parts[0] ?? "";
		const commandName = command.split("@")[0];
		if (commandName !== "/telegram-verbose" && commandName !== "/telegram_verbose") return "unknown";
		const action = parts[1] ?? "status";
		if (["on", "enable", "enabled", "true", "1"].includes(action)) return "on";
		if (["off", "disable", "disabled", "false", "0"].includes(action))
			return "off";
		if (["status", "show", "get", ""].includes(action)) return "status";
		return "unknown";
	}

	async function setVerboseTelemetry(enabled: boolean): Promise<void> {
		config = {
			...config,
			verbose: enabled,
			// Assistant text streaming edits Telegram messages repeatedly and can hit
			// Telegram flood limits. Keep it off even in verbose mode unless the user
			// explicitly enables streamAssistantText in telegram.json.
			streamAssistantText: false,
			streamTelemetry: enabled,
			streamToolCalls: enabled,
			streamBash: enabled,
			streamStdout: enabled,
			showElapsed: enabled,
			showTokenUsage: enabled,
			telemetryIntervalMs: DEFAULT_TELEMETRY_INTERVAL_MS,
		};
		await writeConfig(config);
	}

	function updateTelemetryUsage(ctx: ExtensionContext): void {
		if (!telemetryState || !shouldShowTokenUsage()) return;
		const usage = ctx.getContextUsage();
		if (usage) {
			telemetryState.contextTokens = usage.tokens ?? undefined;
			telemetryState.contextWindowTokens = usage.contextWindow;
		} else if (ctx.model?.contextWindow) {
			telemetryState.contextWindowTokens = ctx.model.contextWindow;
		}
	}

	function updateTelemetryUsageFromMessage(message: AgentMessage): void {
		if (!telemetryState || !shouldShowTokenUsage()) return;
		const usage = (
			message as unknown as { usage?: { input?: number; output?: number } }
		).usage;
		if (!usage) return;
		if (typeof usage.input === "number")
			telemetryState.inputTokens = usage.input;
		if (typeof usage.output === "number" && usage.output > 0)
			telemetryState.outputTokens = usage.output;
	}

	function pushTelemetryTool(name: string, command: string | undefined): void {
		if (!telemetryState) return;
		const history = telemetryState.toolHistory ?? [];
		telemetryState.toolHistory = [
			...history,
			{ name, command, status: "running" as const },
		].slice(-MAX_TELEMETRY_TOOL_HISTORY);
	}

	function finishTelemetryTool(name: string, isError: boolean): void {
		if (!telemetryState?.toolHistory?.length) return;
		const history = telemetryState.toolHistory;
		for (let index = history.length - 1; index >= 0; index--) {
			const entry = history[index];
			if (entry.name === name && entry.status === "running") {
				entry.status = isError ? "error" : "done";
				return;
			}
		}
	}

	async function flushTelemetry(chatId: number, force = false): Promise<void> {
		const state = telemetryState;
		if (!state || !shouldStreamTelemetry()) return;
		const now = Date.now();
		if (!force && now - state.lastEditAt < getTelemetryIntervalMs()) return;
		const text = formatTelemetry(state);
		if (text === state.lastText) return;
		try {
			if (state.telemetryMessageId === undefined) {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text,
				});
				state.telemetryMessageId = sent.message_id;
			} else {
				await callTelegram("editMessageText", {
					chat_id: chatId,
					message_id: state.telemetryMessageId,
					text,
				});
			}
			state.lastText = text;
			state.lastEditAt = now;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.toLowerCase().includes("message is not modified")) {
				state.lastEditAt = now;
			}
		}
	}

	function scheduleTelemetryTimer(chatId: number): void {
		const state = telemetryState;
		if (!state || state.flushTimer || !shouldStreamTelemetry()) return;
		state.flushTimer = setInterval(() => {
			void flushTelemetry(chatId);
		}, getTelemetryIntervalMs());
	}

	async function startTelemetry(
		turn: ActiveTelegramTurn,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!shouldStreamTelemetry()) return;
		telemetryState = {
			startedAt: Date.now(),
			status: "queued",
			lastEditAt: 0,
			showElapsed: shouldShowElapsed(),
			showTokenUsage: shouldShowTokenUsage(),
		};
		updateTelemetryUsage(ctx);
		await flushTelemetry(turn.chatId, true);
		scheduleTelemetryTimer(turn.chatId);
	}

	async function finishTelemetry(
		turn: ActiveTelegramTurn,
		status: "completed" | "aborted" | "error",
		ctx: ExtensionContext,
		errorMessage?: string,
	): Promise<void> {
		const state = telemetryState;
		if (!state) return;
		if (state.flushTimer) clearInterval(state.flushTimer);
		state.flushTimer = undefined;
		state.status = status;
		state.recentStdout = undefined;
		state.recentStderr = undefined;
		state.errorMessage = errorMessage;
		updateTelemetryUsage(ctx);
		await flushTelemetry(turn.chatId, true);
		telemetryState = undefined;
	}

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus(
				"telegram",
				`${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`,
			);
			return;
		}
		if (!getBotToken()) {
			ctx.ui.setStatus(
				"telegram",
				`${label} ${theme.fg("muted", "not configured")}`,
			);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus(
				"telegram",
				`${label} ${theme.fg("muted", hasPollingLock ? "disconnecting" : "disconnected")}`,
			);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus(
				"telegram",
				`${label} ${theme.fg("warning", `pair with /pair ${ensurePairingCode()}`)}`,
			);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued =
				queuedTelegramTurns.length > 0
					? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`)
					: "";
			ctx.ui.setStatus(
				"telegram",
				`${label} ${theme.fg("accent", "processing")}${queued}`,
			);
			return;
		}
		ctx.ui.setStatus(
			"telegram",
			`${label} ${theme.fg("success", "connected")}`,
		);
	}

	function getBotToken(): string | undefined {
		const envToken = process.env[ENV_BOT_TOKEN]?.trim();
		return envToken || config.botToken;
	}

	function ensurePairingCode(): string {
		if (!pairingCode) {
			pairingCode = String(Math.floor(100000 + Math.random() * 900000));
		}
		return pairingCode;
	}

	function clearPairingCode(): void {
		pairingCode = undefined;
	}

	function notifyPairingCode(ctx: ExtensionContext): void {
		if (config.allowedUserId !== undefined || !getBotToken()) return;
		ctx.ui.notify(
			`Telegram pairing required. Send /pair ${ensurePairingCode()} to your bot from the Telegram account you want to allow.`,
			"info",
		);
	}

	function createTelegramRateLimitError(method: string, retryAfter: number): Error {
		telegramRateLimitedUntil = Math.max(
			telegramRateLimitedUntil,
			Date.now() + retryAfter * 1000,
		);
		const error = new Error(
			`Telegram API rate limited ${method}; retry after ${retryAfter}s`,
		);
		error.name = "TelegramRateLimitError";
		return error;
	}

	function isTelegramRateLimitError(error: unknown): boolean {
		return error instanceof Error && error.name === "TelegramRateLimitError";
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		const botToken = getBotToken();
		if (!botToken) throw new Error("Telegram bot token is not configured");
		const retryAfterMs = telegramRateLimitedUntil - Date.now();
		if (retryAfterMs > 0) {
			throw createTelegramRateLimitError(
				method,
				Math.ceil(retryAfterMs / 1000),
			);
		}
		const response = await fetch(
			`https://api.telegram.org/bot${botToken}/${method}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: options?.signal,
			},
		);
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			const retryAfter = data.parameters?.retry_after;
			if (data.error_code === 429 && typeof retryAfter === "number") {
				throw createTelegramRateLimitError(method, retryAfter);
			}
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		const botToken = getBotToken();
		if (!botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(
			`https://api.telegram.org/bot${botToken}/${method}`,
			{
				method: "POST",
				body: form,
				signal: options?.signal,
			},
		);
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(
		fileId: string,
		suggestedName: string,
	): Promise<string> {
		const botToken = getBotToken();
		if (!botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", {
			file_id: fileId,
		});
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(
			TEMP_DIR,
			`${Date.now()}-${sanitizeFileName(suggestedName)}`,
		);
		const response = await fetch(
			`https://api.telegram.org/file/bot${botToken}/${file.file_path}`,
		);
		if (!response.ok)
			throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", {
					chat_id: targetChatId,
					action: "typing",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 10000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter(
				(block): block is { type: string; text?: string } =>
					typeof block === "object" && block !== null && "type" in block,
			)
			.filter(
				(block) => block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text as string)
			.join("")
			.trim();
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", {
					chat_id: chatId,
					draft_id: state.draftId,
					text: "",
				});
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;
		const truncated =
			text.length > MAX_MESSAGE_LENGTH
				? text.slice(0, MAX_MESSAGE_LENGTH)
				: text;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", {
					chat_id: chatId,
					draft_id: draftId,
					text: truncated,
				});
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		try {
			if (state.messageId === undefined) {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text: truncated,
				});
				state.messageId = sent.message_id;
				state.mode = "message";
				state.lastSentText = truncated;
				return;
			}
			await callTelegram("editMessageText", {
				chat_id: chatId,
				message_id: state.messageId,
				text: truncated,
			});
			state.mode = "message";
			state.lastSentText = truncated;
		} catch (error) {
			if (!isTelegramRateLimitError(error)) throw error;
		}
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId);
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			try {
				await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text: finalText,
				});
				await clearPreview(chatId);
				return true;
			} catch (error) {
				if (!isTelegramRateLimitError(error)) throw error;
				previewState = undefined;
				return false;
			}
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	async function sendTextReply(
		chatId: number,
		_replyToMessageId: number,
		text: string,
	): Promise<number | undefined> {
		const chunks = chunkParagraphs(text);
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			try {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", {
					chat_id: chatId,
					text: chunk,
				});
				lastMessageId = sent.message_id;
			} catch (error) {
				if (!isTelegramRateLimitError(error)) throw error;
				return lastMessageId;
			}
		}
		return lastMessageId;
	}

	async function sendQueuedAttachments(
		turn: ActiveTelegramTurn,
	): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(
					turn.chatId,
					turn.replyToMessageId,
					`Failed to send attachment ${attachment.fileName}: ${message}`,
				);
			}
		}
	}

	function createTelegramCommandRequest(
		message: TelegramMessage,
		command: string,
	): string {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		telegramCommandRequests.set(id, {
			chatId: message.chat.id,
			replyToMessageId: message.message_id,
			command,
		});
		return id;
	}

	function takeTelegramCommandRequest(
		id: string,
	): TelegramCommandRequest | undefined {
		const request = telegramCommandRequests.get(id);
		if (request) telegramCommandRequests.delete(id);
		return request;
	}

	function parseSlashCommandName(rawText: string): string | undefined {
		const trimmed = rawText.trim();
		if (!trimmed.startsWith("/")) return undefined;
		const first = trimmed.split(/\s+/, 1)[0] ?? "";
		const withoutBot = first.split("@")[0] ?? first;
		return withoutBot.slice(1);
	}

	function stripFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
	}

	function parseCommandArgs(argsString: string): string[] {
		const args: string[] = [];
		let current = "";
		let quote: string | undefined;
		for (const char of argsString) {
			if (quote) {
				if (char === quote) quote = undefined;
				else current += char;
			} else if (char === '"' || char === "'") {
				quote = char;
			} else if (/\s/.test(char)) {
				if (current) {
					args.push(current);
					current = "";
				}
			} else {
				current += char;
			}
		}
		if (current) args.push(current);
		return args;
	}

	function substitutePromptArgs(content: string, args: string[]): string {
		let result = content.replace(/\$(\d+)/g, (_match, num) => {
			return args[Number(num) - 1] ?? "";
		});
		result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_match, start, length) => {
			const startIndex = Math.max(0, Number(start) - 1);
			return length
				? args.slice(startIndex, startIndex + Number(length)).join(" ")
				: args.slice(startIndex).join(" ");
		});
		return result
			.replace(/\$ARGUMENTS/g, args.join(" "))
			.replace(/\$@/g, args.join(" "));
	}

	async function expandPiPromptCommand(rawText: string): Promise<string | undefined> {
		const commandName = parseSlashCommandName(rawText);
		if (!commandName) return undefined;
		const spaceIndex = rawText.indexOf(" ");
		const argsString = spaceIndex === -1 ? "" : rawText.slice(spaceIndex + 1).trim();
		const command = pi
			.getCommands()
			.find(
				(command) =>
					command.name === commandName &&
					(command.source === "skill" || command.source === "prompt"),
			);
		if (!command) return undefined;
		const path = command.sourceInfo.path;
		const body = stripFrontmatter(await readFile(path, "utf8"));
		if (command.source === "skill") {
			const baseDir = command.sourceInfo.baseDir ?? "unknown";
			const skillBlock = `<skill name="${command.name.replace(/^skill:/, "")}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
			return argsString ? `${skillBlock}\n\n${argsString}` : skillBlock;
		}
		return substitutePromptArgs(body, parseCommandArgs(argsString));
	}

	async function sendTelegramCommandMenu(): Promise<void> {
		await callTelegram<boolean>("setMyCommands", {
			commands: [
				{ command: "status", description: "Show pi model, usage, cost, and context" },
				{ command: "new", description: "Start a new pi session" },
				{ command: "compact", description: "Compact the current pi session" },
				{ command: "stop", description: "Abort the active pi turn" },
				{ command: "reload", description: "Reload pi resources/extensions" },
				{ command: "telegram_verbose", description: "Show or change verbose telemetry" },
				{ command: "help", description: "Show Telegram bridge help" },
			],
		});
	}

	async function clearTelegramCommandMenu(): Promise<void> {
		const bodies: Record<string, unknown>[] = [
			{},
			{ scope: { type: "default" } },
			{ scope: { type: "all_private_chats" } },
		];
		if (config.allowedUserId !== undefined) {
			bodies.push({ scope: { type: "chat", chat_id: config.allowedUserId } });
		}

		const seen = new Set<string>();
		for (const body of bodies) {
			const key = JSON.stringify(body);
			if (seen.has(key)) continue;
			seen.add(key);
			await callTelegram<boolean>("deleteMyCommands", body);
		}

		await callTelegram<boolean>("setChatMenuButton", {
			menu_button: { type: "default" },
		});
		if (config.allowedUserId !== undefined) {
			await callTelegram<boolean>("setChatMenuButton", {
				chat_id: config.allowedUserId,
				menu_button: { type: "default" },
			});
		}
	}

	async function enforceTelegramCommandMenu(ctx?: ExtensionContext): Promise<void> {
		if (!getBotToken()) return;
		try {
			await sendTelegramCommandMenu();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx?.ui.notify(`Could not update Telegram command menu: ${message}`, "error");
		}
	}

	function extractAssistantText(messages: AgentMessage[]): {
		text?: string;
		stopReason?: string;
		errorMessage?: string;
	} {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason =
				typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage =
				typeof message.errorMessage === "string"
					? message.errorMessage
					: undefined;
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter(
					(block): block is { type: string; text?: string } =>
						typeof block === "object" && block !== null && "type" in block,
				)
				.filter(
					(block) => block.type === "text" && typeof block.text === "string",
				)
				.map((block) => block.text as string)
				.join("")
				.trim();
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(
		messages: TelegramMessage[],
	): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo]
					.sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0))
					.pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName =
					message.document.file_name ||
					`document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName =
					message.video.file_name ||
					`video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName =
					message.audio.file_name ||
					`audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName =
					message.animation.file_name ||
					`animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(
		messages: TelegramMessage[],
	): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({
				path,
				fileName: file.fileName,
				isImage: file.isImage,
				mimeType: file.mimeType,
			});
		}
		return downloaded;
	}

	async function configureBotToken(
		token: string,
		persistToken: boolean,
	): Promise<TelegramConfig> {
		const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
		const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
		if (!data.ok || !data.result) {
			throw new Error(data.description || "Invalid Telegram bot token");
		}

		return {
			...config,
			botToken: persistToken ? token : config.botToken,
			botId: data.result.id,
			botUsername: data.result.username,
		};
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const envToken = process.env[ENV_BOT_TOKEN]?.trim();
			const token =
				envToken ||
				(await ctx.ui.input("Telegram bot token", "123456:ABCDEF..."))?.trim();
			if (!token) return;

			try {
				config = await configureBotToken(token, !envToken);
				await writeConfig(config);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
				return;
			}

			ctx.ui.notify(
				`Telegram bot connected: @${config.botUsername ?? "unknown"}${envToken ? ` (token from ${ENV_BOT_TOKEN})` : ""}`,
				"info",
			);
			notifyPairingCode(ctx);
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	function isProcessRunning(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	async function acquirePollingLock(ctx: ExtensionContext): Promise<boolean> {
		if (hasPollingLock) return true;
		await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
		try {
			const handle = await open(LOCK_PATH, "wx");
			await handle.writeFile(
				JSON.stringify({
					pid: process.pid,
					startedAt: new Date().toISOString(),
				}) + "\n",
				"utf8",
			);
			await handle.close();
			hasPollingLock = true;
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}

		try {
			const lock = JSON.parse(await readFile(LOCK_PATH, "utf8")) as {
				pid?: number;
				startedAt?: string;
			};
			if (typeof lock.pid === "number" && isProcessRunning(lock.pid)) {
				ctx.ui.notify(
					`Telegram bridge is already polling in another pi process (pid ${lock.pid}${lock.startedAt ? `, started ${lock.startedAt}` : ""}). Run /telegram-disconnect there or remove ${LOCK_PATH} if stale.`,
					"warning",
				);
				return false;
			}
		} catch {
			// Malformed lock files are treated as stale.
		}

		await unlink(LOCK_PATH).catch(() => undefined);
		return acquirePollingLock(ctx);
	}

	async function releasePollingLock(): Promise<void> {
		if (!hasPollingLock) return;
		hasPollingLock = false;
		await unlink(LOCK_PATH).catch(() => undefined);
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
		pollingPromise = undefined;
		await releasePollingLock();
	}

	function formatTelegramHistoryText(
		rawText: string,
		files: DownloadedTelegramFile[],
	): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
		options: { passThroughCommand?: boolean; overrideText?: string } = {},
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage)
			throw new Error("Missing Telegram message for turn creation");
		const rawText =
			options.overrideText ??
			messages
				.map((message) => (message.text || message.caption || "").trim())
				.filter(Boolean)
				.join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = options.passThroughCommand ? "" : `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0 && !options.passThroughCommand) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			if (options.passThroughCommand) prompt += rawText;
			else prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(
		messages: TelegramMessage[],
		ctx: ExtensionContext,
	): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText =
			messages
				.map((message) => (message.text || message.caption || "").trim())
				.find((text) => text.length > 0) || "";
		const lower = rawText.toLowerCase();

		const verboseAction = parseTelegramVerboseAction(rawText);
		if (verboseAction !== "unknown") {
			if (verboseAction === "on") {
				await setVerboseTelemetry(true);
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					formatVerboseStatusReply("Verbose Telegram telemetry enabled"),
				);
				return;
			}
			if (verboseAction === "off") {
				await setVerboseTelemetry(false);
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					formatVerboseStatusReply("Verbose Telegram telemetry disabled"),
				);
				return;
			}
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				formatVerboseStatusReply(),
			);
			return;
		}

		if (lower === "stop" || lower === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					"Aborted current turn.",
				);
			} else {
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					"No active turn.",
				);
			}
			return;
		}

		if (lower === "/new") {
			const requestId = createTelegramCommandRequest(firstMessage, rawText);
			pi.sendUserMessage(`/telegram-new ${requestId}`);
			return;
		}

		if (lower === "/reload") {
			const requestId = createTelegramCommandRequest(firstMessage, rawText);
			pi.sendUserMessage(`/telegram-reload ${requestId}`);
			return;
		}

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					'Cannot compact while pi is busy. Send "stop" first.',
				);
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(
						firstMessage.chat.id,
						firstMessage.message_id,
						"Compaction completed.",
					);
				},
				onError: (error) => {
					const message =
						error instanceof Error ? error.message : String(error);
					void sendTextReply(
						firstMessage.chat.id,
						firstMessage.message_id,
						`Compaction failed: ${message}`,
					);
				},
			});
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				"Compaction started.",
			);
			return;
		}

		if (lower === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant")
					continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const lines: string[] = [];
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model
				? ctx.modelRegistry.isUsingOAuth(ctx.model)
				: false;
			if (totalCost || usingSubscription) {
				lines.push(
					`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
				);
			}
			if (usage) {
				const contextWindow =
					usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent =
					usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				lines.join("\n"),
			);
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await enforceTelegramCommandMenu(ctx);
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi. Commands: /status, /new, /compact, /stop, /reload, /telegram_verbose on|off|status. Pi prompt templates and skills such as /skill:name are passed through to pi. Pairing is managed from pi with /telegram-reset-pairing.`,
			);
			return;
		}

		const expandedPromptCommand = await expandPiPromptCommand(rawText);
		const passThroughCommand = expandedPromptCommand !== undefined;
		if (parseSlashCommandName(rawText) && !passThroughCommand) {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Unknown or interactive-only pi command: ${rawText}. Supported Telegram commands: /status, /new, /compact, /stop, /reload, /telegram_verbose. Skills and prompt templates are passed through, for example /skill:name ...`,
			);
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory
			? queuedTelegramTurns.splice(0)
			: [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns, {
			passThroughCommand,
			overrideText: expandedPromptCommand,
		});
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content);
		}
	}

	async function handleAuthorizedTelegramMessage(
		message: TelegramMessage,
		ctx: ExtensionContext,
	): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(
		update: TelegramUpdate,
		ctx: ExtensionContext,
	): Promise<void> {
		const message = update.message || update.edited_message;
		if (
			!message ||
			message.chat.type !== "private" ||
			!message.from ||
			message.from.is_bot
		)
			return;

		if (config.allowedUserId === undefined) {
			const text = (message.text || "").trim();
			const expectedPairCommand = `/pair ${ensurePairingCode()}`;
			if (text === expectedPairCommand) {
				config.allowedUserId = message.from.id;
				clearPairingCode();
				await writeConfig(config);
				updateStatus(ctx);
				await sendTextReply(
					message.chat.id,
					message.message_id,
					"Telegram bridge paired with this account.",
				);
				return;
			}

			await sendTextReply(
				message.chat.id,
				message.message_id,
				`This bot is not paired yet. In pi, check the telegram status and send the shown command, e.g. /pair 123456.`,
			);
			notifyPairingCode(ctx);
			return;
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(
				message.chat.id,
				message.message_id,
				"This bot is not authorized for your account.",
			);
			return;
		}

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(
		ctx: ExtensionContext,
		signal: AbortSignal,
	): Promise<void> {
		if (!getBotToken()) return;

		try {
			await callTelegram(
				"deleteWebhook",
				{ drop_pending_updates: false },
				{ signal },
			);
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{ offset: -1, limit: 1, timeout: 0 },
					{ signal },
				);
				const last =
					updates.length > 0 ? updates[updates.length - 1] : undefined;
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig(config);
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset:
							config.lastUpdateId !== undefined
								? config.lastUpdateId + 1
								: undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					config.lastUpdateId = update.update_id;
					await writeConfig(config);
					await handleUpdate(update, ctx);
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!getBotToken() || pollingPromise) return;
		if (!(await acquirePollingLock(ctx))) {
			updateStatus(ctx, "another pi session is already polling");
			return;
		}
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(
			async () => {
				pollingPromise = undefined;
				pollingController = undefined;
				await releasePollingLock();
				updateStatus(ctx);
			},
		);
		notifyPairingCode(ctx);
		await enforceTelegramCommandMenu(ctx);
		updateStatus(ctx);
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description:
			"Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(
				Type.String({ description: "Local file path to attach" }),
				{ minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN },
			),
		}),
		async execute(_toolCallId, params) {
			if (!activeTelegramTurn) {
				throw new Error(
					"telegram_attach can only be used while replying to an active Telegram turn",
				);
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (
					activeTelegramTurn.queuedAttachments.length >=
					MAX_ATTACHMENTS_PER_TURN
				) {
					throw new Error(
						`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`,
					);
				}
				activeTelegramTurn.queuedAttachments.push({
					path: inputPath,
					fileName: basename(inputPath),
				});
				added.push(inputPath);
			}
			return {
				content: [
					{
						type: "text",
						text: `Queued ${added.length} Telegram attachment(s).`,
					},
				],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-new", {
		description: "Start a new pi session from Telegram",
		handler: async (args, ctx) => {
			const request = takeTelegramCommandRequest(args.trim());
			if (request) {
				await sendTextReply(
					request.chatId,
					request.replyToMessageId,
					"Starting a new pi session…",
				);
			}
			await ctx.waitForIdle();
			const result = await ctx.newSession({
				parentSession: ctx.sessionManager.getSessionFile(),
				withSession: async () => {
					if (request) {
						await sendTextReply(
							request.chatId,
							request.replyToMessageId,
							"Started a new pi session.",
						);
					}
				},
			});
			if (result.cancelled && request) {
				await sendTextReply(
					request.chatId,
					request.replyToMessageId,
					"New session was cancelled.",
				);
			}
		},
	});

	pi.registerCommand("telegram-reload", {
		description: "Reload pi resources/extensions from Telegram",
		handler: async (args, ctx) => {
			const request = takeTelegramCommandRequest(args.trim());
			if (request) {
				await sendTextReply(
					request.chatId,
					request.replyToMessageId,
					"Reloading pi resources/extensions…",
				);
			}
			await ctx.reload();
			return;
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : getBotToken() ? "configured" : "not configured"}`,
				`token source: ${process.env[ENV_BOT_TOKEN]?.trim() ? ENV_BOT_TOKEN : config.botToken ? "config file" : "none"}`,
				`allowed user: ${config.allowedUserId ?? `not paired; send /pair ${ensurePairingCode()}`}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`single-session lock: ${hasPollingLock ? LOCK_PATH : "not held"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-verbose", {
		description: "Enable, disable, or show verbose Telegram telemetry settings",
		handler: async (args, ctx) => {
			const action = parseTelegramVerboseAction(`/telegram-verbose ${args}`);
			if (action === "on") {
				await setVerboseTelemetry(true);
				ctx.ui.notify(
					formatVerboseStatusReply(
						"Verbose Telegram telemetry enabled",
					).replace(/\n/g, " | "),
					"info",
				);
				return;
			}
			if (action === "off") {
				await setVerboseTelemetry(false);
				ctx.ui.notify(
					formatVerboseStatusReply(
						"Verbose Telegram telemetry disabled",
					).replace(/\n/g, " | "),
					"info",
				);
				return;
			}
			ctx.ui.notify(formatVerboseStatusReply().replace(/\n/g, " | "), "info");
		},
	});

	pi.registerCommand("telegram-reset-menu", {
		description: "Clear Telegram's persistent slash-command menu",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!getBotToken()) {
				ctx.ui.notify("Telegram bot token is not configured.", "error");
				return;
			}
			try {
				await clearTelegramCommandMenu();
				ctx.ui.notify("Telegram command menu cleared.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Failed to clear Telegram command menu: ${message}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("telegram-reset-pairing", {
		description: "Forget the allowed Telegram user and show a new pairing code",
		handler: async (_args, ctx) => {
			config = { ...config, allowedUserId: undefined };
			clearPairingCode();
			await writeConfig(config);
			notifyPairingCode(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!getBotToken()) {
				await promptForConfig(ctx);
				return;
			}
			if (process.env[ENV_BOT_TOKEN]?.trim() && !config.botUsername) {
				try {
					config = await configureBotToken(
						process.env[ENV_BOT_TOKEN]!.trim(),
						false,
					);
					await writeConfig(config);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
					return;
				}
			}
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		if (getBotToken()) {
			await startPolling(ctx);
		} else {
			updateStatus(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		queuedTelegramTurns = [];
		telegramCommandRequests.clear();
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		if (telemetryState?.flushTimer) clearInterval(telemetryState.flushTimer);
		telemetryState = undefined;
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				if (shouldStreamAssistantText()) {
					previewState = {
						mode: draftSupport === "unsupported" ? "message" : "draft",
						pendingText: "",
						lastSentText: "",
					};
				}
				startTypingLoop(ctx);
				await startTelemetry(activeTelegramTurn, ctx);
				if (telemetryState) {
					telemetryState.status = "running";
					await flushTelemetry(activeTelegramTurn.chatId, true);
				}
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (telemetryState) {
			telemetryState.status = "streaming";
			void flushTelemetry(activeTelegramTurn.chatId);
		}
		if (!shouldStreamAssistantText()) return;
		if (
			previewState &&
			(previewState.pendingText.trim().length > 0 ||
				previewState.lastSentText.trim().length > 0)
		) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		previewState = {
			mode: draftSupport === "unsupported" ? "message" : "draft",
			pendingText: "",
			lastSentText: "",
		};
	});

	pi.on("message_update", async (event, ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		updateTelemetryUsage(ctx);
		updateTelemetryUsageFromMessage(event.message);
		if (telemetryState) {
			telemetryState.status = "streaming";
			telemetryState.assistantOutputChars = getMessageText(
				event.message,
			).length;
			void flushTelemetry(activeTelegramTurn.chatId);
		}
		if (!shouldStreamAssistantText()) return;
		if (!previewState) {
			previewState = {
				mode: draftSupport === "unsupported" ? "message" : "draft",
				pendingText: "",
				lastSentText: "",
			};
		}
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		updateTelemetryUsage(ctx);
		updateTelemetryUsageFromMessage(event.message);
		if (telemetryState) {
			telemetryState.assistantOutputChars = getMessageText(
				event.message,
			).length;
		}
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!activeTelegramTurn || !telemetryState) return;
		if (!shouldStreamToolCalls()) return;
		if (event.toolName === "bash" && !shouldStreamBash()) return;
		updateTelemetryUsage(ctx);
		telemetryState.status = event.toolName === "bash" ? "bash" : "tool";
		const command =
			event.toolName === "bash" && typeof event.args?.command === "string"
				? event.args.command
				: undefined;
		pushTelemetryTool(event.toolName, command);
		telemetryState.recentStdout = undefined;
		telemetryState.recentStderr = undefined;
		await flushTelemetry(activeTelegramTurn.chatId, true);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		if (!activeTelegramTurn || !telemetryState) return;
		if (!shouldStreamToolCalls()) return;
		if (event.toolName === "bash" && !shouldStreamBash()) return;
		updateTelemetryUsage(ctx);
		telemetryState.status = event.toolName === "bash" ? "bash" : "tool";
		if (event.toolName === "bash" && shouldStreamStdout()) {
			const text = getTextContent(event.partialResult);
			if (text)
				telemetryState.recentStdout = appendRecentLines(undefined, text);
		}
		void flushTelemetry(activeTelegramTurn.chatId);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!activeTelegramTurn || !telemetryState) return;
		if (!shouldStreamToolCalls()) return;
		if (event.toolName === "bash" && !shouldStreamBash()) return;
		updateTelemetryUsage(ctx);
		telemetryState.status = "running";
		finishTelemetryTool(event.toolName, event.isError);
		if (event.isError) {
			const text = getTextContent(event.result);
			if (text)
				telemetryState.recentStderr = appendRecentLines(undefined, text);
		}
		await flushTelemetry(activeTelegramTurn.chatId, true);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;

		for (const message of event.messages) {
			if (isAssistantMessage(message)) {
				updateTelemetryUsageFromMessage(message);
				if (telemetryState) {
					telemetryState.assistantOutputChars = getMessageText(message).length;
				}
			}
		}

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			await finishTelemetry(turn, "aborted", ctx);
			return;
		}
		if (assistant.stopReason === "error") {
			await clearPreview(turn.chatId);
			await finishTelemetry(
				turn,
				"error",
				ctx,
				assistant.errorMessage ||
					"Telegram bridge: pi failed while processing the request.",
			);
			await sendTextReply(
				turn.chatId,
				turn.replyToMessageId,
				assistant.errorMessage ||
					"Telegram bridge: pi failed while processing the request.",
			);
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await finalizePreview(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await sendTextReply(
					turn.chatId,
					turn.replyToMessageId,
					"Attached requested file(s).",
				);
			}
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(
					turn.chatId,
					turn.replyToMessageId,
					"Attached requested file(s).",
				);
			}
		}

		await sendQueuedAttachments(turn);
		await finishTelemetry(turn, "completed", ctx);

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			const nextTurn = queuedTelegramTurns[0];
			startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(nextTurn.content);
		}
	});
}
