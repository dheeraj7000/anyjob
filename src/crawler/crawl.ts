import { chromium } from "playwright";
import type { JobSiteAdapter } from "../sites/adapter.js";
import { upsertJobs } from "../storage/db.js";

export interface CrawlOptions {
  headless?: boolean;
  detail?: boolean; // also visit each posting to scrape full description
}

/** Logs in (if needed), scrapes listings from searchUrl, persists new postings to storage/db. */
export async function crawlSite(
  adapter: JobSiteAdapter,
  searchUrl: string,
  options: CrawlOptions = {}
): Promise<number> {
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext();

  try {
    await adapter.login(context);
    const page = await context.newPage();

    let postings = await adapter.scrapeListings(page, searchUrl);

    if (options.detail) {
      const withDetail = [];
      for (const posting of postings) {
        withDetail.push(await adapter.scrapeJobDetail(page, posting));
      }
      postings = withDetail;
    }

    return upsertJobs(adapter.siteKey, postings);
  } finally {
    await browser.close();
  }
}
