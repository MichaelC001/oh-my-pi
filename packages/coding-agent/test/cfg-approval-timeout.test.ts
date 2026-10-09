import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CfgProtocolHandler, setCfgApprovalHost } from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { cfgApprovalTimeoutMs, InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgMarketplaceAutoUpdate,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { resetSessionIndexForTests } from "@oh-my-pi/pi-coding-agent/session/session-index";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, Snowflake } from "@oh-my-pi/pi-utils";
import * as utils from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { createTestSession, type TestSessionContext } from "./utilities";

describe("cfg:// approval prompt timeout", () => {
	it("waits indefinitely when ask.timeout is at its default", () => {
		// Regression for #15080: the prompt used a hardcoded 10s deadline no matter what.
		expect(cfgApprovalTimeoutMs(Settings.isolated())).toBeUndefined();
	});

	it("converts ask.timeout seconds to a millisecond deadline", () => {
		// The exact product matters: the dialog consumes ms, the setting stores seconds.
		expect(cfgApprovalTimeoutMs(Settings.isolated({ "ask.timeout": 45 }))).toBe(45_000);
	});
});

describe("cfg:// approval prompt wiring", () => {
	let tmp: string;
	let originalProject: string;
	let testSession: TestSessionContext | undefined;
	let mode: InteractiveMode | undefined;

	beforeEach(async () => {
		tmp = path.join(os.tmpdir(), `omp-cfg-timeout-${Snowflake.next()}`);
		await fs.mkdir(tmp, { recursive: true });
		originalProject = getProjectDir();
		setProjectDir(tmp);
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp);
		resetSettingsForTest();
		await initTheme();
		await Settings.init({ inMemory: true, cwd: tmp });
	});

	afterEach(async () => {
		setCfgApprovalHost(null);
		mode?.stop();
		mode = undefined;
		if (testSession) {
			await testSession.cleanup();
			testSession = undefined;
		}
		vi.restoreAllMocks();
		resetSettingsForTest();
		setProjectDir(originalProject);
		AgentStorage.close();
		HistoryStorage.close();
		resetSessionIndexForTests();
		closeModelCache();
		await fs.rm(tmp, { recursive: true, force: true });
	});

	async function promptTimeoutSeen(askTimeout: number | undefined): Promise<Array<number | undefined>> {
		testSession = await createTestSession(
			askTimeout === undefined ? {} : { settingsOverrides: { "ask.timeout": askTimeout } },
		);
		cfgStartupCheckUpdate.override(testSession.session.settings, false);
		cfgStartupChangelogMode.override(testSession.session.settings, "hidden");
		cfgStartupSetupWizard.override(testSession.session.settings, false);
		cfgStartupShowSplash.override(testSession.session.settings, false);
		cfgMarketplaceAutoUpdate.override(testSession.session.settings, "off");
		mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: new VirtualTerminal(200, 60) }),
		);
		spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		const seen: Array<number | undefined> = [];
		spyOn(ExtensionUiController.prototype, "showCollabAwareSelector").mockImplementation(
			async (_title: string, _options: never, dialogOptions?: { timeout?: number }) => {
				seen.push(dialogOptions?.timeout);
				return "Allow once";
			},
		);
		await mode.init({ suppressWelcomeIntro: true });
		seen.length = 0;
		const session = {
			settings: testSession.session.settings,
			hasUI: true,
			settingsApproval: true,
			taskDepth: 0,
		} as unknown as ToolSession;
		await new CfgProtocolHandler().write(parseInternalUrl("cfg://advisor/enabled"), "true", { session });
		return seen;
	}

	it("prompts without a deadline when ask.timeout is at its default", async () => {
		// A hardcoded 10s here keeps the helper tests green: this is the
		// observable contract #15080 actually reports.
		expect(await promptTimeoutSeen(undefined)).toEqual([undefined]);
	}, 60_000);

	it("prompts with the ask.timeout deadline in milliseconds", async () => {
		expect(await promptTimeoutSeen(45)).toEqual([45_000]);
	}, 60_000);
});
