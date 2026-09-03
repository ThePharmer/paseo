#!/usr/bin/env node
// Header-gating reverse proxy for the Android custom-headers QA run.
//
// Stands in for Cloudflare Access with a service-token policy: every request
// and WebSocket upgrade must carry GATE_HEADER_NAME: GATE_HEADER_VALUE or it is
// answered with a 302 to a login page, exactly what Access does for a
// non-browser client without a token. Authorized upgrades are spliced through
// to the daemon byte for byte. Decisions are logged as JSON lines on stdout so
// the workflow can prove which handshakes carried the header.

import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.GATE_LISTEN_PORT ?? "6768");
const upstreamHost = process.env.GATE_UPSTREAM_HOST ?? "127.0.0.1";
const upstreamPort = Number(process.env.GATE_UPSTREAM_PORT ?? "6767");
const headerName = (process.env.GATE_HEADER_NAME ?? "X-Paseo-Gate").toLowerCase();
const headerValue = process.env.GATE_HEADER_VALUE ?? "qa-gate";
const loginLocation = "https://access.invalid/cdn-cgi/access/login";

function log(event) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function isAuthorized(req) {
  return req.headers[headerName] === headerValue;
}

function forwardedHeaders(req) {
  const headers = { ...req.headers, host: `${upstreamHost}:${upstreamPort}` };
  delete headers[headerName];
  return headers;
}

const server = http.createServer((req, res) => {
  const allowed = isAuthorized(req);
  log({ kind: "request", method: req.method, path: req.url, hasHeader: headerName in req.headers, allowed });
  if (!allowed) {
    res.writeHead(302, { Location: loginLocation, "Content-Length": "0" });
    res.end();
    return;
  }
  const proxied = http.request(
    { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers: forwardedHeaders(req) },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on("error", (error) => {
    log({ kind: "upstream-error", path: req.url, message: error.message });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(proxied);
});

server.on("upgrade", (req, socket, head) => {
  const allowed = isAuthorized(req);
  log({
    kind: "upgrade",
    path: req.url,
    hasHeader: headerName in req.headers,
    allowed,
    protocols: req.headers["sec-websocket-protocol"] ?? null,
  });
  if (!allowed) {
    socket.write(
      `HTTP/1.1 302 Found\r\nLocation: ${loginLocation}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
    return;
  }
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(forwardedHeaders(req))) {
      if (value === undefined) continue;
      raw += `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`;
    }
    raw += "\r\n";
    upstream.write(raw);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", (error) => {
    log({ kind: "upstream-error", path: req.url, message: error.message });
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
});

server.listen(listenPort, "0.0.0.0", () => {
  log({
    kind: "listening",
    listenPort,
    upstream: `${upstreamHost}:${upstreamPort}`,
    requiredHeader: headerName,
  });
});
