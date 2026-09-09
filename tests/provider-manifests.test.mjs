import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP handshake reports the packaged version without accessing a mailbox", { timeout: 15000 }, async () => {
  const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./mcp/server.mjs"],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "webde-version-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, version);
    assert.equal(client.getServerVersion()?.name, "webde-access");
  } finally {
    await client.close();
  }
});

test("Kimi manifest pins the dev profile and contains no secrets", () => {
  const manifest = JSON.parse(fs.readFileSync("kimi.plugin.json", "utf8"));
  assert.equal(manifest.mcpServers["webde-access"].env.WEBDE_ACCESS_PROFILE, "dev");
  assert.doesNotMatch(JSON.stringify(manifest), /WEBDE_(?:APP_)?PASSWORD/);
});

test("Claude and Codex manifests contain no WEB.DE credentials", () => {
  const claude = fs.readFileSync(".claude-plugin/plugin.json", "utf8");
  const codex = fs.readFileSync(".codex-plugin/plugin.json", "utf8");
  assert.doesNotMatch(claude, /WEBDE_(?:APP_)?PASSWORD/);
  assert.doesNotMatch(codex, /WEBDE_(?:APP_)?PASSWORD/);
});

test("Codex MCP entrypoint bootstraps OS-native dependencies", () => {
  const mcp = JSON.parse(fs.readFileSync(".codex-mcp.json", "utf8"));
  assert.equal(mcp.mcpServers["webde-access"].command, "node");
  assert.deepEqual(mcp.mcpServers["webde-access"].args, ["./scripts/start-mcp.mjs"]);
  assert.equal(mcp.mcpServers["webde-access"].cwd, ".");
  assert.ok(fs.existsSync("scripts/start-mcp.mjs"));
});

test("Codex manifest points at the Codex-specific MCP file", () => {
  const codex = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf8"));
  assert.equal(codex.mcpServers, "./.codex-mcp.json");
});

// Claude Code spawns plugin MCP servers with the *session* working directory, not
// the plugin directory, so "./scripts/start-mcp.mjs" resolves into whatever repo
// the user happens to be in and node exits with MODULE_NOT_FOUND. Only
// ${CLAUDE_PLUGIN_ROOT} is expanded by the host to the real install path.
// Claude Code auto-discovers skills/ at the plugin root *in addition* to the
// directory the manifest declares. A second provider-specific skill directory
// therefore registers the same skill twice.
test("exactly one skill directory, shared by every provider", () => {
  const skillFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name === "SKILL.md") skillFiles.push(full);
    }
  };
  walk(".");
  assert.deepEqual(skillFiles, ["./skills/webde-access/SKILL.md"]);

  for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "kimi.plugin.json"]) {
    assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).skills, "./skills/");
  }
});

test("launcher probes the MCP SDK by manifest and keeps npm off stdout", () => {
  const launcher = fs
    .readFileSync("scripts/start-mcp.mjs", "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  // @modelcontextprotocol/sdk is ESM-only with no "main" and subpath-only
  // "exports", so resolving the bare package name always throws and would
  // trigger a full `npm ci` on every startup.
  assert.match(launcher, /require\.resolve\("@modelcontextprotocol\/sdk\/package\.json"\)/);
  assert.doesNotMatch(launcher, /require\.resolve\("@modelcontextprotocol\/sdk"\)/);

  // stdout is the MCP stdio transport; installer output there breaks JSON-RPC.
  assert.doesNotMatch(launcher, /stdio:\s*"inherit"/);
  assert.match(launcher, /stdio:\s*\["ignore",\s*"ignore",\s*"inherit"\]/);

  // Node refuses to spawn .cmd/.bat without a shell (CVE-2024-27980); on
  // Windows a bare spawnSync("npm.cmd", ...) fails with EINVAL.
  assert.match(launcher, /shell:\s*isWindows/);
  assert.doesNotMatch(launcher, /shell:\s*false/);
});

test("Claude MCP entrypoint is anchored to the plugin root", () => {
  const claudeManifest = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8"));
  assert.equal(claudeManifest.mcpServers, "./.mcp.json");

  const mcp = JSON.parse(fs.readFileSync(".mcp.json", "utf8"));
  const entry = mcp.mcpServers["webde-access"];
  assert.equal(entry.command, "node");
  assert.equal(entry.cwd, "${CLAUDE_PLUGIN_ROOT}");
  assert.deepEqual(entry.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/start-mcp.mjs"]);
});
