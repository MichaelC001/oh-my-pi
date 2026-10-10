/**
 * How soon an account's saved rate-limit resets expire, and whether anything
 * will spend them first. Shared by `omp usage` and the TUI status line so both
 * warn about the accounts the salvage planners would act on.
 */
import type { UsageLimit, UsageReport, UsageResetCredit, UsageResetCreditDetail } from "@oh-my-pi/pi-ai";
import { bankedResetCreditExpiryMs } from "@oh-my-pi/pi-tui/overlays/usage-display";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { formatActiveAccountLabel, usageReportIdentity } from "../slash-commands/helpers/active-oauth-account";
import { formatResetProviderName } from "../slash-commands/helpers/reset-usage";
import {
	type ClaudeResetAction,
	type ClaudeResetSkip,
	type ClaudeResetSkipReason,
	claudeCoveredLimits,
	fullestClaudeLimit,
	planClaudeResetRedemptions,
} from "./claude-auto-reset";
import {
	type CodexResetAction,
	type CodexResetSkip,
	type CodexResetSkipReason,
	fullestCodexChatWindow,
	IMMINENT_RESET_EXPIRY_MS,
	planCodexResetRedemptions,
	resetPlanSettings,
	SALVAGE_MIN_USED_FRACTION,
	shouldPromptCodexAutoRedeem,
} from "./codex-auto-reset";
import {
	cfgClaudeResets,
	cfgClaudeResetsAutoRedeem,
	cfgCodexResets,
	cfgCodexResetsAutoRedeem,
	type ResetAutoRedeemMode,
} from "./settings";

const SOON_MS = 7 * 24 * 3_600_000;
const IMMINENT_MS = 24 * 3_600_000;

/** Saved resets close to expiry on an account whose fullest chat window is worth restoring. */
export interface ResetExpiryWarning {
	provider: "openai-codex" | "anthropic";
	/** `soon`: the soonest reset expires within 7 days; `imminent`: within 24 hours. */
	tier: "soon" | "imminent";
	/** Banked resets that expire within the tier's horizon, usable now or not. */
	count: number;
	/** Soonest expiry among them (epoch ms). */
	expiresAtMs: number;
	/** Whether the provider lets the soonest one be spent now. */
	usableNow: boolean;
	/** The chat window the salvage planner measures for this account. */
	limit: UsageLimit;
	usedFraction: number;
}

/**
 * Classify an account's banked saved resets by expiry, including ones the
 * provider will not let it spend yet. An account whose fullest chat window is
 * below {@link SALVAGE_MIN_USED_FRACTION} gets no warning: the salvage
 * planners skip it as well.
 */
export function classifyResetExpiry(report: UsageReport, nowMs: number): ResetExpiryWarning | undefined {
	const provider = report.provider;
	if (provider !== "openai-codex" && provider !== "anthropic") return undefined;
	const credits: { credit: UsageResetCreditDetail; expiresAtMs: number }[] = [];
	for (const credit of report.resetCredits?.credits ?? []) {
		const expiresAtMs = bankedResetCreditExpiryMs(credit);
		if (expiresAtMs !== undefined && expiresAtMs > nowMs) credits.push({ credit, expiresAtMs });
	}
	if (credits.length === 0) return undefined;
	const soonest = credits.reduce((best, entry) => (entry.expiresAtMs < best.expiresAtMs ? entry : best));
	const remainingMs = soonest.expiresAtMs - nowMs;
	if (remainingMs > SOON_MS) return undefined;

	let fullest: { limit: UsageLimit; usedFraction: number } | undefined;
	if (provider === "openai-codex") {
		const window = fullestCodexChatWindow(report);
		if (window?.usedFraction !== undefined) fullest = { limit: window.limit, usedFraction: window.usedFraction };
	} else {
		const covered = fullestClaudeLimit(claudeCoveredLimits(report.limits, soonest.credit), soonest.credit);
		if (covered) fullest = { limit: covered.limit, usedFraction: covered.used };
	}
	if (!fullest || fullest.usedFraction < SALVAGE_MIN_USED_FRACTION) return undefined;

	const tier = remainingMs <= IMMINENT_MS ? "imminent" : "soon";
	const horizonMs = tier === "imminent" ? IMMINENT_MS : SOON_MS;
	let count = 0;
	for (const { credit, expiresAtMs } of credits) {
		if (expiresAtMs - nowMs <= horizonMs) count += credit.remainingCount ?? 1;
	}
	const usableNow = (soonest.credit.status ?? "available") === "available" && soonest.credit.usable !== false;
	return { provider, tier, count, expiresAtMs: soonest.expiresAtMs, usableNow, ...fullest };
}

export type ResetSkipReason = CodexResetSkipReason | ClaudeResetSkipReason;

/**
 * What the salvage sweep does with an account's soonest expiring saved reset.
 * `auto` spends it and `ask` prompts first, both only in an open interactive
 * omp session; `off` is the provider setting; `skip` carries the planner's
 * reason for passing it over.
 */
export type ResetSpendVerdict = {
	setting: "codexResets.autoRedeem" | "claudeResets.autoRedeem";
	mode: ResetAutoRedeemMode;
} & ({ kind: "auto" | "ask" | "off" } | { kind: "skip"; reason: ResetSkipReason });

/**
 * Ask the provider's salvage planner about the warning's reset at its last
 * chance, the latest moment a sweep would spend it, over this report.
 */
export function resetSpendVerdict(
	report: UsageReport,
	warning: ResetExpiryWarning,
	settings: Settings,
	nowMs: number,
): ResetSpendVerdict {
	const autoRedeem = warning.provider === "anthropic" ? cfgClaudeResetsAutoRedeem : cfgCodexResetsAutoRedeem;
	const setting = autoRedeem.id;
	const mode = autoRedeem.get(settings);
	const atMs = Math.max(nowMs, warning.expiresAtMs - IMMINENT_RESET_EXPIRY_MS);
	const plan = planSalvage(report, warning.provider, settings, atMs);
	const action = plan.actions[0];
	if (action?.expiresInMs === warning.expiresAtMs - atMs) {
		return { setting, mode, kind: shouldPromptCodexAutoRedeem(mode) ? "ask" : "auto" };
	}
	const reason = plan.skipped[0]?.reason;
	if (reason === "disabled") return { setting, mode, kind: "off" };
	// The planners only weigh a reset the provider lets them spend now; any skip reason is another reset's.
	return {
		setting,
		mode,
		kind: "skip",
		reason: warning.usableNow ? (reason ?? "no-expiring-credit") : "credit-unusable",
	};
}

/** The salvage sweep's plan for one account at `nowMs`, as if its report had just been fetched. */
function planSalvage(
	report: UsageReport,
	provider: ResetExpiryWarning["provider"],
	settings: Settings,
	nowMs: number,
): {
	actions: readonly (CodexResetAction | ClaudeResetAction)[];
	skipped: readonly (CodexResetSkip | ClaudeResetSkip)[];
} {
	const current = { ...report, fetchedAt: nowMs };
	const episodes = {
		attemptedKeys: new Set<string>(),
		deferredUntilByKey: new Map<string, number>(),
		lastAttemptAtByAccount: new Map<string, number>(),
	};
	// The planners key accounts by credential id, which none of their rules read.
	const credentialId = 0;
	if (provider === "openai-codex") {
		return planCodexResetRedemptions({
			nowMs,
			trigger: "sweep",
			provider: "",
			modelId: "",
			settings: resetPlanSettings(cfgCodexResets.get(settings)),
			identity: undefined,
			reports: [{ ...current, metadata: { ...report.metadata, resetCreditCredentialId: credentialId } }],
			...episodes,
		});
	}
	const { credits = [], ...inventory } = report.resetCredits ?? { availableCount: 0 };
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	return planClaudeResetRedemptions({
		nowMs,
		trigger: "sweep",
		provider: "",
		modelId: "",
		settings: resetPlanSettings(cfgClaudeResets.get(settings)),
		reports: [current],
		statuses: [
			{
				...inventory,
				provider,
				credentialId,
				accountId: text(report.metadata?.accountId),
				email: text(report.metadata?.email),
				orgId: text(report.metadata?.orgId),
				credits: credits.filter((credit): credit is UsageResetCredit => typeof credit.id === "string"),
				active: false,
				report: current,
			},
		],
		...episodes,
	});
}

/** One-line TUI warning for the soonest saved reset expiring within 24 hours across the pool. */
export function formatResetExpiryNotice(reports: readonly UsageReport[], nowMs: number): string | undefined {
	let soonest: { report: UsageReport; warning: ResetExpiryWarning } | undefined;
	let accounts = 0;
	for (const report of reports) {
		const warning = classifyResetExpiry(report, nowMs);
		if (warning?.tier !== "imminent") continue;
		accounts++;
		if (!soonest || warning.expiresAtMs < soonest.warning.expiresAtMs) soonest = { report, warning };
	}
	if (!soonest) return undefined;
	const { report, warning } = soonest;
	const provider = formatResetProviderName(warning.provider);
	const label = formatActiveAccountLabel(usageReportIdentity(report));
	const account = label ? ` on ${label}` : "";
	const due = formatDuration(warning.expiresAtMs - nowMs);
	const resets =
		warning.count === 1
			? `Saved ${provider} reset${account} expires in ${due}`
			: `${warning.count} saved ${provider} resets${account} expire, soonest in ${due}`;
	const others = accounts > 1 ? ` (and ${accounts - 1} more account${accounts === 2 ? "" : "s"})` : "";
	return `${resets}${others} · /usage`;
}
