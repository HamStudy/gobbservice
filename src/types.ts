import { RequestOptions } from "nats";
import stream from "stream";

export function isPromise(object: any): object is Promise<any> {
    return !!object && typeof object === 'object' && typeof object.then === "function";
}

export interface ResponseWithError {
    type: 'error';
    message: string;
    stack?: string;
};
export function isRemoteError(obj: any): obj is ResponseWithError {
    return obj?.type == 'error' && 'message' in obj;
}
export function makeError(obj: ResponseWithError) {
    const err = new Error(obj.message);
    if (obj.stack) {
        err.stack = obj.stack;
    }
    return err;
}

export interface MethodOpts extends Partial<RequestOptions> {
    validator?: (args: any[]) => undefined | string[];
    /** Default is "promise" */
    type?: 'stream' | 'promise';
}
export interface ObjWithMethodOpts {
    _$_methodOpts?: Record<string, MethodOpts>;
}
export type AsyncMethod = (...args: any[]) => Promise<any>;
export type StreamMethod = (...args: any[]) => NodeJS.ReadableStream | Promise<NodeJS.ReadableStream>;
export type ObjWithRequestMethods<K extends string | number | symbol = string> = Record<K, AsyncMethod> & ObjWithMethodOpts;
export type ObjWithStreamMethods<K extends string | number | symbol = string> = Record<K, StreamMethod> & ObjWithMethodOpts;

export type ObjWithMethods<K extends string | number | symbol = string> = Record<K, AsyncMethod | StreamMethod> & ObjWithMethodOpts;

export type stringKeysOf<T> = keyof T extends string ? keyof T : never;

/**
 * Get the names of all methods on an object which has been decorated with
 * @remoteMethod() or @remoteStream() decorators.
 */
export function getLibMethods<T extends ObjWithMethodOpts>(obj: T): Array<keyof T> {
    return Object.keys(obj._$_methodOpts) as Array<keyof T>;
}

// function decorator to set method opts on the object
export function remoteMethod(opts: MethodOpts = {}) {
    return function<CT extends Record<any, any>, K extends string = stringKeysOf<CT>, T extends ObjWithRequestMethods<K> = ObjWithRequestMethods<K>>(target: T, propertyKey: K, descriptor: PropertyDescriptor) {
        if (!target._$_methodOpts) {
            target._$_methodOpts = {};
        }
        target._$_methodOpts[propertyKey] = opts;
    };
}
// function decorator to set method opts on the object
export function remoteStream(opts: MethodOpts = {}) {
    return function<K extends string, T extends ObjWithStreamMethods<K>>(target: T, propertyKey: K, descriptor: PropertyDescriptor) {
        if (!target._$_methodOpts) {
            target._$_methodOpts = {
            };
        }
        target._$_methodOpts[propertyKey] = {
            type: 'stream',
            ...opts,
        };
    };
}

export class SimpleReadable extends stream.Readable {
    _read() {
    }
}
