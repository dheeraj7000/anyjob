import { mkdir, readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { z } from "zod";
import { chatStructured } from "../llm/provider.js";
import type { LlmConfig, OnProgress } from "../llm/provider.js";
import type { CandidateProfile } from "../profile/types.js";
import type { JobPosting, FillResult } from "../sites/adapter.js";

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
 */
export async function mapProfileToFields(
  llmConfig: LlmConfig,
  profile: CandidateProfile,
  posting: JobPosting,
  fields: FormField[],
  onProgress?: OnProgress
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

  let result: FieldMapping;
  try {
    onProgress?.({ type: "status", message: `Asking AI to map all ${textFields.length} field(s) in one request...` });
    result = await withOneRetry(() => requestFieldMapping(llmConfig, profile, posting, textFields, onProgress), "Batch mapping", onProgress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({
      type: "status",
      message: `Batch mapping failed (${message}). Falling back to mapping each field individually so one failure doesn't lose the rest...`,
    });
    result = await mapFieldsIndividually(llmConfig, profile, posting, textFields, onProgress);
  }

  return { mappings: result.mappings, unmapped: [...result.unmapped, ...fileUnmapped] };
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

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (i > 0) {
      onProgress?.({ type: "status", message: "Waiting 1s to prevent rate limits..." });
      await new Promise((resolve) => setTimeout(resolve, 1000));
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
