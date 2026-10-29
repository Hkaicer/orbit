// Minimal Model Context Protocol server (Streamable HTTP, JSON responses)
// exposing ORBIT's tools to the Claude Code CLI. It only answers on the
// loopback interface, and each URL carries the random token of one request in
// progress: the token is useless once that request ends.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Agent } from "./agent";
import { executeTool, toolDefinitions } from "./tools";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const isLoopback = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

export function registerMcp(app: FastifyInstance, agent: Agent, version: string) {
  const guard = (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    if (!isLoopback(req.ip)) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    const run = agent.getRun(req.params.token);
    if (!run) {
      reply.code(404).send({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unknown or finished session" } });
      return null;
    }
    return run;
  };

  app.get<{ Params: { token: string } }>("/mcp/:token", (req, reply) => {
    if (!guard(req, reply)) return;
    reply.code(405).header("Allow", "POST").send();
  });

  app.delete<{ Params: { token: string } }>("/mcp/:token", (req, reply) => {
    if (!guard(req, reply)) return;
    reply.code(200).send();
  });

  app.post<{ Params: { token: string }; Body: JsonRpcRequest | JsonRpcRequest[] }>("/mcp/:token", async (req, reply) => {
    const run = guard(req, reply);
    if (!run) return reply;
    const handle = async (msg: JsonRpcRequest): Promise<object | null> => {
      if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
      const notification = msg.id === undefined || msg.id === null;
      const ok = (result: unknown) => (notification ? null : { jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize": {
          const requested = String(msg.params?.protocolVersion ?? "");
          return ok({
            protocolVersion: VERSIONS.includes(requested) ? requested : VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "orbit", title: "ORBIT", version },
            instructions: "Outils d'ORBIT : offres, candidatures, documents (lecture seule) et Gmail (lecture seule). Les statuts et actions externes attendent l'utilisateur.",
          });
        }
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: toolDefinitions(run) });
        case "tools/call": {
          const r = await executeTool(run, String(msg.params?.name ?? ""), msg.params?.arguments);
          return ok({ content: [{ type: "text", text: r.ok ? JSON.stringify(r.result) : r.error }], isError: !r.ok });
        }
        default:
          if (msg.method.startsWith("notifications/")) return null;
          return notification ? null : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
      }
    };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handle))).filter((r): r is object => r !== null);
      return out.length ? reply.header("content-type", "application/json").send(out) : reply.code(202).send();
    }
    const out = await handle(body);
    return out === null ? reply.code(202).send() : reply.header("content-type", "application/json").send(out);
  });
}
