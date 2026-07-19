import type { BrowserContext, Page } from "playwright";
import type { JobSiteAdapter, JobPosting, FillResult } from "../adapter.js";
import type { CandidateProfile } from "../../profile/types.js";
import { extractFormFields, mapProfileToFields, fillAndScreenshot } from "../../apply/formFields.js";
import { loadLlmConfig } from "../../config.js";

/**
 * Adapter for Greenhouse-hosted job boards (boards.greenhouse.io/<company>).
 * Greenhouse listings and application forms are public -- no login step --
 * which makes this a good second reference implementation proving the
 * JobSiteAdapter interface generalizes beyond Workday's authenticated flow.
 */
export function createGreenhouseAdapter(siteKey: string): JobSiteAdapter {
  return {
    siteKey,

    async login(_context: BrowserContext) {
      // No-op: Greenhouse job boards and applications don't require auth.
    },

    async scrapeListings(page: Page, searchUrl: string): Promise<JobPosting[]> {
      await page.goto(searchUrl);
      await page.waitForSelector("a.job-post, div.opening", { timeout: 15_000 });

      return page.$$eval("a.job-post, div.opening a", (links) =>
        links.map((a) => {
          const href = a.getAttribute("href") ?? "";
          return {
            id: href.split("/").pop() ?? href,
            title: a.textContent?.trim() ?? "",
            company: "",
            location: a.closest("div.opening")?.querySelector(".location")?.textContent?.trim() ?? "",
            url: href.startsWith("http") ? href : new URL(href, location.origin).toString(),
            description: "",
          };
        })
      );
    },

    async scrapeJobDetail(page: Page, posting: JobPosting): Promise<JobPosting> {
      await page.goto(posting.url);
      await page.waitForSelector("#content, .job__description", { timeout: 15_000 });
      const description = await page
        .locator("#content, .job__description")
        .first()
        .innerText();
      return { ...posting, description };
    },

    async fillApplication(page: Page, posting: JobPosting, profile: CandidateProfile): Promise<FillResult> {
      await page.goto(posting.url);
      const applyLink = page.getByRole("link", { name: /apply/i }).first();
      if (await applyLink.isVisible().catch(() => false)) {
        await applyLink.click();
      }
      await page.waitForSelector("#application_form, form#application-form", { timeout: 15_000 });

      const fields = await extractFormFields(page);
      const llmConfig = loadLlmConfig();
      const mapping = await mapProfileToFields(llmConfig, profile, posting, fields);

      return fillAndScreenshot(page, posting, mapping);
    },
  };
}
