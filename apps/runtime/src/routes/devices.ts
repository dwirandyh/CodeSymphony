import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SendDeviceControlInputSchema,
  StartDeviceStreamInputSchema,
  StopDeviceStreamInputSchema,
} from "@codesymphony/shared-types";
import WebSocket, { type RawData } from "ws";
import { ANDROID_VIEWER_WS_PLACEHOLDER } from "../services/deviceService.utils.js";

const PROXY_TIMEOUT_MS = 20_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type ViewerPathParams = {
  sessionId: string;
  "*": string;
};

type DeviceStreamSessionParams = {
  sessionId: string;
};

function getRawSearch(request: FastifyRequest): string {
  const rawUrl = request.raw.url ?? request.url;
  const queryIndex = rawUrl.indexOf("?");
  return queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";
}

function copyProxyResponseHeaders(reply: FastifyReply, response: Response) {
  for (const [name, value] of response.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    reply.header(name, value);
  }
}

function buildProxyHeaders(request: FastifyRequest, authorizationHeader: string | null): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(name, entry);
      }
      continue;
    }

    headers.set(name, value);
  }

  if (authorizationHeader) {
    headers.set("authorization", authorizationHeader);
  }

  return headers;
}

function buildAndroidProxyTargetUrl(baseUrl: string, viewerPath: string, search: string): URL {
  const targetPath = !viewerPath || viewerPath === "index.html" ? "/" : `/${viewerPath}`;
  const targetUrl = new URL(targetPath, baseUrl);
  targetUrl.search = search;
  return targetUrl;
}

function rewriteAndroidViewerHtml(html: string): string {
  const wsBootstrap = `<script>
(() => {
  const placeholder = "${ANDROID_VIEWER_WS_PLACEHOLDER}";
  const rawHash = window.location.hash.replace(/^#!/, "");
  if (!rawHash) {
    return;
  }

  const params = new URLSearchParams(rawHash);
  if (params.get("ws") !== placeholder) {
    return;
  }

  const udid = params.get("udid");
  if (!udid) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsPath = window.location.pathname.replace(/\\/index\\.html$/, "/ws");
  const wsUrl = new URL(protocol + "//" + window.location.host + wsPath);
  wsUrl.searchParams.set("action", "proxy-adb");
  wsUrl.searchParams.set("remote", "tcp:8886");
  wsUrl.searchParams.set("udid", udid);

  params.set("ws", wsUrl.toString());
  const nextHash = "#!" + params.toString();
  window.history.replaceState(null, "", window.location.pathname + window.location.search + nextHash);
})();
</script>`;

  if (html.includes("<script defer=\"defer\" src=\"bundle.js\"></script>")) {
    return html.replace("<script defer=\"defer\" src=\"bundle.js\"></script>", `${wsBootstrap}<script defer="defer" src="bundle.js"></script>`);
  }

  if (html.includes("</head>")) {
    return html.replace("</head>", `${wsBootstrap}</head>`);
  }

  return `${wsBootstrap}${html}`;
}

function rewriteAndroidViewerBundle(bundle: string): string {
  return bundle.replace(
    'window.location.href="/?".concat(o.toString())',
    'window.location.href="index.html?".concat(o.toString())',
  );
}

function buildWebSocketProxyHeaders(request: FastifyRequest, authorizationHeader: string | null): Record<string, string> {
  const headers: Record<string, string> = {};

  const userAgent = request.headers["user-agent"];
  if (typeof userAgent === "string" && userAgent.trim().length > 0) {
    headers["user-agent"] = userAgent;
  }

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.trim().length > 0) {
    headers.origin = origin;
  }

  const protocol = request.headers["sec-websocket-protocol"];
  if (typeof protocol === "string" && protocol.trim().length > 0) {
    headers["sec-websocket-protocol"] = protocol;
  }

  if (authorizationHeader) {
    headers.authorization = authorizationHeader;
  }

  return headers;
}

function normalizeCloseCode(code: number, fallback: number): number {
  if (!Number.isFinite(code)) {
    return fallback;
  }

  if (code < 1000 || code === 1004 || code === 1005 || code === 1006 || code === 1015 || code >= 5000) {
    return fallback;
  }

  return code;
}

function proxyWebSocketConnection(args: {
  app: FastifyInstance;
  authorizationHeader: string | null;
  client: WebSocket;
  request: FastifyRequest;
  sessionId: string;
  targetUrl: URL;
  upstreamFailureMessage: string;
}) {
  const { app, authorizationHeader, client, request, sessionId, targetUrl, upstreamFailureMessage } = args;
  const pendingClientMessages: Array<{ data: RawData; isBinary: boolean }> = [];
  const upstream = new WebSocket(targetUrl, {
    headers: buildWebSocketProxyHeaders(request, authorizationHeader),
  });

  upstream.on("open", () => {
    while (pendingClientMessages.length > 0 && upstream.readyState === WebSocket.OPEN) {
      const nextMessage = pendingClientMessages.shift();
      if (!nextMessage) {
        return;
      }

      upstream.send(nextMessage.data, { binary: nextMessage.isBinary });
    }
  });

  upstream.on("message", (data: RawData, isBinary: boolean) => {
    if (client.readyState === client.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });

  upstream.on("close", (code: number, reason: Buffer) => {
    if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
      client.close(normalizeCloseCode(code, 1000), reason.toString());
    }
  });

  upstream.on("error", (error: Error) => {
    app.log.warn({ error, sessionId, targetUrl: targetUrl.toString() }, upstreamFailureMessage);
    if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) {
      client.close(1011, "Viewer upstream failed");
    }
  });

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      pendingClientMessages.push({ data, isBinary });
    }
  });

  client.on("close", (code: number, reason: Buffer) => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(normalizeCloseCode(code, 1000), reason.toString());
    }
  });

  client.on("error", (error: Error) => {
    app.log.warn({ error, sessionId }, "Embedded device viewer websocket client closed with error");
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(1011, "Viewer client failed");
    }
  });
}

function writeSseHeaders(request: FastifyRequest, reply: FastifyReply) {
  const requestOrigin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  };

  if (requestOrigin) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers.Vary = "Origin";
  }

  reply.raw.writeHead(200, headers);
}

export async function registerDeviceRoutes(app: FastifyInstance) {
  app.get("/devices", async () => {
    const snapshot = await app.deviceService.listSnapshot();
    return { data: snapshot };
  });

  app.get("/devices/stream", async (request, reply) => {
    writeSseHeaders(request, reply);
    reply.raw.write(": connected\n\n");

    const sendSnapshot = async () => {
      const snapshot = await app.deviceService.listSnapshot();
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };

    await sendSnapshot();

    const unsubscribe = app.deviceService.subscribe((snapshot) => {
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    });

    const keepAliveTimer = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    request.raw.on("close", () => {
      clearInterval(keepAliveTimer);
      unsubscribe();
    });
  });

  app.post("/devices/:id/stream/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const input = StartDeviceStreamInputSchema.parse(request.body ?? {});
      const session = await app.deviceService.startStream(id, input);
      return { data: session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start device stream";
      return reply.code(400).send({ error: message });
    }
  });

  app.post("/device-streams/stop", async (request, reply) => {
    const input = StopDeviceStreamInputSchema.parse(request.body ?? {});
    await app.deviceService.stopStream(input.sessionId);
    return reply.code(204).send();
  });

  app.post("/device-streams/:sessionId/control", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const input = SendDeviceControlInputSchema.parse(request.body ?? {});
    await app.deviceService.sendControl(sessionId, input);
    return reply.code(204).send();
  });

  app.get("/device-streams/:sessionId/viewer", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession) {
      return reply.code(404).send({ error: "Device stream session not found" });
    }

    if (viewerSession.viewerMode === "proxy") {
      return reply.redirect(`/api/device-streams/${encodeURIComponent(sessionId)}/viewer/index.html`);
    }

    if (!viewerSession.redirectUrl) {
      return reply.code(404).send({ error: "Device viewer URL not found" });
    }

    return reply.redirect(viewerSession.redirectUrl);
  });

  app.get("/device-streams/:sessionId/viewer/ws", { websocket: true }, (socket, request) => {
    const { sessionId } = request.params as DeviceStreamSessionParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.viewerMode !== "proxy" || !viewerSession.proxyBaseUrl) {
      socket.close(4404, "Device stream session not found");
      return;
    }

    const targetUrl = new URL("/", viewerSession.proxyBaseUrl);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
    targetUrl.search = getRawSearch(request);

    proxyWebSocketConnection({
      app,
      authorizationHeader: viewerSession.proxyAuthorizationHeader,
      client: socket,
      request,
      sessionId,
      targetUrl,
      upstreamFailureMessage: "Android viewer websocket proxy failed",
    });
  });

  app.get("/device-streams/:sessionId/native/video", { websocket: true }, (socket, request) => {
    const { sessionId } = request.params as DeviceStreamSessionParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.platform !== "ios-simulator" || !viewerSession.proxyBaseUrl || !viewerSession.platformSessionId) {
      socket.close(4404, "Device stream session not found");
      return;
    }

    const targetUrl = new URL(`/ws/${encodeURIComponent(viewerSession.platformSessionId)}/video`, viewerSession.proxyBaseUrl);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";

    proxyWebSocketConnection({
      app,
      authorizationHeader: viewerSession.proxyAuthorizationHeader,
      client: socket,
      request,
      sessionId,
      targetUrl,
      upstreamFailureMessage: "iOS native video websocket proxy failed",
    });
  });

  app.get("/device-streams/:sessionId/native/status", async (request, reply) => {
    const { sessionId } = request.params as DeviceStreamSessionParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.platform !== "ios-simulator" || !viewerSession.proxyBaseUrl || !viewerSession.platformSessionId) {
      return reply.code(404).send({ error: "Device stream session not found" });
    }

    const targetUrl = new URL(`/status/${encodeURIComponent(viewerSession.platformSessionId)}`, viewerSession.proxyBaseUrl);

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: buildProxyHeaders(request, viewerSession.proxyAuthorizationHeader),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });

      copyProxyResponseHeaders(reply, response);
      reply.header("Cache-Control", "no-store");
      reply.code(response.status);

      const payload = await response.json().catch(() => null);
      return reply.send(payload ?? { error: "Invalid iOS status response" });
    } catch (error) {
      app.log.warn({ error, sessionId, targetUrl: targetUrl.toString() }, "iOS native status proxy failed");
      return reply.code(502).send({ error: "Failed to reach iOS bridge status endpoint" });
    }
  });

  app.get("/device-streams/:sessionId/native/screenshot", async (request, reply) => {
    const { sessionId } = request.params as DeviceStreamSessionParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.platform !== "ios-simulator" || !viewerSession.proxyBaseUrl || !viewerSession.platformSessionId) {
      return reply.code(404).send({ error: "Device stream session not found" });
    }

    const targetUrl = new URL(`/api/sessions/${encodeURIComponent(viewerSession.platformSessionId)}/screenshot`, viewerSession.proxyBaseUrl);

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: buildProxyHeaders(request, viewerSession.proxyAuthorizationHeader),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });

      copyProxyResponseHeaders(reply, response);
      reply.header("Cache-Control", "no-store");
      reply.code(response.status);

      const body = Buffer.from(await response.arrayBuffer());
      return reply.send(body);
    } catch (error) {
      app.log.warn({ error, sessionId, targetUrl: targetUrl.toString() }, "iOS native screenshot proxy failed");
      return reply.code(502).send({ error: "Failed to reach iOS bridge screenshot endpoint" });
    }
  });

  app.get("/device-streams/:sessionId/native/webrtc", { websocket: true }, (socket, request) => {
    const { sessionId } = request.params as DeviceStreamSessionParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.platform !== "ios-simulator" || !viewerSession.proxyBaseUrl || !viewerSession.platformSessionId) {
      socket.close(4404, "Device stream session not found");
      return;
    }

    const targetUrl = new URL(`/ws/${encodeURIComponent(viewerSession.platformSessionId)}/webrtc`, viewerSession.proxyBaseUrl);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";

    proxyWebSocketConnection({
      app,
      authorizationHeader: viewerSession.proxyAuthorizationHeader,
      client: socket,
      request,
      sessionId,
      targetUrl,
      upstreamFailureMessage: "iOS native WebRTC signaling proxy failed",
    });
  });

  app.get("/device-streams/:sessionId/native/control", { websocket: true }, (socket, request) => {
    const { sessionId } = request.params as DeviceStreamSessionParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.platform !== "ios-simulator" || !viewerSession.proxyBaseUrl || !viewerSession.platformSessionId) {
      socket.close(4404, "Device stream session not found");
      return;
    }

    const targetUrl = new URL(`/ws/${encodeURIComponent(viewerSession.platformSessionId)}/control`, viewerSession.proxyBaseUrl);
    targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";

    proxyWebSocketConnection({
      app,
      authorizationHeader: viewerSession.proxyAuthorizationHeader,
      client: socket,
      request,
      sessionId,
      targetUrl,
      upstreamFailureMessage: "iOS native control websocket proxy failed",
    });
  });

  app.get("/device-streams/:sessionId/viewer/*", async (request, reply) => {
    const { sessionId, "*": viewerPath } = request.params as ViewerPathParams;
    const viewerSession = app.deviceService.getViewerSession(sessionId);
    if (!viewerSession || viewerSession.viewerMode !== "proxy" || !viewerSession.proxyBaseUrl) {
      return reply.code(404).send({ error: "Device stream session not found" });
    }

    const targetUrl = buildAndroidProxyTargetUrl(viewerSession.proxyBaseUrl, viewerPath, getRawSearch(request));

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: buildProxyHeaders(request, viewerSession.proxyAuthorizationHeader),
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });

      copyProxyResponseHeaders(reply, response);
      reply.code(response.status);

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        const html = await response.text();
        return reply.type("text/html").send(rewriteAndroidViewerHtml(html));
      }

      if (viewerPath.endsWith("bundle.js") || contentType.includes("javascript")) {
        const script = await response.text();
        return reply.type("application/javascript").send(rewriteAndroidViewerBundle(script));
      }

      const body = Buffer.from(await response.arrayBuffer());
      return reply.send(body);
    } catch (error) {
      app.log.warn({ error, sessionId, targetUrl: targetUrl.toString() }, "Android viewer proxy request failed");
      return reply.code(502).send({ error: "Failed to reach Android viewer sidecar" });
    }
  });
}
