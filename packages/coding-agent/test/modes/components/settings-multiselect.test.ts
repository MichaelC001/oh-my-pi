import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

import { cfgDevAutoqa } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgContextFilesExtra } from "@oh-my-pi/pi-coding-agent/session/context-settings";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function optionRow(component: SettingsSelectorComponent, label: string): number {
	const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings option: ${label}`);
	return row + 1;
}

function sendMouse(component: SettingsSelectorComponent, button: number, row: number, suffix: "M" | "m"): void {
	component.handleInput(`\x1b[<${button};3;${row}${suffix}`);
}

function clickOption(component: SettingsSelectorComponent, label: string): void {
	const row = optionRow(component, label);
	sendMouse(component, 0, row, "M");
	sendMouse(component, 0, row, "m");
}

describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const comp = createSelector();
		for (let i = 0; i < 7; i++) comp.handleInput("\x1b[C");
		expect(cfgDevAutoqa.get(settings)).toBe(true);

		clickOption(comp, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);

		clickOption(comp, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);
	});
});

function openExtraContextFiles(): SettingsSelectorComponent {
	const component = createSelector();
	for (let i = 0; i < 3; i++) component.handleInput("\x1b[C");
	component.handleNativeEvent({ type: "activate", key: "", item: "contextFiles.extra" });
	return component;
}

async function submitText(component: SettingsSelectorComponent, value: string): Promise<void> {
	component.handleInput("\x01");
	component.handleInput("\x0b");
	for (const character of value) component.handleInput(character);
	component.handleInput("\r");
	await Promise.resolve();
}

describe("extra context filenames editor", () => {
	it("saves multiple filenames as an array and lets users disable extras", async () => {
		const component = openExtraContextFiles();
		await submitText(component, '["AGENTS.local.md","TEAM.md"]');
		expect(cfgContextFilesExtra.get(settings)).toEqual(["AGENTS.local.md", "TEAM.md"]);

		component.handleInput("\r");
		await submitText(component, "[]");
		expect(cfgContextFilesExtra.get(settings)).toEqual([]);
	});

	it.each([
		["[", /Invalid array JSON/],
		['{"file":"TEAM.md"}', /Invalid array JSON/],
		['["../TEAM.md"]', /file names, not paths/],
		['["AGENTS.md"]', /built-in context file/],
	])("keeps the saved filenames when input %s is rejected", async (input, error) => {
		cfgContextFilesExtra.set(settings, ["TEAM.md"]);
		const component = openExtraContextFiles();
		await submitText(component, input);
		expect(cfgContextFilesExtra.get(settings)).toEqual(["TEAM.md"]);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toMatch(error);
	});
});
