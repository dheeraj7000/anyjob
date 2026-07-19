import "dotenv/config";
import type { LlmConfig } from "./llm/provider.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadLlmConfig(): LlmConfig {
  const transport = (process.env.LLM_TRANSPORT as LlmConfig["transport"]) ?? "openai";

  if (transport === "anyapi-daemon") {
    return {
      transport,
      baseUrl: "",
      apiKey: "",
      model: "",
      anyapi: {
        provider: process.env.ANYAPI_PROVIDER ?? "deepseek",
        socketPath: process.env.ANYAPI_SOCKET_PATH,
        bridgeScript: process.env.ANYAPI_BRIDGE_SCRIPT,
        pythonBin: process.env.ANYAPI_PYTHON_BIN,
      },
    };
  }

  return {
    transport,
    baseUrl: required("LLM_BASE_URL").replace(/\/$/, ""),
    apiKey: required("LLM_API_KEY"),
    model: required("LLM_MODEL"),
  };
}

export interface SiteCredentials {
  url: string;
  username: string;
  password: string;
}

/** Reads WORKDAY_ASU_URL / _USERNAME / _PASSWORD style env vars for a given site key. */
export function loadSiteCredentials(siteKey: string): SiteCredentials {
  const prefix = siteKey.toUpperCase();
  return {
    url: required(`${prefix}_URL`),
    username: required(`${prefix}_USERNAME`),
    password: required(`${prefix}_PASSWORD`),
  };
}

export function getStorageStateDir(): string {
  return process.env.STORAGE_STATE_DIR ?? "./data/storage-state";
}

export function getResumePath(): string {
  return process.env.CANDIDATE_RESUME_PATH ?? "./data/resume.pdf";
}
