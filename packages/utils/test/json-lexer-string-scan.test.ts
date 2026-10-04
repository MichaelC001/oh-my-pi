import { afterEach, describe, expect, it, vi } from "bun:test";
import { JsonLexer } from "@oh-my-pi/pi-utils/json-lexer";

const QUOTE = 0x22;

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Contract: `JsonLexer.string()` scans a string in linear time whatever its
 * escape density, and decodes it exactly. Streaming tool-call arguments are
 * re-lexed on every growth step, so a superlinear scan on escape-heavy
 * payloads (Windows paths, escaped code) turns each partial parse into a
 * stall. Linearity is asserted structurally — the scan must not search the
 * remaining input once per escape — instead of with wall-clock timing.
 */
describe("JsonLexer string scan", () => {
	it("does not re-search the remaining input once per escape", () => {
		const escapes = 4096;
		const src = `"${"\\\\".repeat(escapes)}${"x".repeat(64)}"`;
		const indexOf = vi.spyOn(String.prototype, "indexOf");

		const progress = new JsonLexer(src, "strict").string(QUOTE);
		// Count before asserting: matchers call indexOf themselves.
		const searches = indexOf.mock.calls.length;
		indexOf.mockRestore();

		// A quadratic scan searches for the far closing quote after every escape
		// (one call per escape at least); a linear one searches a bounded number
		// of times per ordinary-character run.
		expect(searches).toBeLessThan(16);
		expect(progress.complete).toBe(true);
		expect(progress.value).toBe(`${"\\".repeat(escapes)}${"x".repeat(64)}`);
	});

	it("decodes long mixed runs of text and escapes like the per-character scan", () => {
		const body = 'C:\\\\Users\\\\me\\\\file \\"quoted\\" \\n line \\u00e9 '.repeat(400);
		const src = `"${body}"`;

		const progress = new JsonLexer(src, "strict").string(QUOTE);

		expect(progress.value).toBe(JSON.parse(src));
	});
});
