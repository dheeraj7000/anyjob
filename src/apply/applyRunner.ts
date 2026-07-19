import { chromium } from "playwright";
import type { JobSiteAdapter } from "../sites/adapter.js";
import type { CandidateProfile } from "../profile/types.js";
import type { JobRecord } from "../storage/db.js";
import { updateJobStatus } from "../storage/db.js";
import type { FillResult } from "../sites/adapter.js";

/**
 * Opens a real (non-headless) browser window, logs in, fills the
 * application for one job, and STOPS -- it never clicks submit. You review
 * the filled form yourself in that window and submit manually.
 */
export async function applyToJob(
  adapter: JobSiteAdapter,
  job: JobRecord,
  profile: CandidateProfile
): Promise<FillResult> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  try {
    await adapter.login(context);
    const page = await context.newPage();

    const result = await adapter.fillApplication(page, job, profile);
    await updateJobStatus(job.siteKey, job.id, "filled");

    console.log(`\nApplication filled for: ${job.title} (${job.company})`);
    console.log(`  Fields filled: ${result.fieldsFilled}`);
    if (result.fieldsSkipped.length) {
      console.log(`  Needs your input:`);
      result.fieldsSkipped.forEach((f) => console.log(`    - ${f.label}: ${f.reason}`));
    }
    console.log(`  Screenshot: ${result.screenshotPath}`);
    console.log(`  Review the open browser window and click Submit yourself when ready.\n`);

    // Intentionally leave the browser open for manual review + submit.
    // The caller's process should not exit until the user is done; the CLI
    // command waits on stdin before closing.
    return result;
  } catch (err) {
    await browser.close();
    throw err;
  }
}
