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
		const prevInputConnections = prevNodeConnections[inputName] ?? [];
		const nextInputConnections = nextNodeConnections[inputName] ?? [];

		const maxLength = prevInputConnections.length > nextInputConnections.length
			? prevInputConnections.length
			: nextInputConnections.length;

		for (let sourceIndex = 0; sourceIndex < maxLength; sourceIndex++) {
			const prevConnections = prevInputConnections[sourceIndex] ?? [];
			const nextConnections = nextInputConnections[sourceIndex] ?? [];

			const prevMap: Record<string, { index: number; connection: IConnection }> = Object.create(null);
			for (let p = 0, plen = prevConnections.length; p < plen; p++) {
				const conn = prevConnections[p];
				prevMap[JSON.stringify(conn)] = { index: p, connection: conn };
			}

			const nextMap: Record<string, { index: number; connection: IConnection }> = Object.create(null);
			for (let n = 0, nlen = nextConnections.length; n < nlen; n++) {
				const conn = nextConnections[n];
				nextMap[JSON.stringify(conn)] = { index: n, connection: conn };
			}

			// added: in nextMap but not in prevMap
			for (const key in nextMap) {
				if (!(key in prevMap)) {
					if (!added[nodeName]) added[nodeName] = {};
					if (!added[nodeName][inputName]) added[nodeName][inputName] = [];

					added[nodeName][inputName].push({
						sourceIndex,
						value: nextMap[key],
					});
				}
			}

			// removed: in prevMap but not in nextMap
			for (const key in prevMap) {
				if (!(key in nextMap)) {
					if (!removed[nodeName]) removed[nodeName] = {};
					if (!removed[nodeName][inputName]) removed[nodeName][inputName] = [];

					removed[nodeName][inputName].push({
						sourceIndex,
						value: prevMap[key],
					});
				}
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
