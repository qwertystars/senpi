/**
 * Deterministic post-check for the *update* compaction variant.
 *
 * The update prompt tells the model to keep sections 1 (User Requests), 2 (Final Goal) and 3
 * (Constraints) of `<previous-summary>` byte-for-byte, but nothing enforced it: models often wrote a
 * pointer such as "(All entries from <previous-summary> are preserved unchanged ...)" instead, and the
 * stored pointer destroyed the real text for every later compaction. This module repairs the generated
 * summary against the previous one before it is stored. It is pure and never throws.
 *
 * Sections 1-3 only ever grow (R3), so section 4 is the pressure valve: refilled pointer lines are
 * capped at SECTION_4_CHAR_CAP and the whole summary is guarded at TOTAL_CHAR_GUARD, always dropping
 * the oldest restored lines first. Sections 5 and 7 (and anything not named here) are never touched.
 */

export const SECTION_4_CHAR_CAP = 24_000;
export const TOTAL_CHAR_GUARD = 80_000;
export const SECTION_4_FLOOR_CHARS = 4_000;

export interface SummaryRepairReport {
	status: "unchanged" | "repaired" | "skipped";
	skipReason?: "previous-unparsed" | "new-unparsed" | "repair-error";
	/** Lines re-inserted from the previous summary, per section number (net of trimmed lines). */
	restored: Readonly<Record<RepairedSection, number>>;
	/** Pointer-only lines removed from the new summary (including ones swapped for real lines). */
	pointersRemoved: number;
	/** Section 4 lines dropped by the section cap or the total guard. */
	trimmedLines: number;
	/** Length of the summary that is stored. */
	totalChars: number;
	/** The stored summary still exceeds TOTAL_CHAR_GUARD because sections other than 4 are too large. */
	oversized: boolean;
}

export interface SummaryRepairResult {
	summary: string;
	report: SummaryRepairReport;
}

type RepairedSection = 1 | 2 | 3 | 4 | 6;

interface Section {
	num: number;
	heading: string;
	body: string[];
}

interface ParsedSummary {
	preamble: string[];
	sections: Section[];
}

interface SectionRepair {
	body: string[];
	restored: number;
	pointers: number;
	trimmed: number;
}

const HEADING = /^##\s+(\d+)\.(?:\s|$)/;
const PREVIOUS_REFERENCE = /previous[ -]summary|prior summary|earlier summary/i;
const POINTER_WORDING =
	/preserv|unchanged|as recorded|\bas in\b|\bsee\b|carried (?:over|forward)|retained|kept (?:as|verbatim)|same as|remain(?:s)? (?:as|the same)|not repeated|omitted/i;
const TRIM_MARKER = /older progress trimmed: (\d+) lines/;
const VERBATIM_SECTIONS = [1, 3] as const;
const POINTER_SECTIONS = [4, 6] as const;

/** A line that refers to the previous summary instead of carrying content. */
export function isPointerLine(line: string): boolean {
	return PREVIOUS_REFERENCE.test(line) && POINTER_WORDING.test(line);
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function trimMarkerCount(line: string): number | undefined {
	const match = TRIM_MARKER.exec(line);
	return match ? Number(match[1]) : undefined;
}

function trimMarkerLine(count: number): string {
	return `- (older progress trimmed: ${count} lines)`;
}

function sectionChars(lines: readonly string[]): number {
	let chars = 0;
	for (const line of lines) chars += line.length + 1;
	return chars;
}

function parse(text: string): ParsedSummary | undefined {
	const preamble: string[] = [];
	const sections: Section[] = [];
	for (const line of text.split("\n")) {
		const match = HEADING.exec(line);
		if (match) {
			sections.push({ num: Number(match[1]), heading: line, body: [] });
			continue;
		}
		const current = sections[sections.length - 1];
		if (current) current.body.push(line);
		else preamble.push(line);
	}
	return sections.length > 0 ? { preamble, sections } : undefined;
}

function render(parsed: ParsedSummary): string {
	return [...parsed.preamble, ...parsed.sections.flatMap((section) => [section.heading, ...section.body])].join("\n");
}

function findSection(parsed: ParsedSummary, num: number): Section | undefined {
	return parsed.sections.find((section) => section.num === num);
}

function trimEndBlank(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && isBlank(lines[end - 1] as string)) end--;
	return lines.slice(0, end);
}

function lineKey(line: string): string {
	return line.trimEnd();
}

/** The previous section's body without pointer lines: what must survive verbatim. */
function realBody(section: Section | undefined): string[] {
	return section ? trimEndBlank(section.body.filter((line) => !isPointerLine(line))) : [];
}

function hasRealContent(lines: string[]): boolean {
	return lines.some((line) => !isBlank(line) && !isPointerLine(line));
}

function priorTrimmed(section: Section | undefined): number {
	let count = 0;
	for (const line of section?.body ?? []) count = Math.max(count, trimMarkerCount(line) ?? 0);
	return count;
}

function emptyRestored(): Record<RepairedSection, number> {
	return { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 };
}

function withTrailingBlank(lines: string[], original: string[]): string[] {
	const endsBlank = original.length > 0 && isBlank(original[original.length - 1] as string);
	return endsBlank ? [...lines, ""] : lines;
}

/**
 * Drop the oldest droppable lines until the section fits `limit`, keeping one cumulative
 * "(older progress trimmed: N lines)" marker where the dropped lines began. Existing markers
 * (and `prior`, the count carried by the previous summary) fold into that single marker.
 */
function trimOldest(
	lines: string[],
	droppable: boolean[],
	limit: number,
	prior: number,
): { lines: string[]; dropped: number } {
	const kept: { line: string; droppable: boolean }[] = [];
	let markerAt = -1;
	let carried = prior;
	lines.forEach((line, index) => {
		const count = trimMarkerCount(line);
		if (count === undefined) {
			kept.push({ line, droppable: droppable[index] === true && !isBlank(line) });
			return;
		}
		if (markerAt === -1) markerAt = kept.length;
		carried = Math.max(carried, count);
	});

	let size = sectionChars(kept.map((entry) => entry.line));
	const dropIndexes = new Set<number>();
	let firstDropped = -1;
	for (let index = 0; index < kept.length; index++) {
		const markerCount = carried + dropIndexes.size;
		const total = size + (markerCount > 0 ? trimMarkerLine(markerCount).length + 1 : 0);
		if (total <= limit) break;
		const entry = kept[index] as { line: string; droppable: boolean };
		if (!entry.droppable) continue;
		size -= entry.line.length + 1;
		dropIndexes.add(index);
		if (firstDropped === -1) firstDropped = index;
	}

	const markerCount = carried + dropIndexes.size;
	const firstDroppable = kept.findIndex((entry) => entry.droppable);
	let insertAt = -1;
	if (markerCount > 0) {
		if (firstDropped !== -1) insertAt = firstDropped;
		else if (markerAt !== -1) insertAt = markerAt;
		else insertAt = firstDroppable === -1 ? kept.length : firstDroppable;
	}
	const out: string[] = [];
	kept.forEach((entry, index) => {
		if (index === insertAt) out.push(trimMarkerLine(markerCount));
		if (!dropIndexes.has(index)) out.push(entry.line);
	});
	if (insertAt === kept.length) out.push(trimMarkerLine(markerCount));
	return { lines: out, dropped: dropIndexes.size };
}

/** Sections 1 and 3: every previous line must be present; restore the missing ones, drop pointers. */
function repairVerbatimSection(previous: Section | undefined, current: Section): SectionRepair {
	const required = realBody(previous);
	const present = new Set(current.body.filter((line) => !isBlank(line)).map(lineKey));
	const missing = required.filter((line) => !isBlank(line) && !present.has(lineKey(line)));
	const pointerCount = current.body.filter(isPointerLine).length;
	if (missing.length === 0) {
		if (pointerCount === 0) return { body: current.body, restored: 0, pointers: 0, trimmed: 0 };
		return {
			body: current.body.filter((line) => !isPointerLine(line)),
			restored: 0,
			pointers: pointerCount,
			trimmed: 0,
		};
	}
	const requiredKeys = new Set(required.filter((line) => !isBlank(line)).map(lineKey));
	const extras = current.body.filter(
		(line) => !isBlank(line) && !isPointerLine(line) && !requiredKeys.has(lineKey(line)),
	);
	return {
		body: withTrailingBlank([...required, ...extras], current.body),
		restored: missing.length,
		pointers: pointerCount,
		trimmed: 0,
	};
}

/** Section 2: a pointer or empty section gets the previous text back, keeping genuinely new lines. */
function repairGoalSection(previous: Section | undefined, current: Section): SectionRepair {
	const pointerCount = current.body.filter(isPointerLine).length;
	const empty = !current.body.some((line) => !isBlank(line));
	if (pointerCount === 0 && !empty) return { body: current.body, restored: 0, pointers: 0, trimmed: 0 };
	const required = realBody(previous);
	if (!hasRealContent(required)) {
		return {
			body: current.body.filter((line) => !isPointerLine(line)),
			restored: 0,
			pointers: pointerCount,
			trimmed: 0,
		};
	}
	const requiredKeys = new Set(required.filter((line) => !isBlank(line)).map(lineKey));
	const extras = current.body.filter(
		(line) => !isBlank(line) && !isPointerLine(line) && !requiredKeys.has(lineKey(line)),
	);
	return {
		body: withTrailingBlank([...required, ...extras], current.body),
		restored: required.filter((line) => !isBlank(line)).length,
		pointers: pointerCount,
		trimmed: 0,
	};
}

/**
 * Sections 4 and 6: swap each pointer line for the previous section's lines not already present.
 * With `charCap`, the refilled section is then trimmed oldest-restored-line first (the model's own
 * lines are never dropped).
 */
function repairPointerSection(previous: Section | undefined, current: Section, charCap?: number): SectionRepair {
	if (!current.body.some(isPointerLine)) return { body: current.body, restored: 0, pointers: 0, trimmed: 0 };
	const seen = new Set(current.body.filter((line) => !isBlank(line) && !isPointerLine(line)).map(lineKey));
	const candidates = realBody(previous).filter((line) => !isBlank(line) && trimMarkerCount(line) === undefined);
	const body: string[] = [];
	const restoredFlags: boolean[] = [];
	let restored = 0;
	let pointers = 0;
	for (const line of current.body) {
		if (!isPointerLine(line)) {
			body.push(line);
			restoredFlags.push(false);
			continue;
		}
		pointers++;
		for (const candidate of candidates) {
			if (seen.has(lineKey(candidate))) continue;
			seen.add(lineKey(candidate));
			body.push(candidate);
			restoredFlags.push(true);
			restored++;
		}
	}
	if (charCap === undefined) return { body, restored, pointers, trimmed: 0 };
	const trimmed = trimOldest(body, restoredFlags, charCap, priorTrimmed(previous));
	return { body: trimmed.lines, restored: restored - trimmed.dropped, pointers, trimmed: trimmed.dropped };
}

/** Trim section 4 oldest-first when the whole summary exceeds TOTAL_CHAR_GUARD; sections 1-3, 5, 7 stay. */
function enforceTotalGuard(parsed: ParsedSummary): { trimmed: number; oversized: boolean } {
	const total = render(parsed).length;
	if (total <= TOTAL_CHAR_GUARD) return { trimmed: 0, oversized: false };
	const section = findSection(parsed, 4);
	if (!section) return { trimmed: 0, oversized: true };
	const bodyChars = sectionChars(section.body);
	if (total - (section.heading.length + 1 + bodyChars) > TOTAL_CHAR_GUARD) return { trimmed: 0, oversized: true };
	const limit = Math.max(SECTION_4_FLOOR_CHARS, bodyChars - (total - TOTAL_CHAR_GUARD));
	const result = trimOldest(
		section.body,
		section.body.map(() => true),
		limit,
		0,
	);
	section.body = result.lines;
	return { trimmed: result.dropped, oversized: render(parsed).length > TOTAL_CHAR_GUARD };
}

function unchanged(
	summary: string,
	status: "unchanged" | "skipped",
	options: { skipReason?: SummaryRepairReport["skipReason"]; oversized?: boolean } = {},
): SummaryRepairResult {
	return {
		summary,
		report: {
			status,
			...(options.skipReason ? { skipReason: options.skipReason } : {}),
			restored: emptyRestored(),
			pointersRemoved: 0,
			trimmedLines: 0,
			totalChars: summary.length,
			oversized: options.oversized ?? false,
		},
	};
}

/**
 * Repair a freshly generated update summary against the previous summary it was asked to extend.
 * Returns the summary to store and a report; on any parse failure the generated summary is returned
 * unchanged with `status: "skipped"` so the caller can log a warning.
 */
export function repairUpdateSummary(previousSummary: string, generatedSummary: string): SummaryRepairResult {
	try {
		const previous = parse(previousSummary);
		if (!previous) return unchanged(generatedSummary, "skipped", { skipReason: "previous-unparsed" });
		const generated = parse(generatedSummary);
		if (!generated) return unchanged(generatedSummary, "skipped", { skipReason: "new-unparsed" });

		const restored = emptyRestored();
		let pointersRemoved = 0;
		let trimmedLines = 0;

		for (const num of [1, 2, 3, 4, 6] as const) {
			const before = findSection(previous, num);
			const current = findSection(generated, num);
			if (!current) {
				// A dropped section 1-3 is restored whole; 4 and 6 have no pointer to resolve.
				const body = realBody(before);
				if (num <= 3 && before && hasRealContent(body)) {
					const index = generated.sections.findIndex((section) => section.num > num);
					const entry = { num, heading: before.heading, body: withTrailingBlank(body, before.body) };
					generated.sections.splice(index === -1 ? generated.sections.length : index, 0, entry);
					restored[num] += body.filter((line) => !isBlank(line)).length;
				}
				continue;
			}
			let result: SectionRepair;
			if ((VERBATIM_SECTIONS as readonly number[]).includes(num)) result = repairVerbatimSection(before, current);
			else if ((POINTER_SECTIONS as readonly number[]).includes(num))
				result = repairPointerSection(before, current, num === 4 ? SECTION_4_CHAR_CAP : undefined);
			else result = repairGoalSection(before, current);
			current.body = result.body;
			restored[num] += result.restored;
			pointersRemoved += result.pointers;
			trimmedLines += result.trimmed;
		}

		const guard = enforceTotalGuard(generated);
		trimmedLines += guard.trimmed;

		const changed = pointersRemoved > 0 || trimmedLines > 0 || Object.values(restored).some((count) => count > 0);
		if (!changed) return unchanged(generatedSummary, "unchanged", { oversized: guard.oversized });
		const summary = render(generated);
		return {
			summary,
			report: {
				status: "repaired",
				restored,
				pointersRemoved,
				trimmedLines,
				totalChars: summary.length,
				oversized: guard.oversized,
			},
		};
	} catch {
		return unchanged(generatedSummary, "skipped", { skipReason: "repair-error" });
	}
}
