import { mkdir, readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { z } from "zod";
import { chatStructured } from "../llm/provider.js";
import type { LlmConfig, OnProgress } from "../llm/provider.js";
import type { CandidateProfile } from "../profile/types.js";
import type { JobPosting, FillResult } from "../sites/adapter.js";
import { fieldKey, getSiteCache, mergeSiteCache, siteKeyFor, type CachedField } from "../storage/fieldCache.js";

export interface FormField {
  /** Stable CSS selector Playwright can act on directly. */
  selector: string;
  label: string;
  type: "text" | "textarea" | "select" | "checkbox" | "radio" | "file" | "unknown";
  options?: string[];
}

const FORM_UTILS_PATH = new URL("../../shared-browser/formUtils.js", import.meta.url);
let formUtilsSourceCache: string | undefined;

async function loadFormUtilsSource(): Promise<string> {
  if (!formUtilsSourceCache) {
    formUtilsSourceCache = await readFile(FORM_UTILS_PATH, "utf-8");
  }
  return formUtilsSourceCache;
}

/**
 * Generic, heuristic form scanner: finds inputs/selects/textareas with an
 * associated visible label (via <label for>, aria-label, or aria-labelledby).
 * Works across most React-rendered ATS forms (Workday, Greenhouse, Lever)
 * without site-specific selectors, at the cost of missing exotic widgets
 * (custom date pickers, multi-select chips) that a site adapter can extend
 * with its own overrides.
 *
 * The actual scanning logic lives in shared-browser/formUtils.js -- the same
 * file the anyjob browser extension injects into a real browser tab -- so
 * Playwright automation and the extension can never drift apart.
 */
export async function extractFormFields(page: Page): Promise<FormField[]> {
  const source = await loadFormUtilsSource();
  return page.evaluate(`${source}\nanyjobScanForm();`);
}

const FieldValueSchema = z.object({
  selector: z.string(),
  value: z.string(),
  reason: z.string().optional(),
});

const FieldMappingSchema = z.object({
  mappings: z.array(FieldValueSchema),
  unmapped: z.array(z.object({ selector: z.string(), reason: z.string() })),
});

export type FieldMapping = z.infer<typeof FieldMappingSchema>;

/** One LLM call asking for a mapping over exactly the given fields (a full batch, or a single field during fallback). */
async function requestFieldMapping(
  llmConfig: LlmConfig,
  profile: CandidateProfile,
  posting: JobPosting,
  fields: FormField[],
  onProgress?: OnProgress
): Promise<FieldMapping> {
  return chatStructured(
    llmConfig,
    [
      {
        role: "system",
        content:
          "You fill job application forms from a candidate profile. For each " +
          "field, choose the best value from the profile data. For select/radio " +
          "fields, pick from the given options exactly as written. If a field " +
          "can't be confidently answered from the profile (e.g. a subjective " +
          "essay question, or data simply not present), put it in `unmapped` " +
          "with a reason instead of guessing. Never invent facts not in the profile.",
      },
      {
        role: "user",
        content: JSON.stringify({ job: { title: posting.title, company: posting.company }, profile, fields }),
      },
    ],
    FieldMappingSchema,
    "field_mapping",
    onProgress
  );
}

/** Runs fn(); on failure, logs it and retries exactly once before giving up. */
async function withOneRetry<T>(fn: () => Promise<T>, label: string, onProgress?: OnProgress): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ type: "status", message: `${label} failed (${message}), retrying once...` });
    return await fn();
  }
}

/**
 * Maps profile data onto scanned form fields. Tries one efficient call for
 * the whole batch first; if that fails even after a retry (the anyapi-daemon
 * transport in particular can hit transient scraping errors), falls back to
 * mapping fields one at a time so a single bad field or a mid-batch hiccup
 * doesn't cost you every field -- only the individual fields that actually
 * fail to map end up in `unmapped`, with the real error as the reason.
 *
 * Before calling the LLM at all, checks the on-disk field cache (see
 * ../storage/fieldCache.ts) for fields this site has already answered in a
 * previous fill -- only fields with no cached answer go to the LLM. `siteKey`
 * defaults to a key derived from `posting.url`; pass it explicitly when the
 * caller (e.g. the browser extension) doesn't have a real posting URL to
 * derive one from.
 */
export async function mapProfileToFields(
  llmConfig: LlmConfig,
  profile: CandidateProfile,
  posting: JobPosting,
  fields: FormField[],
  onProgress?: OnProgress,
  siteKey?: string
): Promise<FieldMapping> {
  // File inputs (resume/cover letter uploads) can't be filled with a text
  // value from the LLM -- they're attached as real bytes separately (see the
  // extension's anyjobFillFileField / the server's /api/attachments). Keep
  // them out of the LLM request entirely and surface them as unmapped so the
  // caller can decide whether it has an attachment to offer instead.
  const textFields = fields.filter((f) => f.type !== "file");
  const fileFields = fields.filter((f) => f.type === "file");
  const fileUnmapped = fileFields.map((f) => ({ selector: f.selector, reason: "File upload field -- attach a resume/cover letter file instead of a text value." }));

  if (textFields.length === 0) {
    return { mappings: [], unmapped: fileUnmapped };
  }

  const site = siteKey ?? siteKeyFor(posting.url);
  const siteCache = site ? await getSiteCache(site) : {};

  const cachedMappings: FieldMapping["mappings"] = [];
  const cachedUnmapped: FieldMapping["unmapped"] = [];
  const toMap: FormField[] = [];

  for (const field of textFields) {
    const cached = siteCache[fieldKey(field.label, field.type)];
    if (!cached) {
      toMap.push(field);
      continue;
    }
    // A cached select/radio value only applies if it's still a valid option
    // here -- the same label can back a differently-populated dropdown.
    const optionStillValid =
      cached.value === undefined || (field.type !== "select" && field.type !== "radio") || (field.options?.includes(cached.value) ?? false);
    if (cached.value !== undefined && optionStillValid) {
      cachedMappings.push({ selector: field.selector, value: cached.value });
    } else if (cached.reason !== undefined) {
      cachedUnmapped.push({ selector: field.selector, reason: cached.reason });
    } else {
      toMap.push(field);
    }
  }

  if (cachedMappings.length + cachedUnmapped.length > 0) {
    onProgress?.({
      type: "status",
      message: `Reused ${cachedMappings.length + cachedUnmapped.length} field(s) already answered on this site before -- no AI call needed for those.`,
    });
  }

  let result: FieldMapping = { mappings: [], unmapped: [] };
  if (toMap.length > 0) {
    try {
      onProgress?.({ type: "status", message: `Asking AI to map ${toMap.length} new field(s)...` });
      result = await withOneRetry(() => requestFieldMapping(llmConfig, profile, posting, toMap, onProgress), "Batch mapping", onProgress);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({
        type: "status",
        message: `Batch mapping failed (${message}). Falling back to mapping each field individually so one failure doesn't lose the rest...`,
      });
      result = await mapFieldsIndividually(llmConfig, profile, posting, toMap, onProgress);
    }

    if (site) await cacheNewResults(site, toMap, result);
  }

  return {
    mappings: [...cachedMappings, ...result.mappings],
    unmapped: [...cachedUnmapped, ...result.unmapped, ...fileUnmapped],
  };
}

/**
 * Persists freshly-resolved mappings/unmapped reasons for next time. Skips
 * caching resolved *values* for textareas -- those tend to be free-text essay
 * answers tailored to a specific job posting (see the "subjective essay
 * question" instruction in requestFieldMapping's system prompt), and reusing
 * one posting's tailored answer for another posting under the same siteKey
 * would silently submit the wrong text. A textarea that came back unmapped
 * (e.g. "requires a personal essay answer") is still safe to cache, since
 * that outcome doesn't depend on which posting it is.
 */
async function cacheNewResults(site: string, mappedFields: FormField[], result: FieldMapping): Promise<void> {
  const bySelector = new Map(mappedFields.map((f) => [f.selector, f]));
  const toCache: Record<string, CachedField> = {};
  const updatedAt = new Date().toISOString();

  for (const m of result.mappings) {
    const field = bySelector.get(m.selector);
    if (field && field.type !== "textarea") {
      toCache[fieldKey(field.label, field.type)] = { value: m.value, updatedAt };
    }
  }
  for (const u of result.unmapped) {
    const field = bySelector.get(u.selector);
    if (field) toCache[fieldKey(field.label, field.type)] = { reason: u.reason, updatedAt };
  }

  await mergeSiteCache(site, toCache);
}

async function mapFieldsIndividually(
  llmConfig: LlmConfig,
  profile: CandidateProfile,
  posting: JobPosting,
  fields: FormField[],
  onProgress?: OnProgress
): Promise<FieldMapping> {
  const mappings: FieldMapping["mappings"] = [];
  const unmapped: FieldMapping["unmapped"] = [];

  // The anyapi-daemon transport drives a real web chat UI (e.g.
  // chat.deepseek.com) through Playwright, and its daemon enforces its own
  // human-like pacing (a minimum ~3s between messages, plus burst/hourly
  // caps -- see anyapi's Limiter). One request per field here can easily
  // fire faster than that, so slow our own cadence down to match rather
  // than relying entirely on the daemon's rate-limit rejections + retries.
  const interFieldDelayMs = llmConfig.transport === "anyapi-daemon" ? 4000 : 1000;
  if (llmConfig.transport === "anyapi-daemon" && fields.length > 5) {
    onProgress?.({
      type: "status",
      message: `Mapping ${fields.length} fields one at a time over a shared web chat -- this respects its pacing/rate limits, so it may take a few minutes.`,
    });
  }

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (i > 0) {
      onProgress?.({ type: "status", message: `Waiting ${interFieldDelayMs / 1000}s to keep pace with the previous field...` });
      await new Promise((resolve) => setTimeout(resolve, interFieldDelayMs));
    }
    onProgress?.({ type: "status", message: `Mapping field "${field.label}"...` });
    try {
      const single = await withOneRetry(
        () => requestFieldMapping(llmConfig, profile, posting, [field], onProgress),
        `Mapping "${field.label}"`,
        onProgress
      );
      mappings.push(...single.mappings);
      unmapped.push(...single.unmapped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ type: "error", message: `Could not map "${field.label}": ${message}` });
      unmapped.push({ selector: field.selector, reason: `AI request failed: ${message}` });
    }
  }

  return { mappings, unmapped };
}

/**
 * Shared by every adapter's fillApplication: applies the LLM's field mapping
 * via Playwright, screenshots the result, and stops -- no submit button is
 * ever clicked here. A human reviews the open browser window and submits.
 */
export async function fillAndScreenshot(
  page: Page,
  posting: JobPosting,
  mapping: FieldMapping
): Promise<FillResult> {
  const unmapped = [...mapping.unmapped];
  let fieldsFilled = 0;

  for (const { selector, value } of mapping.mappings) {
    try {
      const locator = page.locator(selector).first();
      const tag = await locator.evaluate((el) => el.tagName.toLowerCase());
      if (tag === "select") {
        await locator.selectOption({ label: value });
      } else {
        const type = await locator.getAttribute("type");
        if (type === "checkbox" || type === "radio") {
          if (/^(true|yes)$/i.test(value)) await locator.check();
        } else {
          await locator.fill(value);
        }
      }
      fieldsFilled++;
    } catch {
      unmapped.push({ selector, reason: "Playwright could not fill this field" });
    }
  }

  await mkdir("./data/screenshots", { recursive: true });
  const screenshotPath = `./data/screenshots/${posting.id}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });

  return {
    jobUrl: posting.url,
    fieldsFilled,
    fieldsSkipped: unmapped.map((u) => ({ label: u.selector, reason: u.reason })),
    screenshotPath,
  };
}
