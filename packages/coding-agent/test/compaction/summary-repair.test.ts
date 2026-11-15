import { describe, expect, it } from "vitest";
import {
	isPointerLine,
	repairUpdateSummary,
	SECTION_4_CHAR_CAP,
	SECTION_4_FLOOR_CHARS,
	TOTAL_CHAR_GUARD,
} from "../../src/core/extensions/builtin/compaction/summary-repair.ts";

function summary(sections: Record<number, string[]>): string {
	return Object.entries(sections)
		.map(([num, lines]) => [`## ${num}. Section ${num}`, ...lines, ""].join("\n"))
		.join("\n")
		.trimEnd();
}

function bodyOf(text: string, num: number): string[] {
	const lines = text.split("\n");
	const out: string[] = [];
	let inside = false;
	for (const line of lines) {
		const heading = /^##\s+(\d+)\./.exec(line);
		if (heading) {
			inside = Number(heading[1]) === num;
			continue;
		}
		if (inside && line.trim() !== "") out.push(line);
	}
	return out;
}

const POINTER = '- (All entries from <previous-summary> are preserved unchanged, from "a" through "z".)';

const previous = summary({
	1: ["- request A", "- request B", "- request C"],
	2: ["- goal: ship the fix"],
	3: ["- never push upstream", "- keep it offline"],
	4: ["- decision one", "- decision two"],
	5: ["- file x.ts"],
	6: ["- open question one"],
	7: ["- next: run tests"],
});

describe("isPointerLine", () => {
	it.each([
		"- (All entries from <previous-summary> are preserved unchanged, from a to b.)",
		"- (Everything in the previous summary is preserved.)",
		"- Label-app lane and exam dates are all as recorded in the previous summary.",
		"- see previous summary for the rest",
		"- preserved from <previous-summary>",
	])("flags %s", (line) => {
		expect(isPointerLine(line)).toBe(true);
	});

	it.each(["- request A", "- the summary of the previous quarter was fine", "- preserved the old file"])(
		"keeps %s",
		(line) => {
			expect(isPointerLine(line)).toBe(false);
		},
	);
});

describe("repairUpdateSummary sections 1 and 3", () => {
	it("restores a pointer-only section and removes the pointer", () => {
		const generated = summary({
			1: [POINTER],
			2: ["- goal: ship the fix"],
			3: ["- never push upstream", "- keep it offline", "- new constraint"],
			4: ["- decision one"],
			5: ["- file x.ts"],
			6: [],
			7: ["- next: run tests"],
		});
		const { summary: repaired, report } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 1)).toEqual(["- request A", "- request B", "- request C"]);
		expect(report.restored[1]).toBe(3);
		expect(report.pointersRemoved).toBe(1);
		expect(report.status).toBe("repaired");
		expect(repaired).not.toContain("<previous-summary>");
	});

	it("re-inserts missing lines in their original order before the new lines", () => {
		const generated = summary({
			1: ["- request B", "- brand new request"],
			2: ["- goal: ship the fix"],
			3: ["- never push upstream", "- keep it offline"],
			4: ["- decision one"],
			5: ["- file x.ts"],
			6: [],
			7: ["- next: run tests"],
		});
		const { summary: repaired, report } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 1)).toEqual(["- request A", "- request B", "- request C", "- brand new request"]);
		expect(report.restored[1]).toBe(2);
	});

	it("leaves a reordered but complete section untouched", () => {
		const generated = summary({
			1: ["- request C", "- request A", "- request B"],
			2: ["- goal: ship the fix"],
			3: ["- keep it offline", "- never push upstream"],
			4: ["- decision one", "- decision two"],
			5: ["- file x.ts"],
			6: ["- open question one"],
			7: ["- next: run tests"],
		});
		const result = repairUpdateSummary(previous, generated);
		expect(result.summary).toBe(generated);
		expect(result.report.status).toBe("unchanged");
	});

	it("drops a pointer line once the real lines are all present", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C", POINTER],
			2: ["- goal: ship the fix"],
			3: ["- never push upstream", "- keep it offline"],
			4: ["- decision one", "- decision two"],
			5: ["- file x.ts"],
			6: ["- open question one"],
			7: ["- next: run tests"],
		});
		const { summary: repaired, report } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 1)).toEqual(["- request A", "- request B", "- request C"]);
		expect(report.pointersRemoved).toBe(1);
		expect(report.restored[1]).toBe(0);
	});

	it("restores a dropped section heading in numeric position", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C"],
			2: ["- goal: ship the fix"],
			4: ["- decision one", "- decision two"],
			5: ["- file x.ts"],
			6: ["- open question one"],
			7: ["- next: run tests"],
		});
		const { summary: repaired, report } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 3)).toEqual(["- never push upstream", "- keep it offline"]);
		expect(report.restored[3]).toBe(2);
		expect(repaired.indexOf("## 3.")).toBeGreaterThan(repaired.indexOf("## 2."));
		expect(repaired.indexOf("## 3.")).toBeLessThan(repaired.indexOf("## 4."));
	});
});

describe("repairUpdateSummary section 2", () => {
	it("restores the previous goal when the new section is a pointer, keeping new lines", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C"],
			2: ["- (Final goal unchanged from the previous summary.)", "- plus a new sub-goal"],
			3: ["- never push upstream", "- keep it offline"],
			5: ["- file x.ts"],
			7: ["- next: run tests"],
		});
		const { summary: repaired, report } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 2)).toEqual(["- goal: ship the fix", "- plus a new sub-goal"]);
		expect(report.restored[2]).toBe(1);
	});

	it("restores the previous goal when the new section is empty", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C"],
			2: [],
			3: ["- never push upstream", "- keep it offline"],
			5: ["- file x.ts"],
			7: ["- next: run tests"],
		});
		const { summary: repaired } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 2)).toEqual(["- goal: ship the fix"]);
	});

	it("keeps a genuinely rewritten goal", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C"],
			2: ["- goal: something different now"],
			3: ["- never push upstream", "- keep it offline"],
			5: ["- file x.ts"],
			7: ["- next: run tests"],
		});
		const result = repairUpdateSummary(previous, generated);
		expect(result.summary).toBe(generated);
	});
});

describe("repairUpdateSummary sections 4 and 6", () => {
	it("replaces a pointer line with the previous section's lines, de-duplicated", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C"],
			2: ["- goal: ship the fix"],
			3: ["- never push upstream", "- keep it offline"],
			4: ["- decision two", "- (Everything in the previous summary is preserved.)", "- decision three"],
			5: ["- file x.ts"],
			6: ["- see previous summary"],
			7: ["- next: run tests"],
		});
		const { summary: repaired, report } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 4)).toEqual(["- decision two", "- decision one", "- decision three"]);
		expect(bodyOf(repaired, 6)).toEqual(["- open question one"]);
		expect(report.restored[4]).toBe(1);
		expect(report.restored[6]).toBe(1);
		expect(report.pointersRemoved).toBe(2);
	});
});

describe("repairUpdateSummary leaves sections 5 and 7 alone", () => {
	it("keeps pointer-looking text in sections 5 and 7 byte-identical", () => {
		const generated = summary({
			1: ["- request A", "- request B", "- request C", POINTER],
			2: ["- goal: ship the fix"],
			3: ["- never push upstream", "- keep it offline"],
			4: ["- decision one", "- decision two"],
			5: ["- same as in the previous summary: file x.ts"],
			6: ["- open question one"],
			7: ["- see previous summary, then run tests"],
		});
		const { summary: repaired } = repairUpdateSummary(previous, generated);
		expect(bodyOf(repaired, 5)).toEqual(["- same as in the previous summary: file x.ts"]);
		expect(bodyOf(repaired, 7)).toEqual(["- see previous summary, then run tests"]);
	});
});

describe("repairUpdateSummary parse failures", () => {
	it("stores the model summary unchanged when it has no headings", () => {
		const generated = "the model wrote free text with no sections";
		const result = repairUpdateSummary(previous, generated);
		expect(result.summary).toBe(generated);
		expect(result.report.status).toBe("skipped");
		expect(result.report.skipReason).toBe("new-unparsed");
	});

	it("stores the model summary unchanged when the previous summary has no headings", () => {
		const result = repairUpdateSummary("free text", previous);
		expect(result.summary).toBe(previous);
		expect(result.report.skipReason).toBe("previous-unparsed");
	});

	it("never throws on odd input", () => {
		for (const [prev, next] of [
			["", ""],
			["## 1.", "## 1."],
			["## 1. A\n- x", "## 1. A"],
			["\n\n", "## 9. Z"],
		] as const) {
			expect(() => repairUpdateSummary(prev, next)).not.toThrow();
		}
	});
});

describe("repairUpdateSummary idempotence", () => {
	it("repair(repair(x)) equals repair(x)", () => {
		const generated = summary({
			1: [POINTER],
			2: ["- (preserved unchanged from the previous summary)"],
			3: ["- keep it offline", "- new constraint"],
			4: [POINTER, "- decision three"],
			5: ["- file y.ts"],
			6: ["- (Everything in the previous summary is preserved.)"],
			7: ["- next: ship"],
		});
		const once = repairUpdateSummary(previous, generated).summary;
		const twice = repairUpdateSummary(previous, once);
		expect(twice.summary).toBe(once);
		expect(twice.report.status).toBe("unchanged");
	});
});

describe("repairUpdateSummary synthetic replay", () => {
	it("keeps every section 1 and 3 line across a chain of pointer-only model summaries", () => {
		let current = summary({
			1: ["- request 0"],
			2: ["- goal"],
			3: ["- constraint 0"],
			4: ["- decision 0"],
			5: ["- ctx 0"],
			6: ["- question 0"],
			7: ["- next 0"],
		});
		const everyRequest = ["- request 0"];
		const everyConstraint = ["- constraint 0"];
		for (let step = 1; step <= 8; step++) {
			const pointerStep = step > 3;
			everyRequest.push(`- request ${step}`);
			everyConstraint.push(`- constraint ${step}`);
			const generated = summary({
				1: pointerStep ? [POINTER, `- request ${step}`] : [...bodyOf(current, 1), `- request ${step}`],
				2: pointerStep ? ["- (Goal preserved from <previous-summary>.)"] : ["- goal"],
				3: pointerStep
					? [`- constraint ${step}`, "- (Everything in the previous summary is preserved.)"]
					: [...bodyOf(current, 3), `- constraint ${step}`],
				4: [pointerStep ? POINTER : "- decision 0"],
				5: [`- ctx ${step}`],
				6: ["- question 0"],
				7: [`- next ${step}`],
			});
			current = repairUpdateSummary(current, generated).summary;
			expect(bodyOf(current, 1)).toEqual(everyRequest);
			expect(bodyOf(current, 3)).toEqual(everyConstraint);
			expect(bodyOf(current, 2)).toEqual(["- goal"]);
			expect(current).not.toMatch(/previous[ -]summary/i);
		}
	});
});

function bulk(prefix: string, count: number, width = 80): string[] {
	return Array.from({ length: count }, (_, index) => `- ${prefix} ${index} ${"x".repeat(width)}`);
}

function sectionChars(text: string, num: number): number {
	let chars = 0;
	let inside = false;
	for (const line of text.split("\n")) {
		const heading = /^##\s+(\d+)\./.exec(line);
		if (heading) {
			inside = Number(heading[1]) === num;
			continue;
		}
		if (inside) chars += line.length + 1;
	}
	return chars;
}

const TRIM_LINE = /^- \(older progress trimmed: (\d+) lines\)$/;

function trimmedCount(text: string): number[] {
	return bodyOf(text, 4)
		.map((line) => TRIM_LINE.exec(line))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => Number(match[1]));
}

describe("repairUpdateSummary section 4 cap", () => {
	const progress = bulk("progress", 600);
	const base = (section4: string[]) =>
		summary({
			1: ["- request A"],
			2: ["- goal"],
			3: ["- constraint A"],
			4: section4,
			5: ["- ctx"],
			6: ["- question"],
			7: ["- next"],
		});
	const previousBig = base(progress);
	const generatedBig = base(["- model line A", POINTER, "- model line B"]);

	it("caps section 4 at SECTION_4_CHAR_CAP, dropping the oldest restored lines and keeping the model's own", () => {
		const { summary: repaired, report } = repairUpdateSummary(previousBig, generatedBig);
		expect(sectionChars(repaired, 4)).toBeLessThanOrEqual(SECTION_4_CHAR_CAP);
		const lines = bodyOf(repaired, 4);
		expect(lines).toContain("- model line A");
		expect(lines).toContain("- model line B");
		const restored = lines.filter((line) => line.startsWith("- progress "));
		const firstKept = Number(/progress (\d+) /.exec(restored[0] as string)?.[1]);
		expect(restored).toEqual(progress.slice(firstKept));
		expect(restored.at(-1)).toBe(progress[599]);
		expect(lines).not.toContain(progress[0]);
		expect(trimmedCount(repaired)).toEqual([600 - restored.length]);
		expect(report.trimmedLines).toBe(600 - restored.length);
		expect(report.restored[4]).toBe(restored.length);
	});

	it("puts the trim marker where the dropped lines began and keeps one cumulative marker", () => {
		const first = repairUpdateSummary(previousBig, generatedBig).summary;
		const [firstCount] = trimmedCount(first) as [number];
		expect(bodyOf(first, 4).findIndex((line) => TRIM_LINE.test(line))).toBe(1);

		const fresh = bulk("fresh", 40);
		const next = base(["- model line C", ...fresh, POINTER]);
		const second = repairUpdateSummary(first, next).summary;
		const counts = trimmedCount(second);
		expect(counts).toHaveLength(1);
		expect(counts[0]).toBeGreaterThan(firstCount);
		expect(sectionChars(second, 4)).toBeLessThanOrEqual(SECTION_4_CHAR_CAP);
		expect(bodyOf(second, 4)).toContain("- model line C");
		expect(bodyOf(second, 4)).toEqual(expect.arrayContaining(fresh));
	});

	it("is idempotent once capped", () => {
		const once = repairUpdateSummary(previousBig, generatedBig).summary;
		const again = repairUpdateSummary(previousBig, once);
		expect(again.summary).toBe(once);
		expect(again.report.status).toBe("unchanged");
	});

	it("never trims sections 1-3, 5 or 7", () => {
		const big = (prefix: string) => bulk(prefix, 200, 60);
		const previousWide = summary({
			1: big("req"),
			2: ["- goal"],
			3: big("con"),
			4: progress,
			5: big("ctx"),
			6: ["- question"],
			7: big("next"),
		});
		const generated = summary({
			1: [POINTER],
			2: ["- goal"],
			3: big("con"),
			4: [POINTER],
			5: big("ctx"),
			6: ["- question"],
			7: big("next"),
		});
		const { summary: repaired } = repairUpdateSummary(previousWide, generated);
		expect(bodyOf(repaired, 1)).toEqual(big("req"));
		expect(bodyOf(repaired, 3)).toEqual(big("con"));
		expect(bodyOf(repaired, 5)).toEqual(big("ctx"));
		expect(bodyOf(repaired, 7)).toEqual(big("next"));
		expect(sectionChars(repaired, 4)).toBeLessThanOrEqual(SECTION_4_CHAR_CAP);
	});
});

describe("repairUpdateSummary total guard", () => {
	const shell = (sections: { 1: string[]; 4: string[] }) =>
		summary({
			1: sections[1],
			2: ["- goal"],
			3: ["- constraint"],
			4: sections[4],
			5: ["- ctx"],
			6: ["- question"],
			7: ["- next"],
		});

	it("trims section 4 oldest-first until the whole summary fits TOTAL_CHAR_GUARD", () => {
		const request = bulk("req", 700, 90);
		const modelProgress = bulk("note", 250, 80);
		const input = shell({ 1: request, 4: modelProgress });
		expect(input.length).toBeGreaterThan(TOTAL_CHAR_GUARD);
		const { summary: repaired, report } = repairUpdateSummary(shell({ 1: request, 4: ["- seed"] }), input);
		expect(repaired.length).toBeLessThanOrEqual(TOTAL_CHAR_GUARD);
		expect(report.oversized).toBe(false);
		expect(bodyOf(repaired, 1)).toEqual(request);
		const kept = bodyOf(repaired, 4).filter((line) => line.startsWith("- note "));
		expect(kept).toEqual(modelProgress.slice(modelProgress.length - kept.length));
		expect(sectionChars(repaired, 4)).toBeGreaterThanOrEqual(SECTION_4_FLOOR_CHARS - 200);
		expect(trimmedCount(repaired)).toEqual([modelProgress.length - kept.length]);
		expect(repairUpdateSummary(shell({ 1: request, 4: ["- seed"] }), repaired).summary).toBe(repaired);
	});

	it("stops at the section 4 floor and reports oversized when the rest is too big", () => {
		const request = bulk("req", 780, 90);
		const modelProgress = bulk("note", 120, 80);
		const input = shell({ 1: request, 4: modelProgress });
		const { summary: repaired, report } = repairUpdateSummary(shell({ 1: request, 4: ["- seed"] }), input);
		expect(sectionChars(repaired, 4)).toBeLessThanOrEqual(SECTION_4_FLOOR_CHARS);
		expect(bodyOf(repaired, 4).length).toBeGreaterThan(0);
		expect(bodyOf(repaired, 1)).toEqual(request);
		expect(report.oversized).toBe(repaired.length > TOTAL_CHAR_GUARD);
	});

	it("stores a summary whose other sections alone exceed the guard and flags it", () => {
		const request = bulk("req", 900, 90);
		const input = shell({ 1: request, 4: bulk("note", 20, 80) });
		const result = repairUpdateSummary(shell({ 1: request, 4: ["- seed"] }), input);
		expect(result.summary).toBe(input);
		expect(result.report.status).toBe("unchanged");
		expect(result.report.oversized).toBe(true);
		expect(result.report.totalChars).toBe(input.length);
	});
});
