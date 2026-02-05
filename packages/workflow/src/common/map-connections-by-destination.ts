/* eslint-disable @typescript-eslint/no-for-in-array */

import type { IConnections, NodeConnectionType } from '../interfaces';

export function mapConnectionsByDestination(connections: IConnections) {
	const returnConnection: IConnections = {};

	let connectionInfo;
	let maxIndex: number;
	for (const sourceNode in connections) {
		if (!connections.hasOwnProperty(sourceNode)) {
			continue;
		}

		const srcConns = connections[sourceNode];
		for (const type in srcConns) {
			if (!srcConns.hasOwnProperty(type)) {
				continue;
			}

			const inputs = srcConns[type as NodeConnectionType];
			for (const inputIndex in inputs) {
				if (!inputs.hasOwnProperty(inputIndex)) {
					continue;
				}

				const conns = inputs[inputIndex] ?? [];
				// Use indexed loop for performance; preserve same thrown errors for undefined elements
				for (let i = 0, len = conns.length; i < len; i++) {
					connectionInfo = conns[i];

					if (!returnConnection.hasOwnProperty(connectionInfo.node)) {
						returnConnection[connectionInfo.node] = {};
					}
					if (!returnConnection[connectionInfo.node].hasOwnProperty(connectionInfo.type)) {
						returnConnection[connectionInfo.node][connectionInfo.type] = [];
					}

					const destArr = returnConnection[connectionInfo.node][connectionInfo.type];
					// Ensure the destination array has a slot at connectionInfo.index
					maxIndex = destArr.length - 1;
					// Fill missing indexes with empty arrays (matches original logic)
					for (let j = maxIndex; j < connectionInfo.index; j++) {
						destArr.push([]);
					}

					destArr[connectionInfo.index]?.push({
						node: sourceNode,
						type,
						index: parseInt(inputIndex, 10),
					});
				}
			}
		}
	}

	return returnConnection;
}
