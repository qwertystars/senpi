/**
 * Deterministic post-check for the *update* compaction variant.
 *
 * The update prompt tells the model to keep sections 1 (User Requests), 2 (Final Goal) and 3
 * (Constraints) of `<previous-summary>` byte-for-byte, but nothing enforced it: models often wrote a
 * pointer such as "(All entries from <previous-summary> are preserved unchanged ...)" instead, and the
 * stored pointer destroyed the real text for every later compaction. This module repairs the generated
 * summary against the previous one before it is stored. It is pure and never throws.
 *
 * Sections 5 and 7 (and anything not named below) are never touched.
 */

export interface SummaryRepairReport {
	status: "unchanged" | "repaired" | "skipped";
	skipReason?: "previous-unparsed" | "new-unparsed" | "repair-error";
	/** Lines re-inserted from the previous summary, per section number. */
	restored: Readonly<Record<RepairedSection, number>>;
	/** Pointer-only lines removed from the new summary (including ones swapped for real lines). */
	pointersRemoved: number;
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

const HEADING = /^##\s+(\d+)\.(?:\s|$)/;
const PREVIOUS_REFERENCE = /previous[ -]summary|prior summary|earlier summary/i;
const POINTER_WORDING =
	/preserv|unchanged|as recorded|\bas in\b|\bsee\b|carried (?:over|forward)|retained|kept (?:as|verbatim)|same as|remain(?:s)? (?:as|the same)|not repeated|omitted/i;
const VERBATIM_SECTIONS = [1, 3] as const;
const POINTER_SECTIONS = [4, 6] as const;

/** A line that refers to the previous summary instead of carrying content. */
export function isPointerLine(line: string): boolean {
	return PREVIOUS_REFERENCE.test(line) && POINTER_WORDING.test(line);
}

function isBlank(line: string): boolean {
	return line.trim() === "";
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

function emptyRestored(): Record<RepairedSection, number> {
	return { 1: 0, 2: 0, 3: 0, 4: 0, 6: 0 };
}

/** Sections 1 and 3: every previous line must be present; restore the missing ones, drop pointers. */
function repairVerbatimSection(
	previous: Section | undefined,
	current: Section,
): { body: string[]; restored: number; pointers: number } {
	const required = realBody(previous);
	const present = new Set(current.body.filter((line) => !isBlank(line)).map(lineKey));
	const missing = required.filter((line) => !isBlank(line) && !present.has(lineKey(line)));
	const pointerCount = current.body.filter(isPointerLine).length;
	if (missing.length === 0) {
		if (pointerCount === 0) return { body: current.body, restored: 0, pointers: 0 };
		return { body: current.body.filter((line) => !isPointerLine(line)), restored: 0, pointers: pointerCount };
	}
	const requiredKeys = new Set(required.filter((line) => !isBlank(line)).map(lineKey));
	const extras = current.body.filter(
		(line) => !isBlank(line) && !isPointerLine(line) && !requiredKeys.has(lineKey(line)),
	);
	return {
		body: withTrailingBlank([...required, ...extras], current.body),
		restored: missing.length,
		pointers: pointerCount,
	};
}

/** Section 2: a pointer or empty section gets the previous text back, keeping genuinely new lines. */
function repairGoalSection(
	previous: Section | undefined,
	current: Section,
): { body: string[]; restored: number; pointers: number } {
	const pointerCount = current.body.filter(isPointerLine).length;
	const empty = !current.body.some((line) => !isBlank(line));
	if (pointerCount === 0 && !empty) return { body: current.body, restored: 0, pointers: 0 };
	const required = realBody(previous);
	if (!hasRealContent(required)) {
		return { body: current.body.filter((line) => !isPointerLine(line)), restored: 0, pointers: pointerCount };
	}
	const requiredKeys = new Set(required.filter((line) => !isBlank(line)).map(lineKey));
	const extras = current.body.filter(
		(line) => !isBlank(line) && !isPointerLine(line) && !requiredKeys.has(lineKey(line)),
	);
	return {
		body: withTrailingBlank([...required, ...extras], current.body),
		restored: required.filter((line) => !isBlank(line)).length,
		pointers: pointerCount,
	};
}

/** Sections 4 and 6: swap each pointer line for the previous section's lines not already present. */
function repairPointerSection(
	previous: Section | undefined,
	current: Section,
): { body: string[]; restored: number; pointers: number } {
	if (!current.body.some(isPointerLine)) return { body: current.body, restored: 0, pointers: 0 };
	const seen = new Set(current.body.filter((line) => !isBlank(line) && !isPointerLine(line)).map(lineKey));
	const candidates = realBody(previous).filter((line) => !isBlank(line));
	const body: string[] = [];
	let restored = 0;
	let pointers = 0;
	for (const line of current.body) {
		if (!isPointerLine(line)) {
			body.push(line);
			continue;
		}
		pointers++;
		for (const candidate of candidates) {
			if (seen.has(lineKey(candidate))) continue;
			seen.add(lineKey(candidate));
			body.push(candidate);
			restored++;
		}
	}
	return { body, restored, pointers };
}

function withTrailingBlank(lines: string[], original: string[]): string[] {
	const endsBlank = original.length > 0 && isBlank(original[original.length - 1] as string);
	return endsBlank ? [...lines, ""] : lines;
}

function unchanged(
	summary: string,
	status: "unchanged" | "skipped",
	skipReason?: SummaryRepairReport["skipReason"],
): SummaryRepairResult {
	return {
		summary,
		report: {
			status,
			...(skipReason ? { skipReason } : {}),
			restored: emptyRestored(),
			pointersRemoved: 0,
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
		if (!previous) return unchanged(generatedSummary, "skipped", "previous-unparsed");
		const generated = parse(generatedSummary);
		if (!generated) return unchanged(generatedSummary, "skipped", "new-unparsed");

		const restored = emptyRestored();
		let pointersRemoved = 0;

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
			const result = (VERBATIM_SECTIONS as readonly number[]).includes(num)
				? repairVerbatimSection(before, current)
				: (POINTER_SECTIONS as readonly number[]).includes(num)
					? repairPointerSection(before, current)
					: repairGoalSection(before, current);
			current.body = result.body;
			restored[num] += result.restored;
			pointersRemoved += result.pointers;
		}

		const changed = pointersRemoved > 0 || Object.values(restored).some((count) => count > 0);
		if (!changed) return unchanged(generatedSummary, "unchanged");
		return { summary: render(generated), report: { status: "repaired", restored, pointersRemoved } };
	} catch {
		return unchanged(generatedSummary, "skipped", "repair-error");
	}
}
