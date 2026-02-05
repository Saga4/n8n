import { ApplicationError } from '@n8n/errors';
import { parse as esprimaParse, Syntax } from 'esprima-next';
import type { Node as SyntaxNode, ExpressionStatement } from 'esprima-next';
import FormData from 'form-data';
import { jsonrepair } from 'jsonrepair';
import merge from 'lodash/merge';
import path from 'path';

import { ALPHABET } from './constants';
import { ManualExecutionCancelledError } from './errors/execution-cancelled.error';
import type { BinaryFileType, IDisplayOptions, INodeProperties, JsonObject } from './interfaces';
import * as LoggerProxy from './logger-proxy';

const hasOwnProperty = Object.prototype.hasOwnProperty;

const ALPHABET_CHARS = ALPHABET.split('');

const ONE_UINT32 = new Uint32Array(1);

const MAX_CACHE_SIZE = 128;

const _parseJSCache: Map<string, object> = new Map();

const _repairCache: Map<string, string> = new Map();

const readStreamClasses = new Set(['ReadStream', 'Readable', 'ReadableStream']);

// NOTE: BigInt.prototype.toJSON is not available, which causes JSON.stringify to throw an error
// as well as the flatted stringify method. This is a workaround for that.
BigInt.prototype.toJSON = function () {
	return this.toString();
};

/**
 * Type guard for plain objects suitable for key-based traversal/serialization.
 *
 * Returns `true` for objects whose prototype is `Object.prototype` (object literals)
 * or `null` (`Object.create(null)`), and `false` for arrays and non-plain objects
 * such as `Date`, `Map`, `Set`, and class instances.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object') return false;
	if (Array.isArray(value)) return false;
	if (Object.prototype.toString.call(value) !== '[object Object]') return false;

	return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

export const isObjectEmpty = (obj: object | null | undefined): boolean => {
	if (obj === undefined || obj === null) return true;
	if (typeof obj === 'object') {
		if (Array.isArray(obj)) return obj.length === 0;
		if (obj instanceof Set || obj instanceof Map) return obj.size === 0;
		if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return obj.byteLength === 0;
		if (obj instanceof FormData) return obj.getLengthSync() === 0;
		if (Symbol.iterator in obj || readStreamClasses.has(obj.constructor.name)) return false;
		return Object.keys(obj).length === 0;
	}
	return true;
};

export type Primitives = string | number | boolean | bigint | symbol | null | undefined;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
export const deepCopy = <T extends ((object | Date) & { toJSON?: () => string }) | Primitives>(
	source: T,
	hash = new WeakMap(),
	path = '',
): T => {
	// Primitives & Null & Function
	if (typeof source !== 'object' || source === null || typeof source === 'function') {
		return source;
	}
	// Date and other objects with toJSON method
	// TODO: remove this when other code parts not expecting objects with `.toJSON` method called and add back checking for Date and cloning it properly
	if (typeof source.toJSON === 'function') {
		return source.toJSON() as T;
	}
	if (hash.has(source)) {
		return hash.get(source);
	}
	// Array
	if (Array.isArray(source)) {
		const clone = [];
		const len = source.length;
		for (let i = 0; i < len; i++) {
			clone[i] = deepCopy(source[i], hash);
		}
		return clone as T;
	}
	// Object
	const clone = Object.create(Object.getPrototypeOf(source));
	hash.set(source, clone);
	for (const i in source) {
		if (hasOwnProperty.call(source, i)) {
			clone[i] = deepCopy((source as any)[i], hash);
		}
	}
	return clone;
};
// eslint-enable

function syntaxNodeToValue(expression?: SyntaxNode | null): unknown {
	switch (expression?.type) {
		case Syntax.ObjectExpression:
			return Object.fromEntries(
				expression.properties
					.filter((prop) => prop.type === Syntax.Property)
					.map(({ key, value }) => [syntaxNodeToValue(key), syntaxNodeToValue(value)]),
			);
		case Syntax.Identifier:
			return expression.name;
		case Syntax.Literal:
			return expression.value;
		case Syntax.ArrayExpression:
			return expression.elements.map((exp) => syntaxNodeToValue(exp));
		case Syntax.UnaryExpression: {
			const value = syntaxNodeToValue(expression.argument);
			if (typeof value === 'number' && expression.operator === '-') {
				return -value;
			}
			return value;
		}
		default:
			return undefined;
	}
}

/**
 * Parse any JavaScript ObjectExpression, including:
 * - single quoted keys
 * - unquoted keys
 */
function parseJSObject(objectAsString: string): object {
	// use small cache to avoid re-parsing the same string
	const cached = _parseJSCache.get(objectAsString);
	if (cached !== undefined) {
		return cached;
	}

	// Esprima can be heavy; restrict output to essentials to reduce parsing cost.
	// Keep tolerant parsing to help with minor syntax differences.
	const code = `(${objectAsString})`;
	// Provide explicit parse options to avoid collecting unnecessary data (comments, tokens, ranges, loc).
	const program = esprimaParse(code, {
		range: false,
		loc: false,
		comment: false,
		tokens: false,
		tolerant: true,
		jsx: false,
	});

	// Avoid .find with closure allocation: use a for loop to locate ExpressionStatement > ObjectExpression
	let jsExpression: ExpressionStatement | undefined;
	for (let i = 0, len = program.body.length; i < len; i++) {
		const node = program.body[i] as SyntaxNode;
		if (node.type === Syntax.ExpressionStatement) {
			// Accessing node.expression without repeated property lookups
			const expr = (node as ExpressionStatement).expression as SyntaxNode;
			if (expr && expr.type === Syntax.ObjectExpression) {
				jsExpression = node as ExpressionStatement;
				break;
			}
		}
	}

	const result = syntaxNodeToValue(jsExpression?.expression) as object;
	_parseJSCache.set(objectAsString, result);
	if (_parseJSCache.size > MAX_CACHE_SIZE) {
		const firstKey = _parseJSCache.keys().next().value;
		_parseJSCache.delete(firstKey);
	}
	return result;
}

type MutuallyExclusive<T, U> =
	| (T & { [k in Exclude<keyof U, keyof T>]?: never })
	| (U & { [k in Exclude<keyof T, keyof U>]?: never });

type JSONParseOptions<T> = { acceptJSObject?: boolean; repairJSON?: boolean } & MutuallyExclusive<
	{ errorMessage?: string },
	{ fallbackValue?: T }
>;

/**
 * Parses a JSON string into an object with optional error handling and recovery mechanisms.
 *
 * @param {string} jsonString - The JSON string to parse.
 * @param {Object} [options] - Optional settings for parsing the JSON string. Either `fallbackValue` or `errorMessage` can be set, but not both.
 * @param {boolean} [options.acceptJSObject=false] - If true, attempts to recover from common JSON format errors by parsing the JSON string as a JavaScript Object.
 * @param {boolean} [options.repairJSON=false] - If true, attempts to repair common JSON format errors by repairing the JSON string.
 * @param {string} [options.errorMessage] - A custom error message to throw if the JSON string cannot be parsed.
 * @param {*} [options.fallbackValue] - A fallback value to return if the JSON string cannot be parsed.
 * @returns {Object} - The parsed object, or the fallback value if parsing fails and `fallbackValue` is set.
 */
export const jsonParse = <T>(jsonString: string, options?: JSONParseOptions<T>): T => {
	// Cache local reference to avoid repeated optional chaining cost
	const opts = options as JSONParseOptions<T> | undefined;

	try {
		return JSON.parse(jsonString) as T;
	} catch (error) {
		if (opts?.acceptJSObject) {
			try {
				// small cache to avoid reparsing the same JS object strings
				const cached = _parseJSCache.get(jsonString);
				if (cached !== undefined) {
					return cached as T;
				}
				const jsonStringCleaned = parseJSObject(jsonString);
				// maintain bounded cache
				_parseJSCache.set(jsonString, jsonStringCleaned as object);
				if (_parseJSCache.size > MAX_CACHE_SIZE) {
					// delete oldest
					const firstKey = _parseJSCache.keys().next().value;
					_parseJSCache.delete(firstKey);
				}
				return jsonStringCleaned as T;
			} catch (e) {
				// Ignore this error and return the original error or the fallback value
			}
		}
		if (opts?.repairJSON) {
			try {
				// small cache for jsonrepair results
				let jsonStringCleaned = _repairCache.get(jsonString);
				if (jsonStringCleaned === undefined) {
					jsonStringCleaned = jsonrepair(jsonString);
					_repairCache.set(jsonString, jsonStringCleaned);
					if (_repairCache.size > MAX_CACHE_SIZE) {
						const firstKey = _repairCache.keys().next().value;
						_repairCache.delete(firstKey);
					}
				}
				return JSON.parse(jsonStringCleaned) as T;
			} catch (e) {
				// Ignore this error and return the original error or the fallback value
			}
		}
		if (opts?.fallbackValue !== undefined) {
			if (opts.fallbackValue instanceof Function) {
				return opts.fallbackValue();
			}
			return opts.fallbackValue;
		} else if (opts?.errorMessage) {
			throw new ApplicationError(opts.errorMessage);
		}

		throw error;
	}
};

type JSONStringifyOptions = {
	replaceCircularRefs?: boolean;
};

/**
 * Decodes a Base64 string with proper UTF-8 character handling.
 *
 * @param str - The Base64 string to decode
 * @returns The decoded UTF-8 string
 */
export const base64DecodeUTF8 = (str: string): string => {
	try {
		// Use modern TextDecoder for proper UTF-8 handling
		const bytes = new Uint8Array(
			atob(str)
				.split('')
				.map((char) => char.charCodeAt(0)),
		);
		return new TextDecoder('utf-8').decode(bytes);
	} catch (error) {
		// Fallback method for older browsers
		console.warn('TextDecoder not available, using fallback method');
		return atob(str);
	}
};

export const replaceCircularReferences = <T>(value: T, knownObjects = new WeakSet()): T => {
	if (typeof value !== 'object' || value === null || value instanceof RegExp) return value;
	if ('toJSON' in value && typeof value.toJSON === 'function') return value.toJSON() as T;
	if (knownObjects.has(value)) return '[Circular Reference]' as T;
	knownObjects.add(value);
	const copy = (Array.isArray(value) ? [] : {}) as T;
	for (const key in value) {
		try {
			copy[key] = replaceCircularReferences(value[key], knownObjects);
		} catch (error: unknown) {
			if (
				error instanceof TypeError &&
				error.message.includes('Cannot assign to read only property')
			) {
				LoggerProxy.error('Error while replacing circular references: ' + error.message, { error });
				continue; // Skip properties that cannot be assigned to (readonly, non-configurable, etc.)
			}
			throw error;
		}
	}
	knownObjects.delete(value);
	return copy;
};

export const jsonStringify = (obj: unknown, options: JSONStringifyOptions = {}): string => {
	return JSON.stringify(options?.replaceCircularRefs ? replaceCircularReferences(obj) : obj);
};

export const sleep = async (ms: number): Promise<void> =>
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

export const sleepWithAbort = async (ms: number, abortSignal?: AbortSignal): Promise<void> =>
	await new Promise((resolve, reject) => {
		if (abortSignal?.aborted) {
			reject(new ManualExecutionCancelledError(''));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		const abortHandler = () => {
			clearTimeout(timeout);
			reject(new ManualExecutionCancelledError(''));
		};

		abortSignal?.addEventListener('abort', abortHandler, { once: true });
	});

export function fileTypeFromMimeType(mimeType: string): BinaryFileType | undefined {
	if (mimeType.startsWith('application/json')) return 'json';
	if (mimeType.startsWith('text/html')) return 'html';
	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType.startsWith('video/')) return 'video';
	if (mimeType.startsWith('text/') || mimeType.startsWith('application/javascript')) return 'text';
	if (mimeType.startsWith('application/pdf')) return 'pdf';
	return;
}

export function assert<T>(condition: T, msg?: string): asserts condition {
	if (!condition) {
		const error = new Error(msg ?? 'Invalid assertion');
		// hide assert stack frame if supported
		if (Error.hasOwnProperty('captureStackTrace')) {
			// V8 only - https://nodejs.org/api/errors.html#errors_error_capturestacktrace_targetobject_constructoropt
			Error.captureStackTrace(error, assert);
		} else if (error.stack) {
			// fallback for IE and Firefox
			error.stack = error.stack
				.split('\n')
				.slice(1) // skip assert function from stack frames
				.join('\n');
		}
		throw error;
	}
}

export const isTraversableObject = (value: any): value is JsonObject => {
	return value && typeof value === 'object' && !Array.isArray(value) && !!Object.keys(value).length;
};

export const removeCircularRefs = (obj: JsonObject, seen = new Set()) => {
	seen.add(obj);
	Object.entries(obj).forEach(([key, value]) => {
		if (isTraversableObject(value)) {
			// eslint-disable-next-line @typescript-eslint/no-unused-expressions
			seen.has(value) ? (obj[key] = { circularReference: true }) : removeCircularRefs(value, seen);
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((val, index) => {
				if (seen.has(val)) {
					value[index] = { circularReference: true };
					return;
				}
				if (isTraversableObject(val)) {
					removeCircularRefs(val, seen);
				}
			});
		}
	});
};

export function updateDisplayOptions(
	displayOptions: IDisplayOptions,
	properties: INodeProperties[],
) {
	return properties.map((nodeProperty) => {
		return {
			...nodeProperty,
			displayOptions: merge({}, nodeProperty.displayOptions, displayOptions),
		};
	});
}

export function randomInt(max: number): number;
export function randomInt(min: number, max: number): number;
/**
 * Generates a random integer within a specified range.
 *
 * @param {number} min - The lower bound of the range. If `max` is not provided, this value is used as the upper bound and the lower bound is set to 0.
 * @param {number} [max] - The upper bound of the range, not inclusive.
 * @returns {number} A random integer within the specified range.
 */
export function randomInt(min: number, max?: number): number {
	if (max === undefined) {
		max = min;
		min = 0;
	}
	const range = max - min;
	crypto.getRandomValues(ONE_UINT32);
	return min + (ONE_UINT32[0] % range);
}

export function randomString(length: number): string;
export function randomString(minLength: number, maxLength: number): string;
/**
 * Generates a random alphanumeric string of a specified length, or within a range of lengths.
 *
 * @param {number} minLength - If `maxLength` is not provided, this is the length of the string to generate. Otherwise, this is the lower bound of the range of possible lengths.
 * @param {number} [maxLength] - The upper bound of the range of possible lengths. If provided, the actual length of the string will be a random number between `minLength` and `maxLength`, inclusive.
 * @returns {string} A random alphanumeric string of the specified length or within the specified range of lengths.
 */
export function randomString(minLength: number, maxLength?: number): string {
	const length = maxLength === undefined ? minLength : randomInt(minLength, maxLength + 1);

	// Choose the smallest typed array that can hold indices to reduce memory and improve locality.
	const alphaLen = ALPHABET_CHARS.length;
	let values: Uint8Array | Uint16Array | Uint32Array;
	if (alphaLen <= 0xff) {
		values = crypto.getRandomValues(new Uint8Array(length));
	} else if (alphaLen <= 0xffff) {
		values = crypto.getRandomValues(new Uint16Array(length));
	} else {
		values = crypto.getRandomValues(new Uint32Array(length));
	}

	const alpha = ALPHABET_CHARS;
	const out: string[] = new Array(length);

	// Cache locals to minimize property lookups in hot loop.
	for (let i = 0; i < length; i++) {
		out[i] = alpha[(values as Uint8Array | Uint16Array | Uint32Array)[i] % alphaLen];
	}
	return out.join('');
}

/**
 * Checks if a value is an object with a specific key and provides a type guard for the key.
 */
export function hasKey<T extends PropertyKey>(value: unknown, key: T): value is Record<T, unknown> {
	return value !== null && typeof value === 'object' && key in value;
}

const unsafeObjectProperties = new Set([
	'__proto__',
	'prototype',
	'constructor',
	'getPrototypeOf',
	'mainModule',
	'binding',
	'_load',
	'prepareStackTrace',
]);

/**
 * Checks if a property key is safe to use on an object, preventing prototype pollution.
 * setting untrusted properties can alter the object's prototype chain and introduce vulnerabilities.
 *
 * @see setSafeObjectProperty
 */
export function isSafeObjectProperty(property: string) {
	return !unsafeObjectProperties.has(property);
}

/**
 * Safely sets a property on an object, preventing prototype pollution.
 *
 * @see isSafeObjectProperty
 */
export function setSafeObjectProperty(
	target: Record<string, unknown>,
	property: string,
	value: unknown,
) {
	if (isSafeObjectProperty(property)) {
		target[property] = value;
	}
}

export function isDomainAllowed(
	urlString: string,
	options: {
		allowedDomains: string;
	},
): boolean {
	if (!options.allowedDomains || options.allowedDomains.trim() === '') {
		return true; // If no restrictions are set, allow all domains
	}

	try {
		const url = new URL(urlString);

		// Normalize hostname: lowercase and remove trailing dot
		const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

		// Reject empty hostnames
		if (!hostname) {
			return false;
		}

		const allowedDomainsList = options.allowedDomains
			.split(',')
			.map((domain) => domain.trim().toLowerCase().replace(/\.$/, ''))
			.filter(Boolean);

		for (const allowedDomain of allowedDomainsList) {
			// Handle wildcard domains (*.example.com)
			if (allowedDomain.startsWith('*.')) {
				const domainSuffix = allowedDomain.substring(2);
				// Ensure the suffix itself is valid
				if (!domainSuffix) continue;

				// Wildcard matches only subdomains, not the base domain itself
				// *.example.com matches sub.example.com but NOT example.com
				if (hostname.endsWith('.' + domainSuffix)) {
					return true;
				}
			}
			// Exact match
			else if (hostname === allowedDomain) {
				return true;
			}
		}

		return false;
	} catch (error) {
		// If URL parsing fails, deny access to be safe
		return false;
	}
}

const COMMUNITY_PACKAGE_NAME_REGEX = /^(?!@n8n\/)(@[\w.-]+\/)?n8n-nodes-(?!base\b)\b\w+/g;

export function isCommunityPackageName(packageName: string): boolean {
	COMMUNITY_PACKAGE_NAME_REGEX.lastIndex = 0;
	// Community packages names start with <@username/>n8n-nodes- not followed by word 'base'
	const nameMatch = COMMUNITY_PACKAGE_NAME_REGEX.exec(packageName);

	return !!nameMatch;
}

export function dedupe<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

/**
 * Extracts a safe filename from a path or filename string.
 *
 * Handles both Unix and Windows path separators, removing directory
 * components and null bytes to return just the filename.
 *
 * @param fileName - The filename or path to sanitize
 * @returns The extracted filename without path components
 *
 * @example
 * sanitizeFilename('path/to/file.txt') // returns 'file.txt'
 * sanitizeFilename('/tmp/upload/doc.pdf') // returns 'doc.pdf'
 * sanitizeFilename('C:\\Users\\file.txt') // returns 'file.txt'
 * sanitizeFilename('../../../etc/passwd') // returns 'passwd'
 */
export function sanitizeFilename(fileName: string): string {
	// Normalize to forward slashes first to handle Windows paths on Unix
	const normalized = fileName.replace(/\\/g, '/');

	// Extract just the filename, stripping all directory components
	let sanitized = path.basename(normalized);

	// Remove null bytes which could be used for null byte injection attacks
	sanitized = sanitized.replace(/\0/g, '');

	// If the result is empty or just dots, use a default name
	if (!sanitized || /^\.+$/.test(sanitized)) {
		sanitized = 'untitled';
	}

	return sanitized;
}
