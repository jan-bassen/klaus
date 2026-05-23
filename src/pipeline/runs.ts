const activeRuns = new Set<AbortController>();

export function registerActiveRun(controller: AbortController): () => void {
	activeRuns.add(controller);
	return () => {
		activeRuns.delete(controller);
	};
}

export function abortActiveRuns(): number {
	let aborted = 0;
	for (const controller of activeRuns) {
		if (controller.signal.aborted) continue;
		controller.abort();
		aborted += 1;
	}
	return aborted;
}
