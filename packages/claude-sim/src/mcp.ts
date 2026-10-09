import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLAUDE_CODE_VERSION, MCP_CONFIG_SOURCE } from './constants';
import type { SimEnv } from './paths';
import { ConfigError } from './settings';

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content: McpContentBlock[];
  isError: boolean;
  structuredContent?: unknown;
}

interface ServerState {
  name: string;
  status: 'connected' | 'failed';
  tools: McpToolInfo[];
  error?: string;
  client?: Client;
  transport?: StdioClientTransport;
}

/** Tool names as the model sees them: mcp__<server>__<tool>, with unsafe characters replaced by '_'. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (part: string) => part.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`;
}

/** ${VAR} and ${VAR:-default} expansion, as Claude Code applies to MCP configs. */
function expandEnv(value: string, env: SimEnv): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => {
      return env[name] ?? fallback ?? '';
    },
  );
}

function invalid(detail: string): ConfigError {
  return new ConfigError(`Error: Invalid MCP configuration:\n${detail}`);
}

function normaliseServer(name: string, raw: unknown, env: SimEnv): McpServerConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw invalid(`mcpServers.${name}: expected an object`);
  const entry = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? expandEnv(value, env) : undefined);
  const config: McpServerConfig = {};
  if (typeof entry.type === 'string') config.type = entry.type;
  const command = text(entry.command);
  if (command !== undefined) config.command = command;
  if (Array.isArray(entry.args)) config.args = entry.args.map((arg) => expandEnv(String(arg), env));
  if (entry.env && typeof entry.env === 'object') {
    config.env = Object.fromEntries(
      Object.entries(entry.env as Record<string, unknown>).map(([key, value]) => [
        key,
        expandEnv(String(value), env),
      ]),
    );
  }
  const cwd = text(entry.cwd);
  if (cwd !== undefined) config.cwd = cwd;
  const url = text(entry.url);
  if (url !== undefined) config.url = url;
  return config;
}

/** Parse every `--mcp-config` value (a file path or a JSON string); later definitions win. */
export function parseMcpConfigs(
  values: readonly string[],
  cwd: string,
  env: SimEnv,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const value of values) {
    const trimmed = value.trim();
    let raw: unknown;
    if (trimmed.startsWith('{')) {
      try {
        raw = JSON.parse(trimmed);
      } catch (error) {
        throw invalid(`Invalid JSON: ${(error as Error).message}`);
      }
    } else {
      const file = path.resolve(cwd, value);
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        throw invalid(`MCP config file not found: ${file}`);
      }
      try {
        raw = JSON.parse(text);
      } catch (error) {
        throw invalid(`${file}: Invalid JSON: ${(error as Error).message}`);
      }
    }
    const mcpServers = (raw as { mcpServers?: unknown } | null)?.mcpServers;
    if (mcpServers === null || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
      throw invalid('mcpServers: Required');
    }
    for (const [name, entry] of Object.entries(mcpServers as Record<string, unknown>)) {
      servers[name] = normaliseServer(name, entry, env);
    }
  }
  return servers;
}

export interface McpHubOptions {
  env: Readonly<Record<string, string>>;
  cwd: string;
  connectTimeoutMs: number;
  toolTimeoutMs: number;
  onStderr?: (server: string, chunk: string) => void;
  debug?: (message: string) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Connections to the stdio MCP servers of a session (real child processes via the MCP SDK). */
export class McpHub {
  private readonly servers = new Map<string, ServerState>();
  private readonly byToolName = new Map<string, { server: string; tool: string }>();

  constructor(private readonly options: McpHubOptions) {}

  async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(Object.entries(configs).map(([name, config]) => this.connect(name, config)));
    for (const state of this.servers.values()) {
      for (const tool of state.tools)
        this.byToolName.set(mcpToolName(state.name, tool.name), { server: state.name, tool: tool.name });
    }
  }

  /** Status entries for the stream-json init message, in configuration order. */
  statuses(): { name: string; status: string; source: string }[] {
    return [...this.servers.values()].map((state) => ({
      name: state.name,
      status: state.status,
      source: MCP_CONFIG_SOURCE,
    }));
  }

  toolNames(): string[] {
    return [...this.byToolName.keys()];
  }

  /** The hooks' `mcp_server` field for an `mcp__*` tool. */
  serverOf(fullName: string): { name: string; source: string } | undefined {
    const target = this.byToolName.get(fullName);
    return target ? { name: target.server, source: MCP_CONFIG_SOURCE } : undefined;
  }

  /** Total tool-definition size, used to estimate the system-prompt tokens MCP tools add. */
  definitionChars(): number {
    let chars = 0;
    for (const state of this.servers.values()) {
      for (const tool of state.tools) chars += JSON.stringify(tool).length;
    }
    return chars;
  }

  has(fullName: string): boolean {
    return this.byToolName.has(fullName);
  }

  async call(fullName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const target = this.byToolName.get(fullName);
    const client = target ? this.servers.get(target.server)?.client : undefined;
    if (!target || !client) throw new Error(`No such tool available: ${fullName}`);
    const result = await client.callTool({ name: target.tool, arguments: args }, undefined, {
      timeout: this.options.toolTimeoutMs,
      ...(signal && { signal }),
    });
    if (Array.isArray(result.content)) {
      return {
        content: result.content as McpContentBlock[],
        isError: result.isError === true,
        ...(result.structuredContent !== undefined && { structuredContent: result.structuredContent }),
      };
    }
    // Pre-2024-11 servers answer with { toolResult }.
    return { content: [{ type: 'text', text: JSON.stringify(result.toolResult ?? null) }], isError: false };
  }

  async closeAll(): Promise<void> {
    const states = [...this.servers.values()];
    await Promise.all(
      states.map(async (state) => {
        try {
          await state.client?.close();
        } catch {
          // already gone
        }
      }),
    );
  }

  private async connect(name: string, config: McpServerConfig): Promise<void> {
    const state: ServerState = { name, status: 'failed', tools: [] };
    this.servers.set(name, state);
    if (config.type !== undefined && config.type !== 'stdio') {
      state.error = `claude-sim only supports stdio MCP servers (got type "${config.type}")`;
      this.options.debug?.(`mcp ${name}: ${state.error}`);
      return;
    }
    if (!config.command) {
      state.error = 'missing "command"';
      this.options.debug?.(`mcp ${name}: ${state.error}`);
      return;
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...this.options.env, ...(config.env ?? {}) },
      cwd: config.cwd ? path.resolve(this.options.cwd, config.cwd) : this.options.cwd,
      stderr: 'pipe',
    });
    // Always drain the server's stderr so a chatty server cannot block on a full pipe.
    transport.stderr?.on('data', (chunk: Buffer | string) => this.options.onStderr?.(name, chunk.toString()));
    const client = new Client({ name: 'claude-code', version: CLAUDE_CODE_VERSION }, { capabilities: {} });
    try {
      await withTimeout(
        client.connect(transport),
        this.options.connectTimeoutMs,
        `MCP server "${name}" connection`,
      );
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(
          client.listTools(cursor ? { cursor } : undefined),
          this.options.connectTimeoutMs,
          `MCP server "${name}" tools/list`,
        );
        tools.push(
          ...page.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        );
        cursor = page.nextCursor;
      } while (cursor);
      Object.assign(state, { status: 'connected', tools, client, transport });
      this.options.debug?.(`mcp ${name}: connected with ${tools.length} tools`);
    } catch (error) {
      state.error = (error as Error).message;
      this.options.debug?.(`mcp ${name}: failed: ${state.error}`);
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }
}
