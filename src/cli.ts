#!/usr/bin/env node
import { Command } from "commander";
import { chromium } from "playwright";
import { createWorkdayAdapter } from "./sites/workday/workdayAdapter.js";
import { createGreenhouseAdapter } from "./sites/greenhouse/greenhouseAdapter.js";
import type { JobSiteAdapter } from "./sites/adapter.js";
import { crawlSite } from "./crawler/crawl.js";
import { listJobs } from "./storage/db.js";
import { applyToJob } from "./apply/applyRunner.js";
import { parseResumeToProfile } from "./profile/resumeParser.js";
import { loadLlmConfig, getResumePath } from "./config.js";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const PROFILE_CACHE_PATH = "./data/profile.json";

function getAdapter(siteKey: string): JobSiteAdapter {
  if (siteKey.startsWith("workday:")) return createWorkdayAdapter(siteKey.split(":")[1]);
  if (siteKey.startsWith("greenhouse:")) return createGreenhouseAdapter(siteKey.split(":")[1]);
  throw new Error(`Unknown site key "${siteKey}". Use "workday:<name>" or "greenhouse:<name>".`);
}

const program = new Command();
program.name("anyjob").description("Crawl job postings and AI-fill applications for manual review/submit.");

program
  .command("login")
  .argument("<siteKey>", 'e.g. "workday:asu"')
  .description("Run (or refresh) the login flow for a site and cache the session.")
  .action(async (siteKey: string) => {
    const adapter = getAdapter(siteKey);
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    await adapter.login(context);
    console.log(`Logged in and cached session for ${siteKey}`);
    await browser.close();
  });

program
  .command("crawl")
  .argument("<siteKey>", 'e.g. "workday:asu"')
  .argument("<searchUrl>", "URL of the job search/listings page")
  .option("--detail", "also visit each posting for full description text", false)
  .description("Scrape job postings into data/jobs.json")
  .action(async (siteKey: string, searchUrl: string, opts: { detail: boolean }) => {
    const adapter = getAdapter(siteKey);
    const added = await crawlSite(adapter, searchUrl, { detail: opts.detail });
    console.log(`Added ${added} new posting(s) to data/jobs.json`);
  });

program
  .command("list")
  .option("--site <siteKey>", "filter by site key")
  .option("--status <status>", "filter by status (scraped|filled|applied|skipped)")
  .description("List stored job postings")
  .action(async (opts: { site?: string; status?: string }) => {
    const jobs = await listJobs({ siteKey: opts.site, status: opts.status as any });
    jobs.forEach((j) => console.log(`[${j.status}] ${j.siteKey} ${j.id}  ${j.title} — ${j.company} (${j.url})`));
    console.log(`\n${jobs.length} job(s)`);
  });

program
  .command("parse-resume")
  .argument("[resumePath]", "path to resume file (.pdf/.docx/.txt)", undefined)
  .description("Parse your resume into a structured profile cached at data/profile.json")
  .action(async (resumePath?: string) => {
    const llmConfig = loadLlmConfig();
    const path = resumePath ?? getResumePath();
    const profile = await parseResumeToProfile(llmConfig, path);
    await writeFile(PROFILE_CACHE_PATH, JSON.stringify(profile, null, 2), "utf-8");
    console.log(`Profile parsed and cached at ${PROFILE_CACHE_PATH}`);
  });

program
  .command("apply")
  .argument("<siteKey>", 'e.g. "workday:asu"')
  .argument("<jobId>", "job id as stored in data/jobs.json")
  .description("Open a browser, log in, AI-fill the application, then wait for you to review and submit.")
  .action(async (siteKey: string, jobId: string) => {
    if (!existsSync(PROFILE_CACHE_PATH)) {
      console.error(`No cached profile found. Run "npm run parse-resume" first.`);
      process.exitCode = 1;
      return;
    }
    const profile = JSON.parse(await readFile(PROFILE_CACHE_PATH, "utf-8"));
    const jobs = await listJobs({ siteKey });
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      console.error(`No job with id "${jobId}" found for site "${siteKey}". Run "npm run crawl" first.`);
      process.exitCode = 1;
      return;
    }

    const adapter = getAdapter(siteKey);
    await applyToJob(adapter, job, profile);

    console.log("Press Enter here once you've reviewed/submitted in the browser to exit...");
    await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  });

program.parseAsync(process.argv);
