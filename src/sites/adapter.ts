import type { BrowserContext, Page } from "playwright";
import type { CandidateProfile } from "../profile/types.js";

export interface JobPosting {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  postedDate?: string;
}

export interface FillResult {
  jobUrl: string;
  fieldsFilled: number;
  fieldsSkipped: { label: string; reason: string }[];
  screenshotPath: string;
  /**
   * Deliberately no `submitted` field: this tool fills the application and
   * stops. A human reviews the filled form in the open browser window and
   * clicks submit themselves.
   */
}

/**
 * One adapter per job site/ATS (Workday, Greenhouse, Lever, ...).
 * `login` must drive a real credential-based login flow (never accept raw
 * cookies) and persist Playwright storageState so subsequent runs skip it.
 */
export interface JobSiteAdapter {
  readonly siteKey: string;

  /** Logs in via credentials if no valid stored session exists. Idempotent. */
  login(context: BrowserContext): Promise<void>;

  /** Crawls the postings/search-results list into structured JobPosting stubs. */
  scrapeListings(page: Page, searchUrl: string): Promise<JobPosting[]>;

  /** Visits a single posting to pull full description text. */
  scrapeJobDetail(page: Page, posting: JobPosting): Promise<JobPosting>;

  /**
   * Navigates to the application form and fills fields using the mapping
   * the caller provides (see apply/applyRunner.ts for how the mapping is
   * produced via the LLM). Leaves the page open, un-submitted.
   */
  fillApplication(
    page: Page,
    posting: JobPosting,
    profile: CandidateProfile
  ): Promise<FillResult>;
}
