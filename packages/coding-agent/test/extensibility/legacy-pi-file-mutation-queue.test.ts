import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

describe("legacy shim withFileMutationQueue export", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-file-mutation-queue-"));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("serializes concurrent operations targeting the same file", async () => {
		const targetFile = path.join(tmpDir, "same.txt");
		const events: string[] = [];

		const op1 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op1");
			await Bun.sleep(40);
			events.push("end:op1");
			return 1;
		});

		const op2 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op2");
			await Bun.sleep(10);
			events.push("end:op2");
			return 2;
		});

		const results = await Promise.all([op1, op2]);
		expect(results).toEqual([1, 2]);
		expect(events).toEqual(["start:op1", "end:op1", "start:op2", "end:op2"]);
	});

	it("runs operations on different files concurrently", async () => {
		const fileA = path.join(tmpDir, "file-a.txt");
		const fileB = path.join(tmpDir, "file-b.txt");
		const events: string[] = [];

		const opA = withFileMutationQueue(fileA, async () => {
			events.push("start:opA");
			await Bun.sleep(50);
			events.push("end:opA");
			return "A";
		});

		const opB = withFileMutationQueue(fileB, async () => {
			events.push("start:opB");
			await Bun.sleep(10);
			events.push("end:opB");
			return "B";
		});

		const results = await Promise.all([opA, opB]);
		expect(results).toEqual(["A", "B"]);
		expect(events[0]).toBe("start:opA");
		expect(events[1]).toBe("start:opB");
		expect(events[2]).toBe("end:opB");
		expect(events[3]).toBe("end:opA");
	});

	it("does not deadlock subsequent operations when an earlier operation throws", async () => {
		const targetFile = path.join(tmpDir, "throw.txt");
		const events: string[] = [];

		const op1 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op1");
			await Bun.sleep(20);
			events.push("throw:op1");
			throw new Error("mutation error in op1");
		});

		const op2 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op2");
			await Bun.sleep(10);
			events.push("end:op2");
			return "recovered";
		});

		await expect(op1).rejects.toThrow("mutation error in op1");
		const result2 = await op2;
		expect(result2).toBe("recovered");
		expect(events).toEqual(["start:op1", "throw:op1", "start:op2", "end:op2"]);
	});

	it("serializes existing and uncreated files reached through directory symlinks", async () => {
		const realDir = path.join(tmpDir, "real");
		const linkDir = path.join(tmpDir, "link");
		await fs.mkdir(realDir, { recursive: true });

		let symlinkSupported = true;
		try {
			await fs.symlink(realDir, linkDir, "dir");
		} catch {
			symlinkSupported = false;
		}

		if (!symlinkSupported) return;

		// 1. Existing file reached via real path vs symlink path
		const realExisting = path.join(realDir, "existing.txt");
		const linkExisting = path.join(linkDir, "existing.txt");
		await fs.writeFile(realExisting, "hello", "utf-8");

		const eventsExisting: string[] = [];
		const op1 = withFileMutationQueue(realExisting, async () => {
			eventsExisting.push("start:op1");
			await Bun.sleep(30);
			eventsExisting.push("end:op1");
		});
		const op2 = withFileMutationQueue(linkExisting, async () => {
			eventsExisting.push("start:op2");
			await Bun.sleep(10);
			eventsExisting.push("end:op2");
		});
		await Promise.all([op1, op2]);
		expect(eventsExisting).toEqual(["start:op1", "end:op1", "start:op2", "end:op2"]);

		// 2. Uncreated file created through symlink path
		const linkNew = path.join(linkDir, "new-file.txt");
		const eventsNew: string[] = [];
		const opA = withFileMutationQueue(linkNew, async () => {
			eventsNew.push("start:opA");
			await Bun.sleep(30);
			await fs.writeFile(linkNew, "created", "utf-8");
			eventsNew.push("end:opA");
		});

		// Queue opB slightly after opA begins, targeting the same link path
		await Bun.sleep(5);
		const opB = withFileMutationQueue(linkNew, async () => {
			eventsNew.push("start:opB");
			await Bun.sleep(10);
			eventsNew.push("end:opB");
		});

		await Promise.all([opA, opB]);
		expect(eventsNew).toEqual(["start:opA", "end:opA", "start:opB", "end:opB"]);
	});
});
