import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chatStructured } from "../llm/provider.js";
import type { LlmConfig, OnProgress } from "../llm/provider.js";
import { CandidateProfileSchema, type CandidateProfile } from "./types.js";

/** Extracts raw text from a resume file buffer given its extension (".pdf"/".docx"/".txt"). */
export async function extractResumeText(buf: Buffer, ext: string): Promise<string> {
  ext = ext.toLowerCase();

  if (ext === ".pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const { text } = await pdfParse(buf);
    return text;
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (ext === ".txt") {
    return buf.toString("utf-8");
  }
  throw new Error(`Unsupported resume format: ${ext} (use .pdf, .docx, or .txt)`);
}

/** Parses resume text (already extracted) into a structured candidate profile via the LLM. */
export async function parseResumeTextToProfile(
  llmConfig: LlmConfig,
  text: string,
  onProgress?: OnProgress
): Promise<CandidateProfile> {
  return chatStructured(
    llmConfig,
    [
      {
        role: "system",
        content:
          "Extract a structured candidate profile from the resume text. " +
          "Use the candidate's real name, email, phone, and other details exactly " +
          "as they appear in the resume text -- never invent or substitute placeholder " +
          "values. If work authorization or sponsorship status isn't stated, use " +
          '"Not specified" / false as sensible defaults rather than guessing citizenship status.',
      },
      { role: "user", content: text },
    ],
    CandidateProfileSchema,
    "candidate_profile",
    onProgress
  );
}

/** Parses a resume file (given a buffer + extension) into a structured profile. */
export async function parseResumeBufferToProfile(
  llmConfig: LlmConfig,
  buf: Buffer,
  ext: string,
  onProgress?: OnProgress
): Promise<CandidateProfile> {
  const text = await extractResumeText(buf, ext);
  return parseResumeTextToProfile(llmConfig, text, onProgress);
}

/** Parses a resume file on disk into a structured profile. */
export async function parseResumeToProfile(
  llmConfig: LlmConfig,
  resumePath: string
): Promise<CandidateProfile> {
  const ext = extname(resumePath);
  const buf = await readFile(resumePath);
  return parseResumeBufferToProfile(llmConfig, buf, ext);
}
