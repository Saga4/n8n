import type { IConnection, IConnections } from '.';

type ConnectionEntry = {
	sourceIndex: number;
	value: { index: number; connection: IConnection } | null;
};

export type INodeConnectionsDiff = Record<string, ConnectionEntry[]>;

export type ConnectionsDiff = {
	added: Record<string, INodeConnectionsDiff>;
	removed: Record<string, INodeConnectionsDiff>;
};

export function compareConnections(prev: IConnections, next: IConnections): ConnectionsDiff {
	const added: Record<string, INodeConnectionsDiff> = {};
	const removed: Record<string, INodeConnectionsDiff> = {};

	// Iterate prev node names first, then any node names that only exist in next.
	const prevNodeNames = Object.keys(prev);
	const nextNodeNames = Object.keys(next);

	const seenNodes: Record<string, true> = Object.create(null);
	for (let i = 0, len = prevNodeNames.length; i < len; i++) {
		seenNodes[prevNodeNames[i]] = true;
	}

	const EMPTY_ARR: any[] = [];

	// Helper to diff all inputs for a single node
	function processNode(nodeName: string, prevNodeConnections: Record<string, any>, nextNodeConnections: Record<string, any>) {
		const prevInputNames = Object.keys(prevNodeConnections);
		const nextInputNames = Object.keys(nextNodeConnections);

		const seenInputs: Record<string, true> = Object.create(null);
		for (let j = 0, jlen = prevInputNames.length; j < jlen; j++) {
			seenInputs[prevInputNames[j]] = true;
		}

		// Process inputs that exist in prev (and possibly in next)
		for (let j = 0, jlen = prevInputNames.length; j < jlen; j++) {
			processInput(nodeName, prevNodeConnections, nextNodeConnections, prevInputNames[j]);
		}

		// Process inputs that only exist in next
		for (let j = 0, jlen = nextInputNames.length; j < jlen; j++) {
			const inputName = nextInputNames[j];
			if (seenInputs[inputName]) continue;
			processInput(nodeName, prevNodeConnections, nextNodeConnections, inputName);
		}
	}

	// Helper to diff a single input (handles varying sourceIndex lengths)
	function processInput(nodeName: string, prevNodeConnections: Record<string, any>, nextNodeConnections: Record<string, any>, inputName: string) {
		const prevInputConnections = (prevNodeConnections[inputName] as any[]) ?? EMPTY_ARR;
		const nextInputConnections = (nextNodeConnections[inputName] as any[]) ?? EMPTY_ARR;

		const maxLength = prevInputConnections.length > nextInputConnections.length
			? prevInputConnections.length
			: nextInputConnections.length;

		for (let sourceIndex = 0; sourceIndex < maxLength; sourceIndex++) {
			const prevConnections = prevInputConnections[sourceIndex] ?? EMPTY_ARR;
			const nextConnections = nextInputConnections[sourceIndex] ?? EMPTY_ARR;

			// Build map for prevConnections once
			const prevMap = new Map<string, { index: number; connection: IConnection }>();
			for (let p = 0, plen = prevConnections.length; p < plen; p++) {
				const conn = prevConnections[p];
				prevMap.set(JSON.stringify(conn), { index: p, connection: conn });
			}

			// Check nextConnections against prevMap to find additions.
			for (let n = 0, nlen = nextConnections.length; n < nlen; n++) {
				const conn = nextConnections[n];
				const key = JSON.stringify(conn);
				const prevEntry = prevMap.get(key);
				if (prevEntry === undefined) {
					let addedNode = added[nodeName];
					if (!addedNode) {
						addedNode = {};
						added[nodeName] = addedNode;
					}
					let addedInput = addedNode[inputName];
					if (!addedInput) {
						addedInput = [];
						addedNode[inputName] = addedInput;
					}
					addedInput.push({
						sourceIndex,
						value: { index: n, connection: conn },
					});
				} else {
					// Matched, remove from prevMap so remaining entries are removals.
					prevMap.delete(key);
				}
			}

			// Remaining entries in prevMap are removed.
			if (prevMap.size) {
				let removedNode = removed[nodeName];
				if (!removedNode) {
					removedNode = {};
					removed[nodeName] = removedNode;
				}
				let removedInput = removedNode[inputName];
				if (!removedInput) {
					removedInput = [];
					removedNode[inputName] = removedInput;
				}

				prevMap.forEach((value) => {
					removedInput.push({
						sourceIndex,
						value,
					});
				});
			}
		}
	}

	// Process nodes present in prev (covers nodes present in both)
	for (let i = 0, len = prevNodeNames.length; i < len; i++) {
		const nodeName = prevNodeNames[i];
		const prevNodeConnections = prev[nodeName] ?? {};
		const nextNodeConnections = next[nodeName] ?? {};
		processNode(nodeName, prevNodeConnections, nextNodeConnections);
	}

	// Process nodes only present in next
	for (let i = 0, len = nextNodeNames.length; i < len; i++) {
		const nodeName = nextNodeNames[i];
		if (seenNodes[nodeName]) continue;
		const prevNodeConnections = prev[nodeName] ?? {};
		const nextNodeConnections = next[nodeName] ?? {};
		processNode(nodeName, prevNodeConnections, nextNodeConnections);
	}

	return { added, removed };
}
