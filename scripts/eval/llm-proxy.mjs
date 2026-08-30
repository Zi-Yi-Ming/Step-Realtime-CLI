#!/usr/bin/env node
// Local recording proxy for LLM API traffic (evaluation tooling, not product code).
//
// Usage:
//   node scripts/eval/llm-proxy.mjs [--port 47190] [--upstream https://api.stepfun.com] [--out evals/baseline-<ts>]
//
// Then point the CLI at it:
//   STEP_BASE_URL=http://127.0.0.1:47190/step_plan/v1 node dist/index.js exec --json "..."
//
// For every request it appends one line to <out>/meta.jsonl with per-message
// hashes (for offline prefix-divergence analysis), the response usage (incl.
// prompt_tokens_details.cached_tokens), and writes the raw bodies to
// <out>/seq-<N>-request.json / seq-<N>-response.bin.

import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const args = {
    port: 47190,
    upstream: "https://api.stepfun.com",
    out: null,
    maxPerMinute: 30, // circuit breaker: 429 beyond this many chat requests in a rolling minute
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--port") args.port = Number(argv[++i]);
    else if (key === "--upstream") args.upstream = argv[++i];
    else if (key === "--out") args.out = argv[++i];
    else if (key === "--max-per-minute") args.maxPerMinute = Number(argv[++i]);
    else if (key === "--help" || key === "-h") {
      console.log("see header comment");
      process.exit(0);
    }
  }
  if (!args.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    args.out = join("evals", `run-${ts}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const upstream = new URL(args.upstream);
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", args.out);
mkdirSync(outDir, { recursive: true });

function hashMessage(message) {
  const serialized = JSON.stringify(message);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function describeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  return messages.map((message, index) => {
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null);
    return {
      i: index,
      role: message.role ?? "?",
      chars: content.length,
      hash: hashMessage(message),
    };
  });
}

function extractToolErrorCodes(messages) {
  if (!Array.isArray(messages)) return [];
  const codes = [];
  const pattern = /"(?:error|code)"\s*:\s*"([A-Z][A-Z0-9_]{2,})"/g;
  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "user") continue;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    let match = pattern.exec(content);
    while (match) {
      codes.push(match[1]);
      match = pattern.exec(content);
    }
  }
  return codes;
}

function extractUsage(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return null;
  return usage;
}

let recentChats = [];

const server = http.createServer((clientReq, clientRes) => {
  const chunks = [];
  clientReq.on("data", (chunk) => chunks.push(chunk));
  clientReq.on("end", () => {
    const now = Date.now();
    const isChat = (clientReq.url || "").includes("/chat/completions");
    if (isChat) {
      recentChats = recentChats.filter((ts) => now - ts < 60_000);
      recentChats.push(now);
      if (recentChats.length > args.maxPerMinute) {
        console.log(
          `circuit-breaker: ${recentChats.length} chat reqs in last 60s (cap ${args.maxPerMinute}), returning 429`,
        );
        clientRes.writeHead(429, { "content-type": "application/json" });
        clientRes.end(
          JSON.stringify({
            error: {
              message:
                "eval-proxy circuit breaker: too many chat completions per minute; likely an agent loop",
              type: "rate_limit_error",
              code: "eval_rate_limited",
            },
          }),
        );
        return;
      }
    }
    const body = Buffer.concat(chunks);
    const startedAt = Date.now();
    const seq = ++server.seq;
    const requestFile = `seq-${seq}-request.json`;
    const responseFile = `seq-${seq}-response.bin`;
    writeFileSync(join(outDir, requestFile), body);

    let parsedBody = null;
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
    } catch {
      parsedBody = null;
    }

    const headers = { ...clientReq.headers };
    delete headers.host;
    delete headers["accept-encoding"]; // force identity so the tee file is plain text
    headers["content-length"] = String(body.length);

    const upstreamReq = https.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || 443,
        path: clientReq.url,
        method: clientReq.method,
        headers,
      },
      (upstreamRes) => {
        const responseChunks = [];
        upstreamRes.on("data", (chunk) => responseChunks.push(chunk));
        upstreamRes.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          const durationMs = Date.now() - startedAt;
          writeFileSync(join(outDir, responseFile), responseBody);

          const responseText = responseBody.toString("utf8");
          let usage = null;
          try {
            usage = extractUsage(JSON.parse(responseText));
          } catch {
            // SSE or non-JSON: leave usage null, parse offline.
          }

          const messages = parsedBody?.messages;
          const entry = {
            seq,
            ts: new Date(startedAt).toISOString(),
            method: clientReq.method,
            path: clientReq.url,
            status: upstreamRes.statusCode,
            durationMs,
            requestBytes: body.length,
            responseBytes: responseBody.length,
            model: parsedBody?.model ?? null,
            messageCount: Array.isArray(messages) ? messages.length : null,
            messages: describeMessages(messages),
            toolErrorCodes: extractToolErrorCodes(messages),
            usage,
            requestFile,
            responseFile,
          };
          appendFileSync(join(outDir, "meta.jsonl"), `${JSON.stringify(entry)}\n`);
          const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens;
          const promptTokens = usage?.prompt_tokens ?? "?";
          console.log(
            `#${seq} ${clientReq.method} ${clientReq.url} -> ${upstreamRes.statusCode} ${durationMs}ms prompt=${promptTokens} cached=${cached ?? "?"}`,
          );

          const responseHeaders = { ...upstreamRes.headers };
          delete responseHeaders["content-length"];
          delete responseHeaders["transfer-encoding"];
          responseHeaders["content-length"] = String(responseBody.length);
          clientRes.writeHead(upstreamRes.statusCode, responseHeaders);
          clientRes.end(responseBody);
        });
        upstreamRes.on("error", (error) => {
          console.error(`#${seq} upstream error: ${error.message}`);
          clientRes.writeHead(502, { "content-type": "application/json" });
          clientRes.end(JSON.stringify({ error: { message: error.message } }));
        });
      },
    );
    upstreamReq.on("error", (error) => {
      console.error(`#${seq} request error: ${error.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    upstreamReq.end(body);
  });
});

server.seq = 0;
server.listen(args.port, "127.0.0.1", () => {
  console.log(`llm-proxy listening on http://127.0.0.1:${args.port} -> ${upstream.origin}`);
  console.log(`logging to ${outDir}`);
});
