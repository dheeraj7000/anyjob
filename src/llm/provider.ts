import { z } from "zod";
import { chatViaAnyapiDaemon, AnyapiDaemonError, type AnyapiDaemonConfig } from "./anyapiDaemonClient.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Live progress callback -- lets a caller (e.g. the extension's server) show
 *  what's happening instead of a silent wait, and surface exactly where a
 *  failure occurred rather than a bare "request failed". */
export interface ProgressEvent {
  type: "status" | "token" | "error";
  message: string;
}
export type OnProgress = (event: ProgressEvent) => void;

export interface LlmConfig {
  /** "openai": any OpenAI-compatible /chat/completions endpoint (default).
   *  "anyapi-daemon": route through a locally running anyapi daemon instead
   *  (e.g. DeepSeek's free web chat automated via anyapi) -- see
   *  anyapiDaemonClient.ts. No API key or base URL needed in that mode. */
  transport?: "openai" | "anyapi-daemon";
  baseUrl: string;
  apiKey: string;
  model: string;
  anyapi?: AnyapiDaemonConfig;
}

/**
 * Structured-output chat call. Two transports:
 *  - "openai" (default): any OpenAI-compatible /chat/completions endpoint
 *    (OpenAI, Cerebras, NVIDIA NIM, Ollama, vLLM, ...). Uses
 *    `response_format: json_schema` where supported, falling back to a
 *    plain JSON-mode prompt + parse for providers that reject strict schemas.
 *  - "anyapi-daemon": no structured-output support at all (it's a scraped
 *    web chat UI), so the schema is described in the prompt and the reply
 *    is parsed the same way as the openai fallback path.
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  onProgress?: OnProgress,
  maxAttempts = 5,
  initialDelayMs = 2000
): Promise<Response> {
  let attempt = 0;
  let delayMs = initialDelayMs;

  while (true) {
    attempt++;
    try {
      const res = await fetch(url, options);
      if (res.status === 429) {
        if (attempt >= maxAttempts) {
          return res;
        }
        onProgress?.({
          type: "status",
          message: `Rate limited (429). Retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})...`,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
        continue;
      }
      return res;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.({
        type: "status",
        message: `Network error (${msg}). Retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})...`,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

export async function chatStructured<T>(
  config: LlmConfig,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  schemaName = "response",
  onProgress?: OnProgress
): Promise<T> {
  const jsonSchema = zodToJsonSchemaLoose(schema);

  if (config.transport === "anyapi-daemon") {
    // Cap how long we'll ever wait on a single rate-limit retry -- the
    // daemon's own backoff can in principle grow to an hour (see
    // anyapi's Limiter.record_failure), and blocking an apply run that
    // long is worse than just surfacing a clear error.
    const MAX_RATE_LIMIT_WAIT_MS = 3 * 60 * 1000;
    let attempt = 0;
    const maxAttempts = 3;
    let raw = "";

    while (true) {
      attempt++;
      try {
        raw = await chatViaAnyapiDaemon(config.anyapi ?? {}, messages, jsonSchema, onProgress);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimited = err instanceof AnyapiDaemonError && err.kind === "RATE_LIMITED";
        const isTransient = isRateLimited || /rate\s*limit|too\s*many\s*requests|busy|timeout/i.test(msg);
        if (!isTransient || attempt >= maxAttempts) throw err;

        // The daemon already knows exactly how long its own rate-limit
        // window needs -- see anyapi's Limiter.next_available_in(). A
        // short fixed backoff (the old 3s/6s schedule) just gets rejected
        // again immediately, so honor retry_after instead, plus a small
        // buffer for clock drift between our process and the daemon's.
        const retryAfterMs =
          isRateLimited && err instanceof AnyapiDaemonError && typeof err.retryAfterSeconds === "number"
            ? Math.ceil(err.retryAfterSeconds * 1000) + 3000
            : undefined;

        if (retryAfterMs !== undefined && retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) {
          throw new Error(
            `${msg} -- this would require waiting ${Math.round(retryAfterMs / 1000)}s, longer than we're willing to block. Try again later.`
          );
        }

        const waitMs = retryAfterMs ?? 5000 * attempt;
        onProgress?.({
          type: "status",
          message: `Daemon busy/rate-limited (${msg}). Waiting ${Math.round(waitMs / 1000)}s before retrying (attempt ${attempt}/${maxAttempts})...`,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
    }

    onProgress?.({ type: "status", message: "Parsing AI response as JSON..." });
    try {
      const result = schema.parse(extractJson(raw));
      onProgress?.({ type: "status", message: "Parsed successfully." });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ type: "error", message });
      throw err;
    }
  }

  onProgress?.({ type: "status", message: "Sending request to LLM..." });
  const body = {
    model: config.model,
    messages,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        schema: jsonSchema,
        strict: true,
      },
    },
  };

  let res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  }, onProgress);

  // Some OpenAI-compatible providers (older vLLM/Ollama builds, some NIM
  // models) reject json_schema response_format. Fall back to plain JSON mode
  // with the schema described in the prompt instead.
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    res = await fetchWithRetry(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          ...messages,
          {
            role: "system" as const,
            content: `Respond with ONLY valid JSON matching this schema, no prose, no markdown fences:\n${JSON.stringify(
              jsonSchema
            )}`,
          },
        ],
      }),
    }, onProgress);
  }

  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(raw);
  return schema.parse(parsed);
}

/**
 * LLMs writing JSON by hand (no native structured-output mode, e.g. the
 * anyapi-daemon transport) sometimes emit a literal backslash that isn't a
 * valid JSON escape -- e.g. a Windows path or regex copied verbatim from a
 * resume -- which JSON.parse rejects outright ("Bad escaped character").
 * Repair those before parsing rather than failing on otherwise-good output.
 */
function repairInvalidJsonEscapes(text: string): string {
  return text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const candidateMatch = trimmed.match(/\{[\s\S]*\}/);
  const candidate = candidateMatch ? candidateMatch[0] : trimmed;

  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    try {
      return JSON.parse(repairInvalidJsonEscapes(candidate));
    } catch {
      const message = firstErr instanceof Error ? firstErr.message : String(firstErr);
      const preview = candidate.length > 300 ? `${candidate.slice(0, 300)}...` : candidate;
      throw new Error(`Could not parse JSON from model output (${message}). Raw output: ${preview}`);
    }
  }
}

/**
 * Minimal, dependency-free zod -> JSON Schema conversion covering the
 * subset of zod we actually use in this project (object/string/number/
 * boolean/array/enum/optional). Not a general-purpose converter.
 */
function zodToJsonSchemaLoose(schema: z.ZodType<unknown>): Record<string, unknown> {
  const def = (schema as any)._def;

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const field = shape[key];
      properties[key] = zodToJsonSchemaLoose(field);
      if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodNullable)) {
        required.push(key);
      }
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return zodToJsonSchemaLoose(def.innerType);
  }
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchemaLoose(def.type) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: def.values };
  }
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };

  return {};
}
