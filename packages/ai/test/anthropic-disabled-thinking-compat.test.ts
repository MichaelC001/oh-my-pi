import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AnthropicCompat, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * A direct Anthropic model carrying the disabled-thinking dialect a KDL route
 * rule would assign (these axes are rule-only, so they layer onto the resolved compat).
 */
function model(id: string, compat: AnthropicCompat = {}): Model<"anthropic-messages"> {
	const built = buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
	return { ...built, compat: { ...built.compat, ...compat } };
}

/** A thinking-led tool round trip, then a new user turn. */
function thinkingLedHistory(id: string): Context {
	return {
		messages: [
			{ role: "user", content: "Read probe.txt.", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Read it.", thinkingSignature: "sig" },
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "probe.txt" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [{ type: "text", text: "nonce" }],
				isError: false,
				timestamp: 3,
			},
		],
		tools: [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } }],
	};
}

interface Payload {
	thinking?: { type: string };
	output_config?: { effort?: string };
	messages: Array<{ role: string; content: string | Array<{ type: string }> }>;
}

async function payloadFor(target: Model<"anthropic-messages">, context: Context): Promise<Payload> {
	const controller = new AbortController();
	controller.abort();
	let payload: unknown;
	await streamAnthropic(target, context, {
		apiKey: "sk-ant-api-test",
		signal: controller.signal,
		thinkingEnabled: false,
		onPayload: captured => {
			payload = captured;
		},
	}).result();
	if (!payload) throw new Error("expected a built payload");
	return payload as Payload;
}

const assistantBlockTypes = (payload: Payload) =>
	payload.messages
		.filter(message => message.role === "assistant")
		.flatMap(message => (Array.isArray(message.content) ? message.content.map(block => block.type) : []));

describe("Anthropic disabled-thinking compat", () => {
	it("sends between_tools with the pinned effort when the route declares that disabled form", async () => {
		const payload = await payloadFor(
			model("claude-sonnet-5-5", { disabledThinking: "between-tools", betweenToolsEffort: "high" }),
			thinkingLedHistory("claude-sonnet-5-5"),
		);
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBe("high");
	});

	it("pins the declared effort on the model's own between_tools fallback too", async () => {
		const payload = await payloadFor(
			model("claude-sonnet-5-5", { betweenToolsEffort: "medium" }),
			thinkingLedHistory("claude-sonnet-5-5"),
		);
		expect(payload.thinking).toEqual({ type: "between_tools" });
		expect(payload.output_config?.effort).toBe("medium");
	});

	it("replays history without thinking blocks when a stripping route sends disabled", async () => {
		const payload = await payloadFor(
			model("claude-opus-4-8", { disabledThinking: "disabled", stripThinkingHistory: true }),
			thinkingLedHistory("claude-opus-4-8"),
		);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(assistantBlockTypes(payload)).toEqual(["tool_use"]);
	});

	it("keeps replayed thinking on disabled turns for routes without the strip contract", async () => {
		const payload = await payloadFor(
			model("claude-opus-4-8", { disabledThinking: "disabled" }),
			thinkingLedHistory("claude-opus-4-8"),
		);
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(assistantBlockTypes(payload)).toEqual(["thinking", "tool_use"]);
	});
});
