import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as rootBarrel from "@oh-my-pi/pi-coding-agent";
import * as legacyShim from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import * as toolsBarrel from "@oh-my-pi/pi-coding-agent/tools";
import { withFileMutationQueue } from "@oh-my-pi/pi-coding-agent/tools/file-mutation-queue";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("file-mutation-queue", () => {
	it("re-exports withFileMutationQueue across root barrel, tools barrel, and legacy shim", () => {
		expect(typeof rootBarrel.withFileMutationQueue).toBe("function");
		expect(typeof toolsBarrel.withFileMutationQueue).toBe("function");
		expect(typeof legacyShim.withFileMutationQueue).toBe("function");
		expect(rootBarrel.withFileMutationQueue).toBe(withFileMutationQueue);
		expect(toolsBarrel.withFileMutationQueue).toBe(withFileMutationQueue);
		expect(legacyShim.withFileMutationQueue).toBe(withFileMutationQueue);
	});

	it("serializes concurrent operations targeting the same file", async () => {
		const targetFile = path.resolve("/tmp/test-file-same.txt");
		const events: string[] = [];

		const op1 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op1");
			await delay(40);
			events.push("end:op1");
			return 1;
		});

		const op2 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op2");
			await delay(10);
			events.push("end:op2");
			return 2;
		});

		const results = await Promise.all([op1, op2]);
		expect(results).toEqual([1, 2]);
		expect(events).toEqual(["start:op1", "end:op1", "start:op2", "end:op2"]);
	});

	it("runs operations on different files concurrently", async () => {
		const fileA = path.resolve("/tmp/test-file-a.txt");
		const fileB = path.resolve("/tmp/test-file-b.txt");
		const events: string[] = [];

		const opA = withFileMutationQueue(fileA, async () => {
			events.push("start:opA");
			await delay(50);
			events.push("end:opA");
			return "A";
		});

		const opB = withFileMutationQueue(fileB, async () => {
			events.push("start:opB");
			await delay(10);
			events.push("end:opB");
			return "B";
		});

		const results = await Promise.all([opA, opB]);
		expect(results).toEqual(["A", "B"]);
		// opB should complete while opA is still waiting
		expect(events[0]).toBe("start:opA");
		expect(events[1]).toBe("start:opB");
		expect(events[2]).toBe("end:opB");
		expect(events[3]).toBe("end:opA");
	});

	it("canonicalizes relative and absolute paths to the same queue", async () => {
		const relativePath = "test-rel-canonical.txt";
		const absolutePath = path.resolve(relativePath);
		const events: string[] = [];

		const op1 = withFileMutationQueue(relativePath, async () => {
			events.push("start:rel");
			await delay(30);
			events.push("end:rel");
		});

		const op2 = withFileMutationQueue(absolutePath, async () => {
			events.push("start:abs");
			await delay(10);
			events.push("end:abs");
		});

		await Promise.all([op1, op2]);
		expect(events).toEqual(["start:rel", "end:rel", "start:abs", "end:abs"]);
	});

	it("does not deadlock subsequent operations when an earlier operation throws", async () => {
		const targetFile = path.resolve("/tmp/test-file-throw.txt");
		const events: string[] = [];

		const op1 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op1");
			await delay(20);
			events.push("throw:op1");
			throw new Error("mutation error in op1");
		});

		const op2 = withFileMutationQueue(targetFile, async () => {
			events.push("start:op2");
			await delay(10);
			events.push("end:op2");
			return "recovered";
		});

		await expect(op1).rejects.toThrow("mutation error in op1");
		const result2 = await op2;
		expect(result2).toBe("recovered");
		expect(events).toEqual(["start:op1", "throw:op1", "start:op2", "end:op2"]);
	});
});
