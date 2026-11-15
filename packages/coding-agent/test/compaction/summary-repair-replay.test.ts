import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPointerLine, repairUpdateSummary } from "../../src/core/extensions/builtin/compaction/summary-repair.ts";

/**
 * The replay holds 30 real summaries from one long session, in order. It carries private session
 * text, so it is not committed: point SUMMARY_REPAIR_REPLAY at it to run this walk.
 */
const REPLAY_PATH = process.env.SUMMARY_REPAIR_REPLAY ?? "/data/projects/omo/compaction-fix/replay.json";
const replayAvailable = existsSync(REPLAY_PATH);

interface ReplayEntry {
	i: number;
	summary: string;
}

function sectionLines(text: string, num: number): string[] {
	const out: string[] = [];
	let inside = false;
	for (const line of text.split("\n")) {
		const heading = /^##\s+(\d+)\./.exec(line);
		if (heading) {
			inside = Number(heading[1]) === num;
			continue;
		}
		if (inside && line.trim() !== "") out.push(line.trimEnd());
	}
	return out;
}

const INDEPENDENT_POINTER_PHRASES = [
	/preserved unchanged/i,
	/preserved from/i,
	/as in the previous summary/i,
	/see previous summary/i,
	/everything in the previous summary/i,
	/<previous-summary>/i,
];

describe.skipIf(!replayAvailable)("repairUpdateSummary replay", () => {
	it("keeps every section 1 and 3 line across the real 30-summary chain", () => {
		const replay = JSON.parse(readFileSync(REPLAY_PATH, "utf8")) as ReplayEntry[];
		expect(replay.length).toBe(30);
		let previous = replay[0]?.summary ?? "";
		const rows: string[] = ["step raw_s1 repaired_s1 raw_s3 repaired_s3 raw_len repaired_len"];
		for (let index = 1; index < replay.length; index++) {
			const raw = replay[index]?.summary ?? "";
			const { summary: repaired } = repairUpdateSummary(previous, raw);
			for (const num of [1, 3]) {
				const kept = new Set(sectionLines(repaired, num));
				for (const line of sectionLines(previous, num)) {
					if (isPointerLine(line)) continue;
					expect(kept.has(line), `step ${index} section ${num} lost: ${line.slice(0, 80)}`).toBe(true);
				}
			}
			for (const num of [1, 2, 3]) {
				for (const line of sectionLines(repaired, num)) {
					for (const phrase of INDEPENDENT_POINTER_PHRASES) {
						expect(phrase.test(line), `step ${index} section ${num} pointer: ${line.slice(0, 80)}`).toBe(false);
					}
				}
			}
			expect(repairUpdateSummary(previous, repaired).summary).toBe(repaired);
			rows.push(
				[
					index,
					sectionLines(raw, 1).length,
					sectionLines(repaired, 1).length,
					sectionLines(raw, 3).length,
					sectionLines(repaired, 3).length,
					raw.length,
					repaired.length,
				].join(" "),
			);
			previous = repaired;
		}
		console.info(`${rows.join("\n")}\nfinal repaired length: ${previous.length}`);
	});
});
