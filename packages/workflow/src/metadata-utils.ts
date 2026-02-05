import type { ITaskMetadata } from '.';
import { hasKey } from './utils';

function responseHasSubworkflowData(
	response: unknown,
): response is { executionId: string; workflowId: string } {
	return ['executionId', 'workflowId'].every(
		(x) => hasKey(response, x) && typeof response[x] === 'string',
	);
}

type ISubWorkflowMetadata = Required<Pick<ITaskMetadata, 'subExecution' | 'subExecutionsCount'>>;

function parseErrorResponseWorkflowMetadata(response: unknown): ISubWorkflowMetadata | undefined {
	if (!responseHasSubworkflowData(response)) return undefined;

	return {
		subExecution: {
			executionId: response.executionId,
			workflowId: response.workflowId,
		},
		subExecutionsCount: 1,
	};
}

export function parseErrorMetadata(error: unknown): ISubWorkflowMetadata | undefined {
	// Fast path: check if error is an object once
	if (error === null || typeof error !== 'object') return undefined;

	const errorObj = error as Record<string, unknown>;
	
	// Check errorResponse property first
	if ('errorResponse' in errorObj) {
		const response = errorObj.errorResponse;
		if (response !== null && typeof response === 'object') {
			const responseObj = response as Record<string, unknown>;
			if ('executionId' in responseObj && 'workflowId' in responseObj) {
				return {
					subExecution: {
						executionId: responseObj.executionId as string,
						workflowId: responseObj.workflowId as string,
					},
					subExecutionsCount: 1,
				};
			}
		}
	}

	// Fallback: check error object directly for subworkflow properties
	if ('executionId' in errorObj && 'workflowId' in errorObj) {
		return {
			subExecution: {
				executionId: errorObj.executionId as string,
				workflowId: errorObj.workflowId as string,
			},
			subExecutionsCount: 1,
		};
	}

	return undefined;
}
