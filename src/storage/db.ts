import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobPosting } from "../sites/adapter.js";

export type ApplicationStatus = "scraped" | "filled" | "applied" | "skipped";

export interface JobRecord extends JobPosting {
  siteKey: string;
  status: ApplicationStatus;
  scrapedAt: string;
}

const DB_PATH = "./data/jobs.json";

async function readAll(): Promise<JobRecord[]> {
  if (!existsSync(DB_PATH)) return [];
  const raw = await readFile(DB_PATH, "utf-8");
  return raw.trim() ? JSON.parse(raw) : [];
}

async function writeAll(records: JobRecord[]): Promise<void> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(records, null, 2), "utf-8");
}

/** Inserts new postings, skipping any (siteKey, id) pair already stored. */
export async function upsertJobs(siteKey: string, postings: JobPosting[]): Promise<number> {
  const existing = await readAll();
  const seen = new Set(existing.map((r) => `${r.siteKey}:${r.id}`));

  const fresh = postings
    .filter((p) => !seen.has(`${siteKey}:${p.id}`))
    .map((p): JobRecord => ({ ...p, siteKey, status: "scraped", scrapedAt: new Date().toISOString() }));

  await writeAll([...existing, ...fresh]);
  return fresh.length;
}

export async function listJobs(filter?: { siteKey?: string; status?: ApplicationStatus }): Promise<JobRecord[]> {
  const all = await readAll();
  return all.filter(
    (r) => (!filter?.siteKey || r.siteKey === filter.siteKey) && (!filter?.status || r.status === filter.status)
  );
}

export async function updateJobStatus(siteKey: string, id: string, status: ApplicationStatus): Promise<void> {
  const all = await readAll();
  const record = all.find((r) => r.siteKey === siteKey && r.id === id);
  if (record) record.status = status;
  await writeAll(all);
}
