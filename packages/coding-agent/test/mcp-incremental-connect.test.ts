/**
 * Incremental `connectServers` must keep tools for already-owned connections.
 *
 * `/mcp enable` and `/extensions` enable one server by calling
 * `connectServers({ [name]: config })` while others are already live. The
 * startup race used to assign `this.#tools = allTools` from only this call's
 * tasks, dropping every other server's tools even though those connections
 * stayed open.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import {
	applyMcpToggleRuntime,
	type MCPToggleSession,
} from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

const SERVER_A = "alpha";
const SERVER_B = "bravo";
const TOOL_A = `mcp__${SERVER_A}_${manyToolName(0)}`;
const TOOL_B = `mcp__${SERVER_B}_${manyToolName(0)}`;

function fixtureConfig(delay = 0): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH, "--delay", String(delay)] };
}

function expectedToolNames(servers: string[]): string[] {
	return servers
		.flatMap(server => Array.from({ length: MANY_TOOL_COUNT }, (_, index) => `mcp__${server}_${manyToolName(index)}`))
		.sort();
}

// These subprocess fixtures use a separate real clock for delayed initialization.
async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("MCP readiness predicate did not settle within 10 seconds");
		await Bun.sleep(10);
	}
}

async function waitForTools(manager: MCPManager, servers: string[]): Promise<void> {
	const expected = expectedToolNames(servers);
	const owners: Record<string, string> = Object.fromEntries(
		servers.flatMap(server => expectedToolNames([server]).map(name => [name, server])),
	);
	await waitFor(() => {
		const tools = manager.getTools();
		const names = tools.map(tool => tool.name).sort();
		return (
			names.length === expected.length &&
			names.every((name, index) => name === expected[index]) &&
			tools.every(tool => owners[tool.name] === tool.mcpServerName) &&
			servers.every(
				server =>
					manager.getConnectionStatus(server) === "connected" &&
					tools.filter(tool => tool.mcpServerName === server).length === MANY_TOOL_COUNT,
			)
		);
	});
}

describe("MCP incremental connectServers", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-incremental-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("keeps server A tools after incrementally connecting server B", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitForTools(manager, [SERVER_A]);
		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		const afterA = manager.getTools();
		expect(afterA.map(t => t.name)).toContain(TOOL_A);
		expect(afterA).toHaveLength(MANY_TOOL_COUNT);
		expect(afterA.every(t => t.mcpServerName === SERVER_A)).toBe(true);

		await manager.connectServers({ [SERVER_B]: fixtureConfig(400) }, {});
		await waitForTools(manager, [SERVER_A, SERVER_B]);
		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		expect(manager.getConnectionStatus(SERVER_B)).toBe("connected");

		const tools = manager.getTools();
		expect(tools.map(t => t.name)).toContain(TOOL_A);
		expect(tools.map(t => t.name)).toContain(TOOL_B);
		expect(tools).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(tools.filter(t => t.mcpServerName === SERVER_A)).toHaveLength(MANY_TOOL_COUNT);
		expect(tools.filter(t => t.mcpServerName === SERVER_B)).toHaveLength(MANY_TOOL_COUNT);
		expect(tools.map(tool => tool.name).sort()).toEqual(expectedToolNames([SERVER_A, SERVER_B]));
	}, 20_000);

	it("applyMcpToggleRuntime enable of B refreshes the A+B union", async () => {
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitForTools(manager, [SERVER_A]);
		expect(manager.getTools()).toHaveLength(MANY_TOOL_COUNT);

		const refreshed: string[][] = [];
		const session: MCPToggleSession = {
			refreshMCPTools: next => {
				refreshed.push(next.map(tool => tool.name));
			},
		};
		manager.setOnToolsChanged(async tools => session.refreshMCPTools(tools));
		await applyMcpToggleRuntime({
			name: SERVER_B,
			enabled: true,
			cwd: workDir,
			manager,
			session,
			loadConfigs: async () => ({
				configs: { [SERVER_B]: fixtureConfig(400) },
				sources: {},
				exaApiKeys: [],
			}),
		});
		await waitForTools(manager, [SERVER_A, SERVER_B]);
		const expected = expectedToolNames([SERVER_A, SERVER_B]);
		await waitFor(() => {
			const names = refreshed.at(-1)?.toSorted();
			return names?.length === expected.length && names.every((name, index) => name === expected[index]);
		});

		expect(manager.getConnectionStatus(SERVER_A)).toBe("connected");
		expect(manager.getConnectionStatus(SERVER_B)).toBe("connected");
		const names = manager.getTools().map(t => t.name);
		expect(names).toContain(TOOL_A);
		expect(names).toContain(TOOL_B);
		expect(manager.getTools()).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(refreshed.at(-1)).toContain(TOOL_A);
		expect(refreshed.at(-1)).toContain(TOOL_B);
		expect(refreshed.at(-1)).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(refreshed.at(-1)?.toSorted()).toEqual(expected);
	}, 20_000);

	it("notifies connection-status listeners on connect and transport loss", async () => {
		const events: Array<{ type: string; name?: string }> = [];
		const stop = manager.addConnectionStatusListener(event => {
			events.push({
				type: event.type,
				name: event.type === "connecting" ? event.serverNames[0] : event.serverName,
			});
		});
		await manager.connectServers({ [SERVER_A]: fixtureConfig() }, {});
		await waitFor(() => events.some(event => event.type === "connected" && event.name === SERVER_A));
		expect(events.some(event => event.type === "connecting" && event.name === SERVER_A)).toBe(true);
		expect(events.some(event => event.type === "connected" && event.name === SERVER_A)).toBe(true);

		const connection = manager.getConnection(SERVER_A);
		expect(connection).toBeDefined();
		connection?.transport.onClose?.();
		await waitFor(() => events.some(event => event.type === "reconnecting" && event.name === SERVER_A));
		expect(events.some(event => event.type === "reconnecting" && event.name === SERVER_A)).toBe(true);
		stop();
	}, 20_000);
});
