import { describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { type CursorOptions, buildGrpcRequest, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	ExecServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	GetBlobArgsSchema,
	KvServerMessageSchema,
	McpArgsSchema,
	McpToolCallSchema,
	ReadArgsSchema,
	ReadTodosArgsSchema,
	ReadTodosToolCallSchema,
	SetBlobArgsSchema,
	StepCompletedUpdateSchema,
	TextDeltaUpdateSchema,
	ThinkingDeltaUpdateSchema,
	ToolCallCompletedUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// Records as Cursor's server writes them for one Kimi K3 turn that read a file:
// its reasoning names the server's own model, and the tool record is Cursor's.
const SERVER_MODEL_NAME = "accounts/fireworks/models/kimi-k3";
const SPAN = [
	JSON.stringify({
		role: "assistant",
		content: [
			{ type: "reasoning", text: "Read the file.", providerOptions: { cursor: { modelName: SERVER_MODEL_NAME } } },
			{ type: "tool-call", toolCallId: "call-read", toolName: "Read", args: { path: "/tmp/num.txt" } },
		],
		id: "1",
	}),
	JSON.stringify({
		role: "tool",
		content: [{ type: "tool-result", toolCallId: "call-read", toolName: "Read", result: "7919\n" }],
		id: "call-read",
	}),
	JSON.stringify({
		role: "assistant",
		content: [
			{
				type: "reasoning",
				text: "7919 is the 1000th prime.",
				providerOptions: { cursor: { modelName: SERVER_MODEL_NAME } },
			},
			{ type: "text", text: "7919 is prime — the 1000th prime." },
		],
		id: "1",
	}),
];
const SPAN_IDS = SPAN.map(record => blobId(record));
const SERVER_SYSTEM_ID = Uint8Array.of(0xc0, 0xff, 0xee);

function blobId(record: string): string {
	return new Bun.CryptoHasher("sha256").update(record).digest("hex");
}

function userRecord(requestId: string): string {
	return JSON.stringify({
		role: "user",
		content: [{ type: "text", text: "<user_query>\nIs the number in /tmp/num.txt prime?\n</user_query>" }],
		providerOptions: { cursor: { requestId } },
	});
}

function frame(message: AgentServerMessage["message"]): Buffer {
	const data = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
	const framed = Buffer.alloc(5 + data.length);
	framed.writeUInt32BE(data.length, 1);
	framed.set(data, 5);
	return framed;
}

function interaction(message: InteractionUpdate["message"]): Buffer {
	return frame({ case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) });
}

const thinkingFrame = (text: string) =>
	interaction({ case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text }) });
const textFrame = (text: string) => interaction({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) });
const turnEndedFrame = () => interaction({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });
const stepCompletedFrame = () => interaction({ case: "stepCompleted", value: create(StepCompletedUpdateSchema, {}) });

function setBlobFrame(id: number, record: string): Buffer {
	return frame({
		case: "kvServerMessage",
		value: create(KvServerMessageSchema, {
			id,
			message: {
				case: "setBlobArgs",
				value: create(SetBlobArgsSchema, {
					blobId: Buffer.from(blobId(record), "hex"),
					blobData: Buffer.from(record),
				}),
			},
		}),
	});
}

function getBlobFrame(id: number, hexId: string): Buffer {
	return frame({
		case: "kvServerMessage",
		value: create(KvServerMessageSchema, {
			id,
			message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: Buffer.from(hexId, "hex") }) },
		}),
	});
}

function checkpointFrame(root: Uint8Array[]): Buffer {
	return frame({
		case: "conversationCheckpointUpdate",
		value: create(ConversationStateStructureSchema, { rootPromptMessagesJson: root }),
	});
}

/** Cursor's native todo read, a tool its server runs and reports. */
const readTodosCall = create(ToolCallSchema, {
	tool: {
		case: "readTodosToolCall",
		value: create(ReadTodosToolCallSchema, { args: create(ReadTodosArgsSchema, {}) }),
	},
});

function execReadFrame(): Buffer {
	return frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, {
			id: 1,
			execId: "exec-read",
			message: {
				case: "readArgs",
				value: create(ReadArgsSchema, { path: "/tmp/num.txt", toolCallId: "call-read" }),
			},
		}),
	});
}

function decodeClientMessages(buffer: Buffer): AgentClientMessage[] {
	const messages: AgentClientMessage[] = [];
	let offset = 0;
	while (buffer.length - offset >= 5) {
		const length = buffer.readUInt32BE(offset + 1);
		if (buffer.length - offset < 5 + length) break;
		messages.push(fromBinary(AgentClientMessageSchema, buffer.subarray(offset + 5, offset + 5 + length)));
		offset += 5 + length;
	}
	return messages;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

type FixtureStream = (
	stream: http2.ServerHttp2Stream,
	headers: http2.IncomingHttpHeaders,
	received: AgentClientMessage[],
) => void;

/** Serves each Run stream with `handlers[n]`, called again on every client frame. */
async function withCursorServer<T>(handlers: FixtureStream[], run: (baseUrl: string) => Promise<T>): Promise<T> {
	const sessions = new Set<http2.Http2Session>();
	let streamCount = 0;
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		const handler = handlers[streamCount++];
		let buffered = Buffer.alloc(0);
		stream.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!stream.writableEnded) handler(stream, headers, decodeClientMessages(buffered));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");
	try {
		return await run(`http://127.0.0.1:${address.port}`);
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
}

function model(id: string, baseUrl = ""): Model<"cursor-agent"> {
	return buildModel({
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const firstUser: Message = { role: "user", content: "Is the number in /tmp/num.txt prime?", timestamp: 1 };
const secondUser: Message = { role: "user", content: "What is it plus 7921?", timestamp: 3 };

/**
 * Turn 1 on K3: the model reads a file through the exec channel, the server
 * writes its records and checkpoints them behind its own system entry, then
 * ends the turn and the step after the checkpoint, as Cursor does.
 */
const recordTurn: FixtureStream = (stream, headers, received) => {
	if (received.length === 1 && received[0].message.case === "runRequest") {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.write(Buffer.concat([thinkingFrame("Read the file."), execReadFrame()]));
		return;
	}
	if (!received.some(message => message.message.case === "execClientMessage")) return;
	const user = userRecord(String(headers["x-request-id"]));
	stream.end(
		Buffer.concat([
			setBlobFrame(2, user),
			...SPAN.map((record, index) => setBlobFrame(3 + index, record)),
			thinkingFrame("7919 is the 1000th prime."),
			textFrame("7919 is prime — the 1000th prime."),
			checkpointFrame([SERVER_SYSTEM_ID, ...[user, ...SPAN].map(record => Buffer.from(blobId(record), "hex"))]),
			turnEndedFrame(),
			stepCompletedFrame(),
		]),
	);
};

async function recordK3Turn(): Promise<{ assistant: AssistantMessage; toolResult: ToolResultMessage }> {
	const paired: ToolResultMessage[] = [];
	const assistant = await withCursorServer([recordTurn], async baseUrl => {
		const response = streamCursor(
			model("kimi-k3", baseUrl),
			{ messages: [firstUser] },
			{
				apiKey: "test-token",
				sessionId: `records-${crypto.randomUUID()}`,
				execHandlers: {
					async read() {
						return {
							role: "toolResult",
							toolCallId: "call-read",
							toolName: "read",
							content: [{ type: "text", text: "1|7919" }],
							isError: false,
							timestamp: 2,
						};
					},
				},
				onToolResult: result => {
					paired.push(result);
					return result;
				},
			},
		);
		for await (const _event of response) {
			// drain
		}
		return await response.result();
	});
	expect(paired).toHaveLength(1);
	// The session file stores both; resume reads them back from JSON.
	return structuredClone({ assistant, toolResult: paired[0] });
}

/** Streams one turn of `modelId` against `handler` and returns the assistant message. */
async function streamOnce(
	handler: FixtureStream,
	modelId: string,
	options: Omit<CursorOptions, "apiKey" | "sessionId"> = {},
): Promise<AssistantMessage> {
	return await withCursorServer([handler], async baseUrl => {
		const response = streamCursor(
			model(modelId, baseUrl),
			{ messages: [firstUser] },
			{ ...options, apiKey: "test-token", sessionId: `records-${crypto.randomUUID()}` },
		);
		for await (const _event of response) {
			// drain
		}
		return await response.result();
	});
}

async function rootPromptIds(
	target: Model<"cursor-agent">,
	messages: Message[],
): Promise<{ ids: string[]; records: string[] }> {
	const blobStore = new Map<string, Uint8Array>();
	const { conversationState } = await buildGrpcRequest(target, { messages } satisfies Context, undefined, {
		conversationId: `records-${crypto.randomUUID()}`,
		blobStore,
	});
	const ids = conversationState.rootPromptMessagesJson.map(hex);
	return { ids, records: ids.map(id => new TextDecoder().decode(blobStore.get(id))) };
}

describe("Cursor server records", () => {
	it("keeps the records the server wrote after the run's own user message", async () => {
		const { assistant } = await recordK3Turn();

		expect(assistant.stopReason).toBe("stop");
		expect(assistant.providerPayload).toEqual({ type: "cursorHistory", digest: expect.any(String), records: SPAN });
	});

	it("sends a resumed turn back as those records, and the server reads the same bytes", async () => {
		const { assistant, toolResult } = await recordK3Turn();
		let root: string[] = [];
		const fetched: string[] = [];
		const answerFetches: FixtureStream = (stream, _headers, received) => {
			const run = received[0]?.message;
			if (received.length === 1 && run?.case === "runRequest") {
				root = run.value.conversationState?.rootPromptMessagesJson.map(hex) ?? [];
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(Buffer.concat(SPAN_IDS.map((id, index) => getBlobFrame(10 + index, id))));
				return;
			}
			const results = received.flatMap(message =>
				message.message.case === "kvClientMessage" && message.message.value.message.case === "getBlobResult"
					? [new TextDecoder().decode(message.message.value.message.value.blobData)]
					: [],
			);
			if (results.length < SPAN.length) return;
			fetched.push(...results);
			stream.end(Buffer.concat([textFrame("15840"), turnEndedFrame()]));
		};

		const result = await withCursorServer([answerFetches], async baseUrl => {
			// A new session id: the blob store starts empty, as after a restart.
			const response = streamCursor(
				model("kimi-k3", baseUrl),
				{ messages: [firstUser, assistant, toolResult, secondUser] },
				{ apiKey: "test-token", sessionId: `records-${crypto.randomUUID()}` },
			);
			for await (const _event of response) {
				// drain
			}
			return await response.result();
		});

		expect(result.stopReason).toBe("stop");
		// Default system prompt, the user message omp builds, then the server's
		// records; the paired tool result is not rebuilt beside them.
		expect(root).toHaveLength(2 + SPAN.length);
		expect(root.slice(2)).toEqual(SPAN_IDS);
		expect(fetched).toEqual(SPAN);
	});

	it("rebuilds the turn for another model", async () => {
		const { assistant, toolResult } = await recordK3Turn();

		const { ids, records } = await rootPromptIds(model("composer-2.5"), [
			firstUser,
			assistant,
			toolResult,
			secondUser,
		]);

		expect(ids.filter(id => SPAN_IDS.includes(id))).toEqual([]);
		expect(records.slice(2).map(record => JSON.parse(record).role)).toEqual(["assistant", "tool", "assistant"]);
	});

	it("rebuilds a turn whose tool result changed after it was recorded", async () => {
		const { assistant, toolResult } = await recordK3Turn();
		const pruned: ToolResultMessage = { ...toolResult, content: [{ type: "text", text: "[pruned]" }] };

		const { ids, records } = await rootPromptIds(model("kimi-k3"), [firstUser, assistant, pruned, secondUser]);

		expect(ids.filter(id => SPAN_IDS.includes(id))).toEqual([]);
		expect(records.map(record => JSON.parse(record)).find(record => record.role === "tool")?.content[0].result).toBe(
			"[pruned]",
		);
	});

	it("keeps the records of a turn that resumed from a checkpoint", async () => {
		let firstRequestId = "";
		const dropAfterUserRecord: FixtureStream = (stream, headers, received) => {
			if (received.length !== 1) return;
			firstRequestId = String(headers["x-request-id"]);
			const user = userRecord(firstRequestId);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([
					setBlobFrame(1, user),
					textFrame("7919 is prime"),
					checkpointFrame([SERVER_SYSTEM_ID, Buffer.from(blobId(user), "hex")]),
				]),
			);
		};
		const finishResumed: FixtureStream = (stream, headers, received) => {
			if (received.length !== 1) return;
			expect(headers["x-original-request-id"]).toBe(firstRequestId);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([
					...SPAN.map((record, index) => setBlobFrame(2 + index, record)),
					textFrame(" — the 1000th prime."),
					checkpointFrame([
						SERVER_SYSTEM_ID,
						...[userRecord(firstRequestId), ...SPAN].map(record => Buffer.from(blobId(record), "hex")),
					]),
					turnEndedFrame(),
				]),
			);
		};

		const result = await withCursorServer([dropAfterUserRecord, finishResumed], async baseUrl => {
			const response = streamCursor(
				model("kimi-k3", baseUrl),
				{ messages: [firstUser] },
				{ apiKey: "test-token", sessionId: `records-${crypto.randomUUID()}`, providerRetryWait: async () => {} },
			);
			for await (const _event of response) {
				// drain
			}
			return await response.result();
		});

		expect(result.stopReason).toBe("stop");
		expect(result.providerPayload).toEqual({ type: "cursorHistory", digest: expect.any(String), records: SPAN });
	});

	it("rebuilds a turn whose answer continued after the last checkpoint", async () => {
		const partial = JSON.stringify({ role: "assistant", content: [{ type: "text", text: "first part" }] });
		const continueAfterCheckpoint: FixtureStream = (stream, headers, received) => {
			if (received.length !== 1) return;
			const user = userRecord(String(headers["x-request-id"]));
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([
					textFrame("first part"),
					setBlobFrame(1, user),
					setBlobFrame(2, partial),
					checkpointFrame([user, partial].map(record => Buffer.from(blobId(record), "hex"))),
					textFrame("; final answer 7919"),
					turnEndedFrame(),
				]),
			);
		};

		const assistant = await streamOnce(continueAfterCheckpoint, "composer-2.5");
		const { records } = await rootPromptIds(model("composer-2.5"), [firstUser, assistant, secondUser]);

		expect(assistant.stopReason).toBe("stop");
		expect(assistant.providerPayload).toBeUndefined();
		expect(records.some(record => record.includes("first part; final answer 7919"))).toBe(true);
	});

	it("rebuilds a turn whose tool result was sent after the last checkpoint", async () => {
		const call = JSON.parse(SPAN[0]).content[1];
		const callRecord = JSON.stringify({ role: "assistant", content: [call] });
		const checkpointBeforeResult: FixtureStream = (stream, headers, received) => {
			const user = userRecord(String(headers["x-request-id"]));
			if (received.length === 1 && received[0].message.case === "runRequest") {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(
					Buffer.concat([
						setBlobFrame(1, user),
						setBlobFrame(2, callRecord),
						execReadFrame(),
						checkpointFrame([user, callRecord].map(record => Buffer.from(blobId(record), "hex"))),
					]),
				);
				return;
			}
			if (received.some(message => message.message.case === "execClientMessage")) stream.end(turnEndedFrame());
		};

		const assistant = await streamOnce(checkpointBeforeResult, "kimi-k3", {
			execHandlers: {
				async read() {
					return {
						role: "toolResult",
						toolCallId: "call-read",
						toolName: "read",
						content: [{ type: "text", text: "1|7919" }],
						isError: false,
						timestamp: 2,
					};
				},
			},
		});

		expect(assistant.stopReason).toBe("stop");
		expect(assistant.providerPayload).toBeUndefined();
	});

	it("rebuilds a turn with a call the server never completed", async () => {
		const span = [
			JSON.stringify({
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "todo-open", toolName: "ReadTodos", args: {} }],
			}),
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "done" }] }),
		];
		const leaveCallOpen: FixtureStream = (stream, headers, received) => {
			if (received.length !== 1) return;
			const user = userRecord(String(headers["x-request-id"]));
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([
					interaction({
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, { callId: "todo-open", toolCall: readTodosCall }),
					}),
					textFrame("done"),
					setBlobFrame(1, user),
					...span.map((record, index) => setBlobFrame(2 + index, record)),
					checkpointFrame([user, ...span].map(record => Buffer.from(blobId(record), "hex"))),
					turnEndedFrame(),
				]),
			);
		};
		let interrupted: ToolResultMessage | undefined;

		const assistant = await streamOnce(leaveCallOpen, "composer-2.5", {
			onToolResult: result => {
				interrupted = result;
				return result;
			},
		});
		if (!interrupted) throw new Error("expected the flush to pair the open call");
		const { records } = await rootPromptIds(model("composer-2.5"), [firstUser, assistant, interrupted, secondUser]);

		expect(assistant.stopReason).toBe("stop");
		expect(assistant.providerPayload).toBeUndefined();
		expect(
			records.some(record => record.includes("The connection to Cursor closed before this call completed.")),
		).toBe(true);
	});

	it("keeps the records of an MCP call its exec reply answered without a completion frame", async () => {
		const args = create(McpArgsSchema, {
			name: "read",
			toolName: "read",
			toolCallId: "call-read",
			args: { path: Buffer.from(JSON.stringify("/tmp/num.txt")) },
		});
		const announceThenExec: FixtureStream = (stream, headers, received) => {
			if (received.length === 1) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(
					Buffer.concat([
						thinkingFrame("Read the file."),
						interaction({
							case: "toolCallStarted",
							value: create(ToolCallStartedUpdateSchema, {
								callId: "envelope-mcp",
								toolCall: create(ToolCallSchema, {
									tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
								}),
							}),
						}),
						frame({
							case: "execServerMessage",
							value: create(ExecServerMessageSchema, {
								id: 1,
								execId: "exec-mcp",
								message: { case: "mcpArgs", value: args },
							}),
						}),
					]),
				);
				return;
			}
			if (!received.some(message => message.message.case === "execClientMessage")) return;
			const user = userRecord(String(headers["x-request-id"]));
			stream.end(
				Buffer.concat([
					thinkingFrame("7919 is the 1000th prime."),
					textFrame("7919 is prime — the 1000th prime."),
					setBlobFrame(1, user),
					...SPAN.map((record, index) => setBlobFrame(2 + index, record)),
					checkpointFrame([user, ...SPAN].map(record => Buffer.from(blobId(record), "hex"))),
					turnEndedFrame(),
				]),
			);
		};

		const assistant = await streamOnce(announceThenExec, "kimi-k3", {
			execHandlers: {
				async mcp() {
					return {
						role: "toolResult",
						toolCallId: "call-read",
						toolName: "read",
						content: [{ type: "text", text: "1|7919" }],
						isError: false,
						timestamp: 2,
					};
				},
			},
			onToolResult: result => result,
		});

		expect(assistant.stopReason).toBe("stop");
		expect(assistant.providerPayload).toEqual({ type: "cursorHistory", digest: expect.any(String), records: SPAN });
	});

	it("digests the result a server-owned tool's host stores once it settles", async () => {
		const span = [
			JSON.stringify({
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "todo-1", toolName: "ReadTodos", args: {} }],
			}),
			JSON.stringify({
				role: "tool",
				content: [{ type: "tool-result", toolCallId: "todo-1", toolName: "ReadTodos", result: "No todos" }],
			}),
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "done" }] }),
		];
		const readTodos: FixtureStream = (stream, headers, received) => {
			if (received.length !== 1) return;
			const user = userRecord(String(headers["x-request-id"]));
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end(
				Buffer.concat([
					interaction({
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, { callId: "todo-1", toolCall: readTodosCall }),
					}),
					interaction({
						case: "toolCallCompleted",
						value: create(ToolCallCompletedUpdateSchema, { callId: "todo-1", toolCall: readTodosCall }),
					}),
					textFrame("done"),
					setBlobFrame(1, user),
					...span.map((record, index) => setBlobFrame(2 + index, record)),
					checkpointFrame([user, ...span].map(record => Buffer.from(blobId(record), "hex"))),
					turnEndedFrame(),
				]),
			);
		};
		let stored: ToolResultMessage | undefined;

		const assistant = await streamOnce(readTodos, "composer-2.5", {
			// The host rewrites the result asynchronously and the native todo path
			// does not await it. A real delay: nothing observable sits between the
			// transport's end and the capture for a gate to wait on.
			onToolResult: async result => {
				await Bun.sleep(5);
				stored = { ...result, content: [{ type: "text", text: "No todos (stored)" }] };
				return stored;
			},
		});
		if (!stored) throw new Error("expected the host to store the todo result before the turn ended");
		const { ids } = await rootPromptIds(model("composer-2.5"), [firstUser, assistant, stored, secondUser]);

		expect(ids.slice(2)).toEqual(span.map(record => blobId(record)));
	});
});
