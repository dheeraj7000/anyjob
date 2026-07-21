import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Remembers how form fields were resolved on a given site, so a repeat fill
 * (or another job posting on the same employer's careers page) doesn't need
 * to ask the LLM again for fields it has already answered. Keyed by
 * `siteKey` (see siteKeyFor below), then by a normalized (type, label) pair
 * -- selectors themselves aren't used as the key because ATS platforms like
 * Workday/Greenhouse frequently regenerate ids/automation-ids per session or
 * per posting even though the visible label stays the same.
 */

export interface CachedField {
  /** The resolved value, if the LLM (or a prior fill) mapped this field successfully. */
  value?: string;
  /** Why this field couldn't be mapped, if it previously landed in `unmapped`. */
  reason?: string;
  updatedAt: string;
}

type SiteCache = Record<string, CachedField>;
type FieldCache = Record<string, SiteCache>;

const CACHE_PATH = "./data/field-cache.json";

async function readCache(): Promise<FieldCache> {
  if (!existsSync(CACHE_PATH)) return {};
  const raw = await readFile(CACHE_PATH, "utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

async function writeCache(cache: FieldCache): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/** Normalizes a field's (type, label) into a stable cache key. */
export function fieldKey(label: string, type: string): string {
  return `${type}:${label.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * Derives a cache scope from a job posting URL: hostname plus the first path
 * segment. Plain hostname isn't enough on shared ATS domains (e.g. every
 * Greenhouse customer lives under boards.greenhouse.io/<company-slug>/...) --
 * without the path segment, answers from one company's form would leak into
 * a completely different company's application on the same domain.
 */
export function siteKeyFor(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];
    return firstSegment ? `${parsed.hostname}/${firstSegment}` : parsed.hostname;
  } catch {
    return undefined;
  }
}

export async function getSiteCache(siteKey: string): Promise<SiteCache> {
  const cache = await readCache();
  return cache[siteKey] ?? {};
}

/** Merges new entries into a site's cache without clobbering unrelated fields. */
export async function mergeSiteCache(siteKey: string, entries: SiteCache): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const cache = await readCache();
  cache[siteKey] = { ...(cache[siteKey] ?? {}), ...entries };
  await writeCache(cache);
}

/** Wipes every remembered answer -- called when the underlying profile changes (e.g. a new resume is uploaded), since old answers may no longer reflect the candidate. */
export async function clearFieldCache(): Promise<void> {
  await writeCache({});
}
