import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import composerPredictionPrompt from "../../prompts/system/composer-prediction-user.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import { cfgComposerPredictions } from "../settings";
import type { InteractiveModeContext } from "../types";

/** Reply the prediction prompt asks for when the model has no confident guess. */
const SKIP_REPLY = "NO_PREDICTION";
/** Longer replies are rambling, not a message the user would type; drop them. */
const MAX_PREDICTION_LENGTH = 500;
/** One pair of double quotes or backticks around the whole reply. */
const WRAPPING_QUOTES = /^(?:"([^"]*)"|“([^“”]*)”|`([^`]*)`)$/;

/** The conversation point a prediction was made for: a new message or session invalidates it. */
interface PredictionSource {
	session: AgentSession;
	lastMessage: AgentMessage | undefined;
}

/**
 * Normalize a prediction reply to the single line the composer shows, or
 * `undefined` when the model skipped, rambled, or replied with nothing usable.
 */
export function parseComposerPrediction(reply: string): string | undefined {
	let text = sanitizeText(reply).replace(/\s+/g, " ").trim();
	const quoted = WRAPPING_QUOTES.exec(text);
	if (quoted) text = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").trim();
	if (!text || text.includes(SKIP_REPLY) || text.length > MAX_PREDICTION_LENGTH) return undefined;
	return text;
}

/**
 * Composer predictions: once a turn completes, run an ephemeral side turn on
 * the session's model and context (the same prompt prefix, so it reads the
 * prompt cache) asking for the user's likely next message, then offer it as
 * ghost text in the empty composer. Tab inserts it; nothing is sent.
 */
export class ComposerPredictionController {
	readonly #ctx: Pick<InteractiveModeContext, "settings" | "viewSession" | "editor" | "ui">;
	#abort: AbortController | undefined;
	#prediction: { text: string; source: PredictionSource } | undefined;

	constructor(ctx: Pick<InteractiveModeContext, "settings" | "viewSession" | "editor" | "ui">) {
		this.#ctx = ctx;
	}

	/** The prediction for the conversation as it stands now, if one is ready. */
	get text(): string | undefined {
		const prediction = this.#prediction;
		if (!prediction || !this.#isCurrent(prediction.source)) return undefined;
		return prediction.text;
	}

	/** Predict the next message for the turn that just completed, superseding any earlier prediction. */
	request(): void {
		this.cancel();
		if (!cfgComposerPredictions.get(this.#ctx.settings)) return;
		const session = this.#ctx.viewSession;
		// A draft typed during the turn would hide the ghost anyway: skip the billed request.
		if (!session.model || session.isStreaming || this.#ctx.editor.getText()) return;
		const abort = new AbortController();
		this.#abort = abort;
		void this.#run({ session, lastMessage: session.messages.at(-1) }, abort);
	}

	/** Abort an in-flight prediction and clear the shown one. */
	cancel(): void {
		this.#abort?.abort();
		this.#abort = undefined;
		if (!this.#prediction) return;
		this.#prediction = undefined;
		this.#ctx.ui.requestRender();
	}

	async #run(source: PredictionSource, abort: AbortController): Promise<void> {
		try {
			const { replyText } = await source.session.runEphemeralTurn({
				promptText: prompt.render(composerPredictionPrompt, { skip: SKIP_REPLY }),
				signal: abort.signal,
			});
			if (this.#abort !== abort || !this.#isCurrent(source)) return;
			const text = parseComposerPrediction(replyText);
			if (!text) return;
			this.#prediction = { text, source };
			this.#ctx.ui.requestRender();
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Composer prediction failed", { error: String(error) });
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
	}

	#isCurrent(source: PredictionSource): boolean {
		return this.#ctx.viewSession === source.session && source.session.messages.at(-1) === source.lastMessage;
	}
}
