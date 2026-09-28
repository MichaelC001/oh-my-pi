import type { DesktopWindow } from "@oh-my-pi/pi-natives";

/** Titled windows named per app in a miss; the rest are counted. */
const WINDOWS_PER_APP = 3;
/** Titled windows named for an app the selector's `app` matched: those are the likely candidates. */
const WINDOWS_PER_MATCHED_APP = 10;

/**
 * What a window selector that matched nothing could have meant: every app
 * with an open window and the windows it has, apps matching the selector's
 * `app` first, so the next call can name an exact id (or conclude the app has
 * no window yet) without listing windows first.
 */
export function describeWindowMiss(windows: readonly DesktopWindow[], app: string | undefined): string {
	if (windows.length === 0) return "No windows are open.";
	// An empty `app` filters nothing in `matchesFilter`, so it matches no app here either.
	const needle = app?.toLocaleLowerCase() || undefined;
	const matched = (name: string): boolean => needle !== undefined && name.toLocaleLowerCase().includes(needle);
	const byApp = Map.groupBy(windows, window => window.app);
	const focusedApp = windows.find(window => window.focused)?.app;
	const rank = (name: string): number => (matched(name) ? 0 : name === focusedApp ? 1 : 2);
	const apps = [...byApp.keys()].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
	const lines = apps.map(name => {
		const group = byApp.get(name)!;
		const limit = matched(name) ? WINDOWS_PER_MATCHED_APP : WINDOWS_PER_APP;
		const named = group
			.filter(window => window.title.trim() !== "")
			.slice(0, limit)
			.map(window => `${window.id} ${JSON.stringify(window.title)}`);
		const rest = group.length - named.length;
		if (rest > 0) named.push(`${rest} ${named.length > 0 ? "more" : "untitled"}`);
		return `- ${name}: ${named.join(", ")}`;
	});
	const note =
		needle !== undefined && !apps.some(matched)
			? `No open window belongs to an app matching ${JSON.stringify(app)}.\n`
			: "";
	return `${note}Open windows by app (id "title"):\n${lines.join("\n")}`;
}
