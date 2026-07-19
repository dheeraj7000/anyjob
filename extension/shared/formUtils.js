/**
 * Single source of truth for scanning + filling job application forms.
 * Runs in two different browser contexts:
 *  - Playwright's page.evaluate() (src/apply/formFields.ts loads this file's
 *    source and evaluates it directly in the automated Chromium page)
 *  - The anyjob browser extension's content script (extension/content/fillPage.js
 *    includes this file directly via manifest.json "js" array)
 * Both environments are a real DOM in a real browser, so the same vanilla JS
 * works unmodified in either. No imports/exports -- everything here is a
 * plain global function.
 */

function anyjobLabelFor(el) {
  const id = el.getAttribute("id");
  if (id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lbl && lbl.textContent && lbl.textContent.trim()) return lbl.textContent.trim();
  }
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(" ")
      .map((id) => {
        const target = document.getElementById(id);
        return target && target.textContent ? target.textContent.trim() : "";
      })
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }
  const parentLabel = el.closest("label");
  if (parentLabel && parentLabel.textContent && parentLabel.textContent.trim()) {
    return parentLabel.textContent.trim();
  }
  return "";
}

function anyjobSelectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const name = el.getAttribute("name");
  if (name) return `[name="${CSS.escape(name)}"]`;
  const auto = el.closest("[data-automation-id]");
  const autoId = auto ? auto.getAttribute("data-automation-id") : null;
  const tag = el.tagName.toLowerCase();
  return autoId ? `[data-automation-id="${CSS.escape(autoId)}"] ${tag}` : tag;
}

/** Scans the current page for labeled form fields. Returns FormField[]. */
function anyjobScanForm() {
  const fields = [];
  const elements = document.querySelectorAll("input, textarea, select");

  elements.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const inputType = el.type;
    if (inputType === "hidden" || inputType === "submit" || inputType === "button") return;

    const label = anyjobLabelFor(el);
    if (!label) return;

    let type = "unknown";
    let options;

    if (tag === "textarea") type = "textarea";
    else if (tag === "select") {
      type = "select";
      options = Array.from(el.options).map((o) => o.text.trim());
    } else if (inputType === "checkbox") type = "checkbox";
    else if (inputType === "radio") type = "radio";
    else if (inputType === "file") type = "file";
    else type = "text";

    fields.push({ selector: anyjobSelectorFor(el), label, type, options });
  });

  return fields;
}

/**
 * Fills one field via direct DOM manipulation, dispatching the input/change
 * events React/Vue/etc. listen for. Used only by the extension -- Playwright
 * fills through its own locator API instead (see fillAndScreenshot in
 * src/apply/formFields.ts), which already handles this correctly.
 */
function anyjobFillField(selector, value) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    return { ok: false, reason: `invalid selector: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!el) return { ok: false, reason: "selector not found" };

  const tag = el.tagName.toLowerCase();
  try {
    if (tag === "select") {
      const option = Array.from(el.options).find((o) => o.text.trim() === value);
      if (!option) return { ok: false, reason: "option not found" };
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.type === "checkbox" || el.type === "radio") {
      if (/^(true|yes)$/i.test(value)) {
        el.click();
      }
    } else {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        "value"
      ).set;
      nativeSetter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

/**
 * Attaches an in-memory file to a <input type="file"> via the DataTransfer
 * trick (the only way to script a file input's value -- direct assignment is
 * blocked by browsers). Used only by the extension, to attach the resume/cover
 * letter the user uploaded through the side panel. `base64` is the file's
 * raw bytes, base64-encoded (as returned by the local anyjob server).
 */
function anyjobFillFileField(selector, base64, filename, mime) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    return { ok: false, reason: `invalid selector: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!el) return { ok: false, reason: "selector not found" };
  if (el.type !== "file") return { ok: false, reason: "not a file input" };

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], filename, { type: mime });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    el.files = dataTransfer.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
