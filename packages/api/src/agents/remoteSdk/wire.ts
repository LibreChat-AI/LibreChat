import { isPlainObject } from 'lodash';
import { Send } from '@langchain/langgraph';
import { BaseMessage, mapStoredMessagesToChatMessages } from '@librechat/agents/langchain/messages';
import type { StoredMessage } from '@librechat/agents/langchain/messages';

/** Only data crosses the runtime boundary; never serialize a host RunConfig or request. */
export function encodeSdkValue(value: unknown): unknown {
  if (value instanceof Send)
    return { $sdk: 'send', node: value.node, value: encodeSdkValue(value.args) };
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    return { $sdk: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  if (value instanceof BaseMessage)
    return { $sdk: 'message', value: encodeSdkValue(value.toDict()) };
  if (value instanceof Uint8Array)
    return { $sdk: 'bytes', value: Buffer.from(value).toString('base64') };
  if (value instanceof Date) return { $sdk: 'date', value: value.toISOString() };
  if (value instanceof Map) return { $sdk: 'map', value: [...value].map(encodeSdkValue) };
  if (value instanceof Set) return { $sdk: 'set', value: [...value].map(encodeSdkValue) };
  if (typeof value === 'bigint') return { $sdk: 'bigint', value: value.toString() };
  if (value === undefined) return { $sdk: 'undefined' };
  if (Array.isArray(value)) return value.map(encodeSdkValue);
  if (value != null && typeof value === 'object') {
    if (!isPlainObject(value)) throw new Error('SDK runtime class is not serializable');
    const entries = Object.entries(value).map(([key, item]) => [key, encodeSdkValue(item)]);
    return Object.prototype.hasOwnProperty.call(value, '$sdk')
      ? { $sdk: 'record', value: entries }
      : Object.fromEntries(entries);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('SDK runtime value is not serializable');
  }
  return value;
}

export function decodeSdkValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeSdkValue);
  if (value != null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.$sdk === 'send' && typeof record.node === 'string')
      return new Send(record.node, decodeSdkValue(record.value));
    if (
      record.$sdk === 'number' &&
      typeof record.value === 'string' &&
      ['NaN', 'Infinity', '-Infinity', '-0'].includes(record.value)
    )
      return Number(record.value);
    if (record.$sdk === 'message')
      return mapStoredMessagesToChatMessages([decodeSdkValue(record.value) as StoredMessage])[0];
    if (record.$sdk === 'bytes' && typeof record.value === 'string')
      return Uint8Array.from(Buffer.from(record.value, 'base64'));
    if (record.$sdk === 'date' && typeof record.value === 'string') return new Date(record.value);
    if (record.$sdk === 'map' && Array.isArray(record.value))
      return new Map(record.value.map(decodeSdkValue) as [unknown, unknown][]);
    if (record.$sdk === 'set' && Array.isArray(record.value))
      return new Set(record.value.map(decodeSdkValue));
    if (record.$sdk === 'bigint' && typeof record.value === 'string') return BigInt(record.value);
    if (record.$sdk === 'record' && Array.isArray(record.value))
      return Object.fromEntries(
        record.value.map(([key, item]: [string, unknown]) => [key, decodeSdkValue(item)]),
      );
    if (record.$sdk === 'undefined') return undefined;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decodeSdkValue(item)]),
    );
  }
  return value;
}
