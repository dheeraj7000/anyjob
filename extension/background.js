/**
 * Service worker: the only piece of the extension allowed to talk to the
 * local anyjob server. Content scripts run in the job site's own page and
 * never call fetch() directly against localhost -- everything is relayed
 * through here, gated by the token the user pastes into the popup once.
 *
 * The anyjob server automates a single shared browser session underneath
 * (for the anyapi-daemon LLM transport) and can only handle one request at
 * a time -- do not fire concurrent MAP_FIELDS calls.
 */

// Make clicking the toolbar icon open the side panel (which stays docked and
// open across tab navigation) instead of a popup that closes on any outside
// click. Must be set at startup, not just onInstalled, so it's re-applied
// after the service worker is evicted/restarted.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const SERVER_BASE = "http://127.0.0.1:4173";

async function getToken() {
  const { anyjobToken } = await chrome.storage.local.get("anyjobToken");
  return anyjobToken ?? "";
}

async function callServer(path, options = {}) {
  const token = await getToken();
  if (!token) {
    return { ok: false, error: "No token set. Open the side panel and paste your anyjob server token first." };
  }

  try {
    const res = await fetch(`${SERVER_BASE}${path}`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data.error ?? `Server returned ${res.status}` };
    }
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach anyjob server at ${SERVER_BASE} -- is "npm run start-all" running? (${e})`,
    };
  }
}

/** Broadcasts a log line to the side panel (fire-and-forget; the panel may
 *  not be open, in which case this silently has no listener). */
function logToPanel(event) {
  chrome.runtime.sendMessage({ type: "FILL_LOG", event }).catch(() => {});
}

/**
 * Same as callServer, but for endpoints that stream newline-delimited JSON
 * progress events (see src/server.ts's /api/map-fields) instead of a single
 * response body. Each non-final line is forwarded live to the side panel;
 * the function itself resolves only once the terminal "result"/"error" line
 * arrives.
 */
async function callServerStreaming(path, options = {}) {
  const token = await getToken();
  if (!token) {
    return { ok: false, error: "No token set. Open the side panel and paste your anyjob server token first." };
  }

  let res;
  try {
    res = await fetch(`${SERVER_BASE}${path}`, {
      ...options,
      headers: { ...(options.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach anyjob server at ${SERVER_BASE} -- is "npm run start-all" running? (${e})`,
    };
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data.error ?? `Server returned ${res.status}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // stray non-JSON output; ignore rather than fail the whole call
      }

      if (event.type === "result") return { ok: true, data: event.data };
      if (event.type === "error") return { ok: false, error: event.message };
      logToPanel(event); // status/token progress line
    }
  }

  return { ok: false, error: "Server closed the connection without a final result." };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "HEALTH") {
    callServer("/api/health").then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (message.type === "MAP_FIELDS") {
    callServerStreaming("/api/map-fields", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobTitle: message.jobTitle,
        company: message.company,
        siteKey: message.siteKey,
        fields: message.fields,
      }),
    }).then(sendResponse);
    return true;
  }

  if (message.type === "UPLOAD_RESUME") {
    callServerStreaming("/api/upload-resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: message.filename, contentBase64: message.contentBase64 }),
    }).then(sendResponse);
    return true;
  }

  if (message.type === "UPLOAD_COVER_LETTER") {
    callServer("/api/upload-cover-letter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: message.filename, contentBase64: message.contentBase64 }),
    }).then(sendResponse);
    return true;
  }

  if (message.type === "GET_ATTACHMENTS") {
    callServer("/api/attachments").then(sendResponse);
    return true;
  }

  if (message.type === "GET_PROFILE") {
    callServer("/api/profile").then(sendResponse);
    return true;
  }

  return false;
});
