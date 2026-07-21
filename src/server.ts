import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { loadLlmConfig } from "./config.js";
import { mapProfileToFields, type FormField } from "./apply/formFields.js";
import { parseResumeBufferToProfile } from "./profile/resumeParser.js";
import { clearFieldCache } from "./storage/fieldCache.js";
import type { JobPosting } from "./sites/adapter.js";

const PORT = Number(process.env.ANYJOB_SERVER_PORT ?? 4173);
const TOKEN_PATH = "./data/extension-token.txt";
const PROFILE_PATH = "./data/profile.json";
const UPLOADS_DIR = "./data/uploads";
const ATTACHMENTS_PATH = "./data/attachments.json";

interface AttachmentMeta {
  filename: string;
  mime: string;
  storedPath: string;
}
type Attachments = { resume?: AttachmentMeta; coverLetter?: AttachmentMeta };

async function readAttachments(): Promise<Attachments> {
  if (!existsSync(ATTACHMENTS_PATH)) return {};
  return JSON.parse(await readFile(ATTACHMENTS_PATH, "utf-8"));
}

async function writeAttachments(attachments: Attachments): Promise<void> {
  await mkdir("./data", { recursive: true });
  await writeFile(ATTACHMENTS_PATH, JSON.stringify(attachments, null, 2), "utf-8");
}

/** Guesses a MIME type from a file extension for the handful of formats this tool cares about. */
function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

/** Saves an uploaded (base64) file under data/uploads/, tagged by kind ("resume"/"cover-letter"). */
async function storeUpload(kind: string, filename: string, contentBase64: string): Promise<AttachmentMeta> {
  const ext = extname(filename) || ".bin";
  await mkdir(UPLOADS_DIR, { recursive: true });
  const storedPath = `${UPLOADS_DIR}/${kind}${ext}`;
  await writeFile(storedPath, Buffer.from(contentBase64, "base64"));
  return { filename, mime: mimeFor(ext), storedPath };
}

async function getOrCreateToken(): Promise<string> {
  if (existsSync(TOKEN_PATH)) {
    return (await readFile(TOKEN_PATH, "utf-8")).trim();
  }
  const token = randomBytes(24).toString("hex");
  await mkdir("./data", { recursive: true });
  await writeFile(TOKEN_PATH, token, "utf-8");
  return token;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function main() {
  const token = await getOrCreateToken();
  console.log(`anyjob server starting on http://127.0.0.1:${PORT}`);
  console.log(`Extension token (paste into the popup once): ${token}`);
  console.log(`Also saved at ${TOKEN_PATH}`);

  const server = createServer(async (req, res) => {
    // Only the extension's background service worker calls this -- bound to
    // localhost and gated by a token so a random web page visiting
    // http://127.0.0.1:PORT can't quietly read your profile or trigger fills.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      if (req.method === "GET" && req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && req.url === "/api/map-fields") {
        if (!existsSync(PROFILE_PATH)) {
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ error: 'No cached profile. Run "npm run parse-resume" first.' }));
          return;
        }

        const body = JSON.parse(await readBody(req)) as {
          jobTitle?: string;
          company?: string;
          siteKey?: string;
          fields: FormField[];
        };
        const profile = JSON.parse(await readFile(PROFILE_PATH, "utf-8"));
        const llmConfig = loadLlmConfig();
        const posting: JobPosting = {
          id: "extension",
          title: body.jobTitle ?? "",
          company: body.company ?? "",
          location: "",
          url: "",
          description: "",
        };

        // Streamed newline-delimited JSON instead of one final response --
        // {"type":"status"|"token", ...} lines as progress happens, then
        // exactly one {"type":"result"|"error", ...} line to close it out.
        // Once writeHead(200) below has run, all failures must be reported
        // as an "error" line (not a different HTTP status) -- headers are
        // already sent by then.
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const send = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);

        try {
          const mapping = await mapProfileToFields(
            llmConfig,
            profile,
            posting,
            body.fields,
            (event) => send(event),
            body.siteKey
          );
          send({ type: "result", data: mapping });
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          res.end();
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/upload-resume") {
        const body = JSON.parse(await readBody(req)) as { filename?: string; contentBase64?: string };
        if (!body.filename || !body.contentBase64) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "filename and contentBase64 are required" }));
          return;
        }

        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const send = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);

        try {
          send({ type: "status", message: `Saving ${body.filename}...` });
          const meta = await storeUpload("resume", body.filename, body.contentBase64);

          send({ type: "status", message: "Extracting resume text..." });
          const buf = await readFile(meta.storedPath);
          const llmConfig = loadLlmConfig();
          const ext = extname(body.filename);

          send({ type: "status", message: "Asking AI to extract your real name and details from the resume..." });
          const profile = await parseResumeBufferToProfile(llmConfig, buf, ext, (event) => send(event));
          await writeFile(PROFILE_PATH, JSON.stringify(profile, null, 2), "utf-8");
          // The candidate's details just changed -- any remembered field
          // answers from before (name, address, etc.) may now be stale.
          await clearFieldCache();

          const attachments = await readAttachments();
          attachments.resume = meta;
          await writeAttachments(attachments);

          send({ type: "result", data: { profile } });
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          res.end();
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/upload-cover-letter") {
        const body = JSON.parse(await readBody(req)) as { filename?: string; contentBase64?: string };
        if (!body.filename || !body.contentBase64) {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "filename and contentBase64 are required" }));
          return;
        }

        const meta = await storeUpload("cover-letter", body.filename, body.contentBase64);
        const attachments = await readAttachments();
        attachments.coverLetter = meta;
        await writeAttachments(attachments);

        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, filename: meta.filename }));
        return;
      }

      if (req.method === "GET" && req.url === "/api/attachments") {
        const attachments = await readAttachments();
        const load = async (meta?: AttachmentMeta) => {
          if (!meta || !existsSync(meta.storedPath)) return null;
          const buf = await readFile(meta.storedPath);
          return { filename: meta.filename, mime: meta.mime, contentBase64: buf.toString("base64") };
        };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            resume: await load(attachments.resume),
            coverLetter: await load(attachments.coverLetter),
          })
        );
        return;
      }

      if (req.method === "GET" && req.url === "/api/profile") {
        if (existsSync(PROFILE_PATH)) {
          const profile = JSON.parse(await readFile(PROFILE_PATH, "utf-8"));
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, profile }));
        } else {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "profile not found" }));
        }
        return;
      }

      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  server.listen(PORT, "127.0.0.1");
}

main();
