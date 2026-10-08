import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import {
	type EvalToolDetails,
	evalToolRenderer,
	MAX_STATUS_EVENTS,
	recordStatusEvent,
	type StatusEventLog,
} from "@oh-my-pi/pi-tui/tools/eval";

/**
 * A cell that calls a helper in a loop emits one status event per call. The
 * log keeps the newest discrete events and counts the rest, so live updates
 * and the persisted tool result stay small, while agent progress cards and
 * committed `todo` results (read by the session todo panel) survive.
 */
describe("eval status event log", () => {
	let theme: Theme;

	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
	});

	it("keeps the newest discrete events and counts the dropped ones", () => {
		const log: StatusEventLog = {};
		const calls = MAX_STATUS_EVENTS + 1000;
		for (let i = 0; i < calls; i++) recordStatusEvent(log, { op: "browser", detail: `call ${i}` });

		expect(log.statusEvents).toHaveLength(MAX_STATUS_EVENTS);
		expect(log.statusEventsElided).toBe(1000);
		expect(log.statusEvents![0]!.detail).toBe("call 1000");
		expect(log.statusEvents!.at(-1)!.detail).toBe(`call ${calls - 1}`);
	});

	it("never drops agent snapshots or todo results", () => {
		const log: StatusEventLog = {};
		recordStatusEvent(log, { op: "todo", committed: true });
		recordStatusEvent(log, { op: "agent", id: "Scout", status: "running" });
		for (let i = 0; i < MAX_STATUS_EVENTS * 3; i++) recordStatusEvent(log, { op: "browser", detail: `call ${i}` });
		recordStatusEvent(log, { op: "agent", id: "Scout", status: "completed" });

		expect(log.statusEvents).toContainEqual({ op: "todo", committed: true });
		expect(log.statusEvents!.filter(event => event.op === "agent")).toEqual([
			{ op: "agent", id: "Scout", status: "completed" },
		]);
		expect(log.statusEvents).toHaveLength(MAX_STATUS_EVENTS);
	});

	it("includes dropped events in the rendered earlier-events count", () => {
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			cells: [
				{
					index: 0,
					code: "while (true) await tab.evaluate('1')",
					language: "js",
					output: "",
					status: "complete",
					statusEvents: [
						{ op: "browser", detail: "tab.evaluate one" },
						{ op: "browser", detail: "tab.evaluate two" },
						{ op: "browser", detail: "tab.evaluate three" },
						{ op: "browser", detail: "tab.evaluate four" },
					],
					statusEventsElided: 5000,
				},
			],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded: false, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));

		// Collapsed shows the newest 3; the 4th plus 5,000 dropped are counted.
		expect(rendered).toContain("… 5001 earlier");
		expect(rendered).toContain("tab.evaluate four");
	});
});
