import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// #6400: the anthropic-subscription pool already states the instant it unblocks. The in-turn scheduler
// used to ignore it and burst 2s/4s/8s/16s/32s (times N) refusals; it must defer to the instant the goal
// wake already honours instead. The fixture is the exact refusal lane lead-03 observed.
const POOL_REFUSAL_MESSAGE = [
	"All Claude accounts for anthropic-subscription are currently blocked (rate limit or auth errors).",
	"  Soonest automatic retry: 2026-11-11T08:50:00.000Z.",
	"  /claude-account list  - inspect account states",
	"  /login anthropic-subscription  - add another account",
	"No request was sent: the account pool refused it locally.",
].join("\n");

const STATED_AT_MS = Date.parse("2026-11-11T08:50:00.000Z");
const NOW_MS = Date.parse("2026-11-11T07:32:18.673Z");
const STATED_DELAY_MS = STATED_AT_MS - NOW_MS; // 4,661,327
const MAX_RETRY_DELAY_MS = 5_000;

describe("a pool refusal that states its unblock instant defers instead of bursting (#6400)", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		// Pin Date so the decision sees the same "now" the refusal was written against; the host clock is
		// already past the stated instant.
		vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.useRealTimers();
	});

	it("schedules no in-turn retry when the stated instant is past the delay cap", async () => {
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetryDelayMs: MAX_RETRY_DELAY_MS } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: POOL_REFUSAL_MESSAGE }),
			fauxAssistantMessage("a retry must not reach the model"),
		]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([false]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("stops a tier2 wait (430s) too, not only a tier3 wait (4,661s)", async () => {
		// Run 1 of the measured corpus stated 20:01:25 from 19:54:15: a 430s wait, which lands in the
		// 300s-3,600s tier2 band. Tier2 used to clamp to 300s and burn the whole retry budget in-turn.
		vi.setSystemTime(Date.parse("2026-11-11T08:42:50.000Z"));
		const harness = await createHarness({
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetryDelayMs: MAX_RETRY_DELAY_MS } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: POOL_REFUSAL_MESSAGE }),
			fauxAssistantMessage("a retry must not reach the model"),
		]);

		await harness.session.prompt("test");

		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("reads the stated delay and keeps the typed marker first", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		const session = harness.session as unknown as {
			_getProviderRetryDelayMs(message: string): number | undefined;
		};

		expect(session._getProviderRetryDelayMs(POOL_REFUSAL_MESSAGE)).toBe(STATED_DELAY_MS);
		expect(session._getProviderRetryDelayMs(`${POOL_REFUSAL_MESSAGE} (retry-after-ms: 900)`)).toBe(900);

		// In _willRetryAfterAgentEnd: `if (providerDelayMs <= maxRetryDelayMs) return true;` then
		// `return this._retryFallback.canTryFallback();`. STATED_DELAY_MS exceeds every configured cap, and
		// this harness has no fallback chain, so the turn ends instead of scheduling a burst.
		expect(STATED_DELAY_MS).toBeGreaterThan(MAX_RETRY_DELAY_MS);
	});
});
