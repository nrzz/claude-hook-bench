// Run an http hook: post the event's JSON to the hook's url using node:http or node:https.
// Headers are sent with their $VAR references filled only for variables listed in allowedEnvVars.
import http from "node:http";
import https from "node:https";

/** Resolve $VAR and ${VAR} in headers, filling only variables listed in allowedEnvVars. */
export function resolveHeaders(rawHeaders, allowedEnvVars, env = process.env) {
  const headers = {};
  if (!rawHeaders || typeof rawHeaders !== "object") return headers;
  const allowed = new Set(Array.isArray(allowedEnvVars) ? allowedEnvVars : []);
  for (const [key, val] of Object.entries(rawHeaders)) {
    if (typeof val === "string") {
      headers[key] = val.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, p1, p2) => {
        const name = p1 || p2;
        if (allowed.has(name)) {
          return env[name] !== undefined ? env[name] : "";
        }
        return "";
      });
    } else {
      headers[key] = String(val);
    }
  }
  return headers;
}

/**
 * Post the event's JSON to an http hook.
 * Resolves { status: "ran" | "timed-out" | "failed-to-start", exitCode, statusCode, stdout, stderr, ms, timeoutMs, error }.
 */
export function runHttpHook(hook, { input, timeoutMs = 30000, env = process.env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let url;
    try {
      url = new URL(hook.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`unsupported protocol: ${url.protocol}`);
      }
    } catch (e) {
      resolve({ status: "failed-to-start", exitCode: null, statusCode: null, stdout: "", stderr: "", ms: 0, timeoutMs, error: e.message });
      return;
    }

    const payload = JSON.stringify(input);
    const headers = resolveHeaders(hook.headers, hook.allowedEnvVars, env);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
      headers["content-length"] = Buffer.byteLength(payload);
    }

    const client = url.protocol === "https:" ? https : http;
    const reqOptions = {
      method: "POST",
      headers,
    };

    let done = false;
    let timedOut = false;
    let req;

    const timer = setTimeout(() => {
      timedOut = true;
      if (req) {
        try { req.destroy(); } catch { /* ignore */ }
      }
      if (!done) {
        done = true;
        resolve({ status: "timed-out", exitCode: null, statusCode: null, stdout: "", stderr: "", ms: Date.now() - t0, timeoutMs, error: null });
      }
    }, timeoutMs);

    try {
      req = client.request(url, reqOptions, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const ms = Date.now() - t0;
          const statusCode = res.statusCode || 200;
          const is2xx = statusCode >= 200 && statusCode <= 299;
          resolve({
            status: "ran",
            statusCode,
            exitCode: is2xx ? 0 : statusCode,
            stdout: body,
            stderr: "",
            ms,
            timeoutMs,
            error: null,
          });
        });
      });
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: "failed-to-start", exitCode: null, statusCode: null, stdout: "", stderr: "", ms: Date.now() - t0, timeoutMs, error: e.message });
      return;
    }

    req.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: "failed-to-start", exitCode: null, statusCode: null, stdout: "", stderr: "", ms: Date.now() - t0, timeoutMs, error: err.message });
    });

    try {
      req.write(payload);
      req.end();
    } catch (e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: "failed-to-start", exitCode: null, statusCode: null, stdout: "", stderr: "", ms: Date.now() - t0, timeoutMs, error: e.message });
    }
  });
}
