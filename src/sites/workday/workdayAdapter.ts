import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { JobSiteAdapter, JobPosting, FillResult } from "../adapter.js";
import type { CandidateProfile } from "../../profile/types.js";
import { extractFormFields, mapProfileToFields, fillAndScreenshot } from "../../apply/formFields.js";
import { loadLlmConfig, loadSiteCredentials, getStorageStateDir } from "../../config.js";

/**
 * Adapter for Workday-hosted career sites (e.g. myworkday.com/<tenant>).
 * Login uses a real credential flow -- never accepts session cookies --
 * and caches Playwright storageState per tenant so re-runs skip the login.
 */
export function createWorkdayAdapter(siteKey: string): JobSiteAdapter {
  const storagePath = join(getStorageStateDir(), `${siteKey}.json`);

  return {
    siteKey,

    async login(context: BrowserContext) {
      if (existsSync(storagePath)) return; // reuse cached session

      const creds = loadSiteCredentials(siteKey);
      const page = await context.newPage();
      await page.goto(creds.url);

      await page.getByLabel(/username|email/i).fill(creds.username);
      await page.getByLabel(/password/i).fill(creds.password);
      await page.getByRole("button", { name: /sign in|log in/i }).click();

      // Workday post-login lands on the candidate home; wait for something
      // stable there before considering login successful.
      await page.waitForURL(/\/(home|d)\//, { timeout: 30_000 });

      await mkdir(getStorageStateDir(), { recursive: true });
      await context.storageState({ path: storagePath });
      await page.close();
    },

    async scrapeListings(page: Page, searchUrl: string): Promise<JobPosting[]> {
      await page.goto(searchUrl);
      await page.waitForSelector('[data-automation-id="jobResults"]', { timeout: 15_000 });

      return page.$$eval('[data-automation-id="jobResults"] li', (items) =>
        items.map((li) => {
          const link = li.querySelector("a");
          const titleEl = li.querySelector('[data-automation-id="jobTitle"]');
          const locEl = li.querySelector('[data-automation-id="locations"]');
          const postedEl = li.querySelector('[data-automation-id="postedOn"]');
          const href = link?.getAttribute("href") ?? "";
          return {
            id: href.split("/").pop() ?? href,
            title: titleEl?.textContent?.trim() ?? "",
            company: "",
            location: locEl?.textContent?.trim() ?? "",
            url: href.startsWith("http") ? href : new URL(href, location.origin).toString(),
            description: "",
            postedDate: postedEl?.textContent?.trim(),
          };
        })
      );
    },

    async scrapeJobDetail(page: Page, posting: JobPosting): Promise<JobPosting> {
      await page.goto(posting.url);
      await page.waitForSelector('[data-automation-id="jobPostingDescription"]', { timeout: 15_000 });
      const description = await page
        .locator('[data-automation-id="jobPostingDescription"]')
        .innerText();
      const company = await page
        .locator('[data-automation-id="company"]')
        .innerText()
        .catch(() => "");
      return { ...posting, description, company: company || posting.company };
    },

    async fillApplication(page: Page, posting: JobPosting, profile: CandidateProfile): Promise<FillResult> {
      await page.goto(posting.url);
      await page.getByRole("button", { name: /apply/i }).first().click();
      await page.waitForLoadState("networkidle");

      const fields = await extractFormFields(page);
      const llmConfig = loadLlmConfig();
      const mapping = await mapProfileToFields(llmConfig, profile, posting, fields);

      return fillAndScreenshot(page, posting, mapping);
    },
  };
}
