#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temporaryRoot, "webde-cold-start-"));
let client;
try {
  for (const relative of ["package.json", "package-lock.json", "kimi.plugin.json", "mcp", "scripts"]) {
    fs.cpSync(path.join(source, relative), path.join(fixture, relative), { recursive: true });
  }
  assert.equal(fs.existsSync(path.join(fixture, "node_modules")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "kimi.plugin.json"), "utf8"));
  const entry = manifest.mcpServers["webde-access"];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entry.args,
    cwd: fixture,
    env: { ...process.env, ...entry.env },
    stderr: "inherit",
  });
  client = new Client({ name: "webde-cold-start-test", version: "1.0.0" });
  await client.connect(transport, { timeout: 180000 });
  assert.equal(client.getServerVersion()?.version, manifest.version);
  const result = await client.listTools();
  assert.ok(result.tools.length > 0);
  assert.ok(fs.existsSync(path.join(fixture, "node_modules", "keytar", "build", "Release", "keytar.node")));
  console.log(`Cold Kimi entrypoint started MCP ${manifest.version} with ${result.tools.length} tools and a native keytar binary.`);
} finally {
  await client?.close();
  // Remove only the exact fixture created by this invocation.
  const resolved = fs.realpathSync(fixture);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert.ok(path.basename(resolved).startsWith("webde-cold-start-"));
  const hasKeep = (directory) => fs.readdirSync(directory, { withFileTypes: true }).some(
    (entry) => entry.name === "KEEP" || (entry.isDirectory() && hasKeep(path.join(directory, entry.name))),
  );
  if (!hasKeep(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}
