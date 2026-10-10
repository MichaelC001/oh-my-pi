import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ComposerPredictionController,
	parseComposerPrediction,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller";
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

interface HarnessOptions {
	enabled?: boolean;
	draft?: string;
	compacting?: boolean;
	focusedAgentId?: string;
	model?: Partial<Model>;
	deadlineMs?: number;
}

const MODEL = { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" } as Model;

function harness(options: HarnessOptions = {}) {
	const turns: PendingTurn[] = [];
	const usage: {
		entry: { purpose: string; usage: unknown };
		owner: { sessionId: string; parentId: string | null };
	}[] = [];
	const messages: AgentMessage[] = [{ role: "user", content: "fix the bug", timestamp: 1 } as AgentMessage];
	let leafId = "leaf-1";
	const session = {
		model: { ...MODEL, ...options.model },
		sessionId: "session-1",
		isStreaming: false,
		isCompacting: options.compacting ?? false,
		messages,
		sessionManager: {
			getLeafId: () => leafId,
			appendModelUsage: (entry: (typeof usage)[number]["entry"], owner: (typeof usage)[number]["owner"]) => {
				usage.push({ entry, owner });
				return "usage-entry";
			},
		},
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
		focusedAgentId: options.focusedAgentId,
		editor: { getText: () => options.draft ?? "" },
		ui: { requestRender: () => renders++ },
	} as unknown as ConstructorParameters<typeof ComposerPredictionController>[0];
	const reply = async (index: number, replyText: string) => {
		const turn = turns[index]!;
		const assistantMessage = {
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: { input: 10, output: 5 },
			stopReason: "stop",
		} as unknown as EphemeralTurnResult["assistantMessage"];
		turn.resolve({ replyText, assistantMessage });
		await turn.promise;
	};
	return {
		controller: new ComposerPredictionController(ctx, { deadlineMs: options.deadlineMs }),
		turns,
		usage,
		messages,
		reply,
		renders: () => renders,
		moveLeaf: (id: string) => {
			leafId = id;
		},
	};
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

	it("does not request while disabled, drafted, compacting, or viewing a subagent", () => {
		const blocked = [
			harness({ enabled: false }),
			harness({ draft: "my own message" }),
			harness({ compacting: true }),
			harness({ focusedAgentId: "0-Explore" }),
		];
		for (const { controller } of blocked) controller.request();

		expect(blocked.map(h => h.turns.length)).toEqual([0, 0, 0, 0]);
	});

	it("caps the side turn's output where the model honors a cap and omits it where it would be rejected", () => {
		const capped = harness();
		capped.controller.request();
		const uncappable = harness({ model: { omitMaxOutputTokens: true } });
		uncappable.controller.request();

		expect(capped.turns[0]!.options.maxTokens).toBe(1024);
		expect(uncappable.turns).toHaveLength(1);
		expect(uncappable.turns[0]!.options.maxTokens).toBeUndefined();
	});

	it("aborts a stalled prediction at the deadline", async () => {
		const { controller, turns } = harness({ deadlineMs: 20 });
		controller.request();
		const signal = turns[0]!.options.signal!;
		expect(signal.aborted).toBe(false);

		await Bun.sleep(60);

		expect(signal.aborted).toBe(true);
	});

	it("records the request's usage on the branch it was made from, even when the reply is discarded", async () => {
		const { controller, messages, usage, reply, moveLeaf } = harness();
		controller.request();
		moveLeaf("leaf-2");
		messages.push({ role: "user", content: "something else", timestamp: 2 } as AgentMessage);

		await reply(0, "too late");

		expect(controller.text).toBeUndefined();
		expect(usage).toEqual([
			{
				entry: expect.objectContaining({ purpose: "composer-prediction", usage: { input: 10, output: 5 } }),
				owner: { sessionId: "session-1", parentId: "leaf-1" },
			},
		]);
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
