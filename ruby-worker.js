// Web Worker that runs Ruby+ZJIT in a separate thread.

import {
  WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, WASIProcExit
} from "./vendor/browser_wasi_shim/index.js";

let wasmModule = null;

self.onmessage = async (event) => {
  const { type, data } = event.data;

  if (type === "init") {
    try {
      const response = await fetch(data.wasmUrl);
      const total = parseInt(response.headers.get("content-length") || "0", 10);
      let loaded = 0;
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (total > 0) {
          self.postMessage({ type: "progress", message: `Downloading Ruby+ZJIT... ${Math.round(loaded/total*100)}% (${(loaded/1048576).toFixed(1)} MB)` });
        }
      }
      const wasmBytes = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) { wasmBytes.set(chunk, offset); offset += chunk.length; }

      self.postMessage({ type: "progress", message: "Compiling WebAssembly module..." });
      wasmModule = await WebAssembly.compile(wasmBytes);
      self.postMessage({ type: "ready" });
    } catch (e) {
      self.postMessage({ type: "error", message: `Failed to load: ${e.message}` });
    }
    return;
  }

  if (type === "execute") {
    if (!wasmModule) {
      self.postMessage({ type: "result", error: "Module not loaded" });
      return;
    }
    try {
      const result = await runRuby(wasmModule, data.userCode);
      self.postMessage({ type: "result", ...result });
    } catch (e) {
      self.postMessage({ type: "result", error: e.message, stdout: "", stderr: e.stack || "" });
    }
    return;
  }
};

async function runRuby(module, userCode) {
  let stdoutBuf = "";
  let stderrBuf = "";

  const stdout = new ConsoleStdout((chunk) => {
    stdoutBuf += new TextDecoder().decode(chunk);
  });
  const stderr = new ConsoleStdout((chunk) => {
    stderrBuf += new TextDecoder().decode(chunk);
  });

  const fds = [
    new OpenFile(new File(new Uint8Array())), // stdin
    stdout,
    stderr,
  ];

  // User code is passed via the C env variable to avoid args length limits.
  // The -e script is kept very short to avoid WASI buffer overflow.
  // We use a two-pass approach: -e for setup, and the C env for user code.
  const script = 'eval(ENV["C"],TOPLEVEL_BINDING,"(input)",1);j=[];Object.private_instance_methods(false).each{|n|m=method(n);next if !m.source_location||m.source_location[0]!="(input)";r=RubyVM::ZJIT.dump_iongraph(m);j<<r if r};a=j.map{|x|x[x.index(%q("functions":[))+13...(x.rindex("]"))]};puts %Q({"version":1,"functions":[#{a.join(",")}]})';

  const wasi = new WASI(
    ["ruby", "--zjit", "--zjit-call-threshold=1", "-e", script],
    ["C=" + userCode],
    fds,
    { debug: false }
  );

  let exitCode = 0;
  try {
    const instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi.wasiImport,
    });
    wasi.initialize(instance);
    instance.exports._start();
  } catch (e) {
    if (e instanceof WASIProcExit) {
      exitCode = e.code;
    } else if (e && e.constructor && e.constructor.name === "WASIProcExit") {
      exitCode = e.code || 0;
    } else {
      stderrBuf += "\n" + String(e);
      exitCode = 1;
    }
  }

  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
}
