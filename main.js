import Yace from "./vendor/yace.min.js";
import tab from "./vendor/tab.js";

const DEBOUNCE_TIMEOUT_MS = 500;
const STORAGE_KEY = "iongraph-saved-code";
const DEFAULT_TEXT = `def one
  1
end

def two
  2
end

def test
  one + two
end

30.times do
  test
end
`;

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

function loadCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const codeFromUrl = urlParams.get("code");
  if (codeFromUrl) {
    try { return atob(codeFromUrl); } catch (e) {}
  }
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved !== null ? saved : DEFAULT_TEXT;
}

function saveShareUrl(code) {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("code", btoa(code));
  document.getElementById("share-url").value = url.toString();
}

function highlighter(value) {
  return hljs.highlight(value, { language: "ruby" }).value;
}

const editor = new Yace("#editor", {
  value: loadCode(),
  styles: { fontSize: "18px" },
  highlighter,
  plugins: [tab()],
  lineNumbers: true,
});
editor.textarea.spellcheck = false;
saveShareUrl(editor.value);
editor.textarea.addEventListener("input", debounce(() => {
  localStorage.setItem(STORAGE_KEY, editor.value);
  saveShareUrl(editor.value);
}, DEBOUNCE_TIMEOUT_MS));

function showOverlay(html) {
  const overlay = document.getElementById("status-overlay");
  const iongraphRoot = document.getElementById("iongraph-root");
  overlay.innerHTML = html;
  overlay.style.display = "block";
  iongraphRoot.style.display = "none";
}

function hideOverlay() {
  const overlay = document.getElementById("status-overlay");
  const iongraphRoot = document.getElementById("iongraph-root");
  overlay.style.display = "none";
  iongraphRoot.style.display = "";
}

// Web Worker for Ruby+ZJIT execution
let worker = null;
let workerReady = false;
let pendingResolve = null;

function initWorker() {
  worker = new Worker("ruby-worker.js", { type: "module" });

  worker.onmessage = (event) => {
    const { type, message } = event.data;

    if (type === "progress") {
      showOverlay(`<div class="no-functions"><strong>${message}</strong></div>`);
    } else if (type === "ready") {
      workerReady = true;
      showOverlay('<div class="no-functions"><strong>Ruby+ZJIT ready. Click Compile.</strong></div>');
      document.getElementById("execute-btn").textContent = "Compile";
      document.getElementById("execute-btn").disabled = false;
    } else if (type === "error") {
      showOverlay(`<div class="compile-fail"><strong>Load error:</strong> ${message}</div>`);
    } else if (type === "result") {
      if (pendingResolve) {
        pendingResolve(event.data);
        pendingResolve = null;
      }
    }
  };

  worker.postMessage({ type: "init", data: { wasmUrl: "ruby.wasm" } });
}

function executeInWorker(userCode) {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    worker.postMessage({ type: "execute", data: { userCode } });
  });
}

async function executeCode() {
  if (!workerReady) return;

  const code = editor.value;
  const btn = document.getElementById("execute-btn");

  btn.disabled = true;
  btn.textContent = "Compiling...";
  showOverlay('<div class="no-functions"><strong>Compiling...</strong></div>');

  try {
    const { stdout, stderr, exitCode, error } = await executeInWorker(code);

    if (error) {
      showOverlay(`<div class="compile-fail"><strong>Error:</strong> ${error}\n\n${stderr || ""}</div>`);
      return;
    }

    let result;
    try {
      result = JSON.parse(stdout.trim());
    } catch (parseErr) {
      const detail = stdout ? `stdout: ${stdout.substring(0, 500)}` : "(empty stdout)";
      const stderrDetail = stderr ? `\n\nstderr: ${stderr.substring(0, 500)}` : "";
      showOverlay(`<div class="compile-fail"><strong>Failed to parse output:</strong>\n\n${detail}${stderrDetail}\n\nexit code: ${exitCode}</div>`);
      return;
    }

    if (result.error) {
      showOverlay(`<div class="compile-fail"><strong>Ruby error:</strong> ${result.error}</div>`);
      return;
    }

    if (result.functions && result.functions.length > 0) {
      hideOverlay();
      ui.setIonJSON(result);
    } else {
      showOverlay('<div class="no-functions"><strong>No functions compiled</strong><br><br>Try adding a function that gets called at least twice.</div>');
    }
  } catch (error) {
    console.error("Execution error:", error);
    showOverlay(`<div class="compile-fail"><strong>Error:</strong> ${error.message}</div>`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Compile";
  }
}

function setupResizableGutter() {
  const gutter = document.getElementById("gutter");
  const leftPanel = document.getElementById("left-panel");
  const container = document.querySelector(".container");
  let isDragging = false;
  let lastEventType = null;
  const getClientX = (e) => e.touches ? e.touches[0].clientX : e.clientX;

  const startDrag = (e) => {
    if (e.type === "mousedown" && lastEventType === "touchstart") return;
    if (e.button !== undefined && e.button !== 0) return;
    lastEventType = e.type;
    isDragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };
  const drag = (e) => {
    if (!isDragging) return;
    if (e.type === "mousemove" && lastEventType === "touchstart") return;
    const containerRect = container.getBoundingClientRect();
    const newWidth = getClientX(e) - containerRect.left;
    const clampedWidth = Math.max(200, Math.min(newWidth, containerRect.width - 200));
    leftPanel.style.flex = "0 0 auto";
    leftPanel.style.width = `${clampedWidth}px`;
    e.preventDefault();
  };
  const stopDragging = (e) => {
    if (!isDragging) return;
    if (e.type === "mouseup" && lastEventType === "touchstart") return;
    isDragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  gutter.addEventListener("mousedown", startDrag);
  document.addEventListener("mousemove", drag);
  document.addEventListener("mouseup", stopDragging);
  document.addEventListener("mouseleave", stopDragging);
  gutter.addEventListener("touchstart", startDrag, { passive: false });
  document.addEventListener("touchmove", drag, { passive: false });
  document.addEventListener("touchend", stopDragging);
  document.addEventListener("touchcancel", stopDragging);
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("execute-btn").addEventListener("click", executeCode);
  setupResizableGutter();
  initWorker();
});
