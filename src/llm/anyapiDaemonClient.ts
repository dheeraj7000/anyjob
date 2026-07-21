import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChatMessage, OnProgress } from "./provider.js";

export interface AnyapiDaemonConfig {
  /** anyapi provider name, e.g. "deepseek". Defaults to "deepseek". */
  provider?: string;
  /** Override the daemon's Unix socket path. Defaults to anyapi's own default
   *  (~/.local/share/anyapi/<provider>_daemon.sock). */
  socketPath?: string;
  /** Path to scripts/anyapi_bridge.py. Defaults to the copy shipped in this repo. */
  bridgeScript?: string;
  /** Python interpreter to invoke. Defaults to "python3". */
  pythonBin?: string;
}

interface BridgeLine {
  type: "status" | "token" | "done" | "error";
  message?: string;
  text?: string;
  error?: string;
  /** Structured error kind from anyapi's DaemonError (e.g. "RATE_LIMITED", "SELECTOR_BROKEN"). */
  kind?: string;
  /** Seconds the daemon says to wait before its rate limiter will allow another request. */
  retry_after?: number;
}

const DEFAULT_BRIDGE_SCRIPT = new URL("../../scripts/anyapi_bridge.py", import.meta.url).pathname;

/**
 * Thrown when the daemon reports a structured error (see anyapi_bridge.py /
 * anyapi.shared.errors.DaemonError). Callers use `kind`/`retryAfterSeconds`
 * to distinguish a real rate limit -- with a known wait time -- from other
 * failures, instead of regex-sniffing the message text.
 */
export class AnyapiDaemonError extends Error {
  readonly kind?: string;
  readonly retryAfterSeconds?: number;

  constructor(message: string, kind?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "AnyapiDaemonError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Sends one chat turn through a locally running `anyapi-daemon` (e.g. its
 * DeepSeek provider, which automates chat.deepseek.com over Playwright)
 * instead of a real API. anyapi's daemon has no notion of chat roles or
 * structured output -- it's a text box on a web page -- so messages are
 * flattened into one prompt, and the JSON schema (if any) is appended as an
 * instruction rather than sent as a response_format.
 *
 * scripts/anyapi_bridge.py streams each daemon event as its own JSON line;
 * onProgress lets a caller show that live instead of waiting silently for
 * the whole reply.
 *
 * Requires the daemon to already be running:
 *   anyapi-daemon --provider deepseek
 */
export async function chatViaAnyapiDaemon(
  config: AnyapiDaemonConfig,
  messages: ChatMessage[],
  jsonSchema?: Record<string, unknown>,
  onProgress?: OnProgress
): Promise<string> {
  const prompt = flattenMessages(messages, jsonSchema);

  const python = config.pythonBin ?? "python3";
  const script = config.bridgeScript ?? DEFAULT_BRIDGE_SCRIPT;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: BridgeLine;
      try {
        event = JSON.parse(line);
      } catch {
        return; // stray non-JSON output on stdout; ignore rather than crash the whole call
      }

      if (event.type === "done") {
        settled = true;
        onProgress?.({ type: "status", message: "Received full reply from anyapi daemon." });
        resolve(event.text ?? "");
      } else if (event.type === "error") {
        settled = true;
        reject(new AnyapiDaemonError(`anyapi daemon error: ${event.error}`, event.kind, event.retry_after));
      } else if (event.type === "token") {
        onProgress?.({ type: "token", message: event.message ?? "" });
      } else if (event.type === "status") {
        onProgress?.({ type: "status", message: event.message ?? "" });
      }
    });

    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (!settled) {
        reject(new Error(`anyapi_bridge.py exited ${code} without a result${stderr ? `: ${stderr}` : ""}`));
      }
    });

    child.stdin.write(
      JSON.stringify({ prompt, provider: config.provider ?? "deepseek", socket_path: config.socketPath })
    );
    child.stdin.end();
  });
}

function flattenMessages(messages: ChatMessage[], jsonSchema?: Record<string, unknown>): string {
  const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
  if (!jsonSchema) return transcript;
  return (
    `${transcript}\n\n` +
    `Respond with ONLY valid JSON matching this schema, no prose, no markdown fences:\n${JSON.stringify(
      jsonSchema
    )}`
  );
}
