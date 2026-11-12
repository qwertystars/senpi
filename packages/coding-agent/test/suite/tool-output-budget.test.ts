import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../../src/core/tools/read.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatTruncationNotice,
	resolveOutputMaxBytes,
	TOOL_OUTPUT_MAX_BYTES_ENV,
	truncateTail,
} from "../../src/core/tools/truncate.ts";

const readTool = createReadTool(process.cwd());

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe("model-facing tool output budget", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tool-output-budget-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env[TOOL_OUTPUT_MAX_BYTES_ENV];
	});

	it("keeps a small read byte-identical with no truncation footer", async () => {
		const content = "Hello, world!\nLine 2\nLine 3";
		const file = join(dir, "small.txt");
		writeFileSync(file, content);

		const result = await readTool.execute("call-small", { path: file });

		expect(textOutput(result)).toBe(content);
		expect(textOutput(result)).not.toContain("truncated");
		expect(textOutput(result)).not.toContain("offset=");
		expect(result.details).toBeUndefined();
	});

	it("caps 3,000 lines at the line limit and names offset 2001", async () => {
		const file = join(dir, "many-lines.txt");
		writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));

		const result = await readTool.execute("call-lines", { path: file });
		const text = textOutput(result);

		expect(result.details?.truncation?.truncatedBy).toBe("lines");
		expect(result.details?.truncation?.outputLines).toBe(DEFAULT_MAX_LINES);
		expect(text).toContain("line 1\n");
		expect(text).toContain("line 2000");
		expect(text).not.toContain("line 2001\n");
		expect(text).toContain(
			`[truncated - refetch with offset=2001 to continue; showing lines 1-2000 of 3000 (${DEFAULT_MAX_BYTES / 1024}.0KB limit)]`,
		);
	});

	it("caps a 45KB read that the old 50KB ceiling returned whole", async () => {
		const line = "x".repeat(52);
		const file = join(dir, "wide.txt");
		writeFileSync(file, Array.from({ length: 900 }, () => line).join("\n"));

		const result = await readTool.execute("call-wide", { path: file });
		const text = textOutput(result);
		const truncation = result.details?.truncation;

		expect(truncation?.truncated).toBe(true);
		expect(truncation?.truncatedBy).toBe("bytes");
		expect(truncation?.outputLines).toBeGreaterThan(0);
		expect(text).toContain(
			`[truncated - refetch with offset=${(truncation?.outputLines ?? 0) + 1} to continue; showing lines 1-${truncation?.outputLines} of 900`,
		);
	});

	it("keeps the bash fallback for a single line over the ceiling", async () => {
		const file = join(dir, "one-line.txt");
		writeFileSync(file, "y".repeat(50 * 1024));

		const result = await readTool.execute("call-one-line", { path: file });
		const text = textOutput(result);

		expect(text).toContain("exceeds 40.0KB limit");
		expect(text).toContain(`head -c ${DEFAULT_MAX_BYTES}`);
		expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
	});

	it("honours the SENPI_TOOL_OUTPUT_MAX_BYTES override and ignores a bogus value", async () => {
		const file = join(dir, "override.txt");
		writeFileSync(file, Array.from({ length: 100 }, () => "z".repeat(29)).join("\n"));

		process.env[TOOL_OUTPUT_MAX_BYTES_ENV] = "2048";
		const result = await readTool.execute("call-override", { path: file });
		const truncation = result.details?.truncation;

		expect(truncation?.maxBytes).toBe(2048);
		expect(truncation?.truncated).toBe(true);
		expect(textOutput(result)).toContain(
			`[truncated - refetch with offset=${(truncation?.outputLines ?? 0) + 1} to continue; showing lines 1-${truncation?.outputLines} of 100 (2.0KB limit)]`,
		);

		process.env[TOOL_OUTPUT_MAX_BYTES_ENV] = "bogus";
		expect(resolveOutputMaxBytes()).toBe(DEFAULT_MAX_BYTES);
	});

	it("caps a tail-truncated bash-style output and names the spill file", () => {
		const content = Array.from({ length: 5000 }, (_, i) => `row ${i + 1}`).join("\n");
		const truncation = truncateTail(content);

		expect(truncation.outputLines).toBe(DEFAULT_MAX_LINES);
		expect(truncation.content).toContain("row 5000");
		expect(truncation.content).not.toContain("row 3000\n");
		expect(
			formatTruncationNotice({
				kind: "tail",
				startLine: truncation.totalLines - truncation.outputLines + 1,
				endLine: truncation.totalLines,
				totalLines: truncation.totalLines,
				fullOutputPath: "/spill/out.txt",
				maxBytes: truncation.maxBytes,
			}),
		).toBe("[truncated - showing last 3001-5000 of 5000 lines; Full output: /spill/out.txt]");
	});

	it("still returns a small image as an attachment with no truncation footer", async () => {
		const png1x1 = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
			"base64",
		);
		const file = join(dir, "tiny.png");
		writeFileSync(file, png1x1);

		const result = await readTool.execute("call-image", { path: file });
		const text = textOutput(result);

		expect(text).toContain("Read image file [image/png]");
		expect(text).not.toContain("truncated");
		expect(result.content.some((block) => block.type === "image")).toBe(true);
	});
});
