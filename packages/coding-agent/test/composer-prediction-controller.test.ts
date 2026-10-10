import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ComposerPredictionController,
	parseComposerPrediction,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { EphemeralTurnOptions, EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

describe("parseComposerPrediction", () => {
	it("normalizes a reply to the single line the composer shows", () => {
		expect(parseComposerPrediction("  run the\n  tests\t now ")).toBe("run the tests now");
		expect(parseComposerPrediction('"ship it"')).toBe("ship it");
		expect(parseComposerPrediction("“ship it”")).toBe("ship it");
		expect(parseComposerPrediction('use "bun test" here')).toBe('use "bun test" here');
	});

	it("rejects skips, empty replies, and rambling", () => {
		expect(parseComposerPrediction("NO_PREDICTION")).toBeUndefined();
		expect(parseComposerPrediction("NO_PREDICTION.")).toBeUndefined();
		expect(parseComposerPrediction(' "" ')).toBeUndefined();
		expect(parseComposerPrediction("word ".repeat(200))).toBeUndefined();
	});
});

interface PendingTurn {
	options: EphemeralTurnOptions;
	resolve: (result: EphemeralTurnResult) => void;
	/** Settles after the controller's own continuation, which awaited it first. */
	promise: Promise<EphemeralTurnResult>;
}

function harness(options: { enabled?: boolean; draft?: string } = {}) {
	const turns: PendingTurn[] = [];
	const messages: AgentMessage[] = [{ role: "user", content: "fix the bug", timestamp: 1 } as AgentMessage];
	const session = {
		model: { id: "model" },
		isStreaming: false,
		messages,
		runEphemeralTurn(turnOptions: EphemeralTurnOptions): Promise<EphemeralTurnResult> {
			const { promise, resolve } = Promise.withResolvers<EphemeralTurnResult>();
			turns.push({ options: turnOptions, resolve, promise });
			return promise;
		},
	};
	let renders = 0;
	const ctx = {
		settings: Settings.isolated({ "composer.predictions": options.enabled ?? true }),
		viewSession: session,
		editor: { getText: () => options.draft ?? "" },
		ui: { requestRender: () => renders++ },
	} as unknown as Pick<InteractiveModeContext, "settings" | "viewSession" | "editor" | "ui">;
	const reply = async (index: number, replyText: string) => {
		const turn = turns[index]!;
		turn.resolve({ replyText, assistantMessage: {} as EphemeralTurnResult["assistantMessage"] });
		await turn.promise;
	};
	return { controller: new ComposerPredictionController(ctx), turns, messages, reply, renders: () => renders };
}

describe("ComposerPredictionController", () => {
	it("offers the reply for the conversation it was predicted from", async () => {
		const { controller, reply, renders } = harness();
		controller.request();
		expect(controller.text).toBeUndefined();

		await reply(0, "now run the tests");

		expect(controller.text).toBe("now run the tests");
		expect(renders()).toBe(1);
	});

	it("does not request while disabled or while a draft is in the composer", () => {
		const disabled = harness({ enabled: false });
		disabled.controller.request();
		const drafted = harness({ draft: "my own message" });
		drafted.controller.request();

		expect(disabled.turns).toEqual([]);
		expect(drafted.turns).toEqual([]);
	});

	it("hides a prediction once the conversation moves past it", async () => {
		const { controller, messages, reply } = harness();
		controller.request();
		await reply(0, "now run the tests");

		messages.push({ role: "user", content: "something else", timestamp: 2 } as AgentMessage);

		expect(controller.text).toBeUndefined();
	});

	it("drops a reply that lands after cancel or a newer request", async () => {
		const { controller, turns, reply } = harness();
		controller.request();
		controller.cancel();
		expect(turns[0]!.options.signal?.aborted).toBe(true);
		await reply(0, "stale prediction");
		expect(controller.text).toBeUndefined();

		controller.request();
		controller.request();
		await reply(1, "superseded prediction");
		expect(controller.text).toBeUndefined();
		await reply(2, "latest prediction");
		expect(controller.text).toBe("latest prediction");
	});
});
