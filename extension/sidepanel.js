const statusEl = document.getElementById("status");
const statusTextEl = statusEl.querySelector(".status-text");
const resultEl = document.getElementById("result");
const tokenInput = document.getElementById("token");
const fillBtn = document.getElementById("fillBtn");
const fillBtnLabel = fillBtn.querySelector(".label");
const logEl = document.getElementById("log");

function setStatus(text, cls) {
  statusTextEl.textContent = text;
  statusEl.className = cls ?? "";
}

function setFillBtnBusy(busy, label) {
  fillBtn.disabled = busy;
  fillBtn.classList.toggle("loading", busy);
  fillBtnLabel.textContent = label;
}

/** A quick, silly burst of emoji confetti to celebrate a completed fill. */
function celebrate() {
  const container = document.getElementById("confetti");
  const emojis = ["🎉", "✨", "🎊", "⭐", "💜", "🚀"];
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    piece.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
    piece.style.animationDelay = `${Math.random() * 0.3}s`;
    piece.style.fontSize = `${12 + Math.random() * 12}px`;
    container.appendChild(piece);
    piece.addEventListener("animationend", () => piece.remove());
  }
}

/** Wires a dropzone label to show the chosen file's name once picked. */
function wireDropzone(inputId, dropzoneId, labelId, placeholder) {
  const input = document.getElementById(inputId);
  const dropzone = document.getElementById(dropzoneId);
  const labelEl = document.getElementById(labelId);
  input.addEventListener("change", () => {
    const file = input.files[0];
    dropzone.classList.toggle("has-file", Boolean(file));
    labelEl.textContent = file ? `📄 ${file.name}` : placeholder;
  });
}

wireDropzone("resumeFile", "resumeDrop", "resumeFileLabel", "Choose a resume (.pdf/.docx/.txt)");
wireDropzone("coverLetterFile", "coverLetterDrop", "coverLetterFileLabel", "Choose a cover letter (.pdf/.docx/.txt)");

let streamingLine = null; // the log line currently accumulating token text, if any

function logLine(kind, message) {
  streamingLine = null;
  const line = document.createElement("div");
  line.className = `log-${kind}`;
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="log-time">[${time}]</span> ${escapeHtml(message)}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function logToken(text) {
  if (!streamingLine) {
    streamingLine = document.createElement("div");
    streamingLine.className = "log-token";
    logEl.appendChild(streamingLine);
  }
  streamingLine.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function clearLog() {
  logEl.textContent = "";
  streamingLine = null;
}

// Progress events broadcast from background.js (server status/token lines)
// or from the injected page-context function (scan/send/fill stages).
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "FILL_LOG") return;
  const event = message.event;
  if (event.type === "token") {
    logToken(event.message ?? "");
  } else if (event.type === "error") {
    logLine("error", event.message ?? "Unknown error");
  } else {
    logLine("status", event.message ?? "");
  }
});

async function loadExistingData() {
  try {
    const attachmentsResponse = await chrome.runtime.sendMessage({ type: "GET_ATTACHMENTS" });
    if (attachmentsResponse.ok) {
      const { resume, coverLetter } = attachmentsResponse.data;
      if (resume) {
        document.getElementById("resumeFileLabel").textContent = `📄 ${resume.filename}`;
        document.getElementById("resumeDrop").classList.add("has-file");
      }
      if (coverLetter) {
        document.getElementById("coverLetterFileLabel").textContent = `📄 ${coverLetter.filename}`;
        document.getElementById("coverLetterDrop").classList.add("has-file");
      }
    }

    const profileResponse = await chrome.runtime.sendMessage({ type: "GET_PROFILE" });
    if (profileResponse.ok) {
      const { fullName, email, phone } = profileResponse.profile;
      resumeInfoEl.textContent = `Extracted: ${fullName} <${email}> ${phone}. Now used to fill forms instead of placeholder data.`;
      resumeInfoEl.className = "ok";
    }
  } catch (e) {
    console.error("Failed to load existing data:", e);
  }
}

async function refreshHealth() {
  const { anyjobToken } = await chrome.storage.local.get("anyjobToken");
  tokenInput.value = anyjobToken ?? "";

  if (!anyjobToken) {
    setStatus('No token saved yet -- paste the one printed by "npm run start-all".', "err");
    fillBtn.disabled = true;
    return;
  }

  const health = await chrome.runtime.sendMessage({ type: "HEALTH" });
  if (health.ok) {
    setStatus("Server reachable.", "ok");
    fillBtn.disabled = false;
    await loadExistingData();
  } else {
    setStatus(health.error, "err");
    fillBtn.disabled = true;
  }
}

document.getElementById("saveToken").addEventListener("click", async () => {
  await chrome.storage.local.set({ anyjobToken: tokenInput.value.trim() });
  await refreshHealth();
});

/** Reads a File object into a base64 string (no data: URL prefix). */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

const resumeFileInput = document.getElementById("resumeFile");
const uploadResumeBtn = document.getElementById("uploadResumeBtn");
const resumeInfoEl = document.getElementById("resumeInfo");

uploadResumeBtn.addEventListener("click", async () => {
  const file = resumeFileInput.files[0];
  if (!file) {
    resumeInfoEl.textContent = "Choose a resume file first.";
    resumeInfoEl.className = "err";
    return;
  }

  uploadResumeBtn.disabled = true;
  resumeInfoEl.textContent = "";
  clearLog();
  logLine("status", `Uploading resume "${file.name}"...`);

  try {
    const contentBase64 = await fileToBase64(file);
    const response = await chrome.runtime.sendMessage({
      type: "UPLOAD_RESUME",
      filename: file.name,
      contentBase64,
    });

    if (!response.ok) {
      resumeInfoEl.textContent = response.error;
      resumeInfoEl.className = "err";
      logLine("error", response.error);
      return;
    }

    const { fullName, email, phone } = response.data.profile;
    resumeInfoEl.textContent = `Extracted: ${fullName} <${email}> ${phone}. Now used to fill forms instead of placeholder data.`;
    resumeInfoEl.className = "ok";
    logLine("result", `Profile extracted from resume: ${fullName}.`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    resumeInfoEl.textContent = message;
    resumeInfoEl.className = "err";
    logLine("error", message);
  } finally {
    uploadResumeBtn.disabled = false;
  }
});

const coverLetterFileInput = document.getElementById("coverLetterFile");
const uploadCoverLetterBtn = document.getElementById("uploadCoverLetterBtn");
const coverLetterInfoEl = document.getElementById("coverLetterInfo");

uploadCoverLetterBtn.addEventListener("click", async () => {
  const file = coverLetterFileInput.files[0];
  if (!file) {
    coverLetterInfoEl.textContent = "Choose a cover letter file first.";
    coverLetterInfoEl.className = "err";
    return;
  }

  uploadCoverLetterBtn.disabled = true;
  coverLetterInfoEl.textContent = "";

  try {
    const contentBase64 = await fileToBase64(file);
    const response = await chrome.runtime.sendMessage({
      type: "UPLOAD_COVER_LETTER",
      filename: file.name,
      contentBase64,
    });

    if (!response.ok) {
      coverLetterInfoEl.textContent = response.error;
      coverLetterInfoEl.className = "err";
      return;
    }

    coverLetterInfoEl.textContent = `Saved "${response.data.filename}" -- will be attached to cover letter upload fields.`;
    coverLetterInfoEl.className = "ok";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    coverLetterInfoEl.textContent = message;
    coverLetterInfoEl.className = "err";
  } finally {
    uploadCoverLetterBtn.disabled = false;
  }
});

fillBtn.addEventListener("click", async () => {
  resultEl.textContent = "";
  clearLog();
  setFillBtnBusy(true, "Working...");
  setStatus("Working -- see the log below for live progress.", "");
  logLine("status", "Scanning page for form fields...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");

    const attachmentsResponse = await chrome.runtime.sendMessage({ type: "GET_ATTACHMENTS" });
    const attachments = attachmentsResponse.ok ? attachmentsResponse.data : { resume: null, coverLetter: null };

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared/formUtils.js"] });

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [attachments],
      func: async (attachments) => {
        // Runs in the job site's page, isolated from the side panel -- wrap
        // everything so a DOM/network surprise here comes back as a clean
        // {ok:false, error} instead of executeScript rejecting with an
        // opaque "an unexpected error occurred" the panel can't explain.
        try {
          const fields = anyjobScanForm();
          chrome.runtime.sendMessage({
            type: "FILL_LOG",
            event: { type: "status", message: `Found ${fields.length} labeled field(s). Asking AI to map them...` },
          });
          if (fields.length === 0) {
            return { ok: false, error: "No labeled form fields found on this page." };
          }

          const response = await chrome.runtime.sendMessage({
            type: "MAP_FIELDS",
            jobTitle: document.title,
            company: location.hostname,
            fields,
          });
          if (!response.ok) return response;

          const mapping = response.data;
          const filledFields = [];
          const skipped = [];

          const safeQuery = (selector) => {
            try {
              return document.querySelector(selector);
            } catch {
              return null;
            }
          };

          // File inputs (resume/cover letter uploads) never get a value from
          // the LLM (see mapProfileToFields) -- they show up in `unmapped`
          // with a fixed reason. Attach the real uploaded bytes to those
          // instead, matching resume vs. cover letter by the field's label.
          const fileFieldBySelector = new Map(fields.filter((f) => f.type === "file").map((f) => [f.selector, f]));

          for (const u of mapping.unmapped) {
            const fileField = fileFieldBySelector.get(u.selector);
            if (!fileField) {
              skipped.push({ selector: u.selector, reason: u.reason });
              continue;
            }

            const isCoverLetter = /cover\s*letter/i.test(fileField.label);
            const attachment = isCoverLetter ? attachments.coverLetter : attachments.resume;
            if (!attachment) {
              skipped.push({
                selector: u.selector,
                reason: `No ${isCoverLetter ? "cover letter" : "resume"} uploaded yet -- use the upload button in the side panel.`,
              });
              continue;
            }

            const r = anyjobFillFileField(u.selector, attachment.contentBase64, attachment.filename, attachment.mime);
            if (r.ok) {
              filledFields.push({ selector: u.selector, value: attachment.filename });
              const el = safeQuery(u.selector);
              if (el) el.style.outline = "2px solid #22c55e";
            } else {
              skipped.push({ selector: u.selector, reason: r.reason });
            }
          }

          for (const m of mapping.mappings) {
            const r = anyjobFillField(m.selector, m.value);
            if (r.ok) {
              filledFields.push({ selector: m.selector, value: m.value });
              const el = safeQuery(m.selector);
              if (el) el.style.outline = "2px solid #22c55e";
            } else {
              skipped.push({ selector: m.selector, reason: r.reason });
            }
          }

          for (const s of skipped) {
            const el = safeQuery(s.selector);
            if (el) {
              el.style.outline = "2px solid #ef4444";
              el.title = `anyjob: ${s.reason}`;
            }
          }

          return {
            ok: true,
            data: { filled: filledFields, skipped, total: filledFields.length + skipped.length },
          };
        } catch (e) {
          return { ok: false, error: `Unexpected error while filling the page: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    });

    const result = injection?.result ?? { ok: false, error: "The page script produced no result (tab may have navigated away)." };

    if (!result.ok) {
      setStatus(result.error, "err");
      logLine("error", result.error);
    } else {
      setStatus("Done! Review the highlighted fields, then submit yourself.", "ok");
      logLine("result", `Filled ${result.data.filled.length}/${result.data.total} fields.`);
      resultEl.innerHTML = renderResult(result.data);
      if (result.data.filled.length > 0) celebrate();
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus(message, "err");
    logLine("error", message);
  } finally {
    setFillBtnBusy(false, "Scan & Fill This Page");
  }
});

function renderResult(data) {
  let i = 0;
  const item = (cls, icon, html) => `<li class="${cls}" style="animation-delay:${i++ * 0.04}s">${icon} ${html}</li>`;
  const filledList = data.filled
    .map((f) => item("filled", "&#9989;", `<code>${escapeHtml(f.selector)}</code> = "${escapeHtml(f.value)}"`))
    .join("");
  const skippedList = data.skipped
    .map((s) => item("skipped", "&#10060;", `<code>${escapeHtml(s.selector)}</code> -- ${escapeHtml(s.reason)}`))
    .join("");
  return `<ul>${filledList}${skippedList}</ul>`;
}

refreshHealth();
