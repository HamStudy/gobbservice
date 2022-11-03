
import { getLibMethods, isPromise, makeError, ObjWithMethodOpts, ObjWithMethods, SimpleReadable } from './types';

import bsonCodec from './bsonCodec';

/**
 * Unlike the NatsService and WorkerService this one is never actually instantiated,
 * because a local service is called directly via the consumer. This is used
 * to make an interface to wrap the service which still processes the arguments
 * and responses the same way so that it's less likely to break when you try
 * running it as a worker or as a NATS service.
 */
class LocalService<T extends {}> {
    // private lib: ObjWithMethods;

    constructor(lib: T) {
        throw new Error("This class is not meant to be instantiated");
    }

    static makeConsumer<T extends {}>(inLib: T & ObjWithMethodOpts, timeout = 25000) {
        let output: T = {} as T;

        const lib: ObjWithMethods = inLib as any;

        const methodNames = getLibMethods(lib);
        for (let key of (methodNames as Array<keyof typeof lib>)) {
            if (typeof lib[key] !== 'function') {
                throw new Error("Invalid method: " + key);
            }
            const methodOpts = {
                timeout,
                ...lib._$_methodOpts?.[String(key)] || {}
            };
            if (methodOpts.type === 'stream') {
                (<any>output)[key] = async (...args: any[]) => {
                    const outStream = new SimpleReadable();

                    let timeoutId: NodeJS.Timeout | null = null;
                    function resetTimeout() {
                        if (timeoutId) { clearTimeout(timeoutId); }
                        timeoutId = setTimeout(() => {
                            outStream.destroy(makeError({
                                type: 'error',
                                message: `Timeout calling ${String(key)} after ${methodOpts.timeout}ms`,
                            }));
                        }, methodOpts.timeout);
                    }
                    resetTimeout();
                    // This is inarguably wasteful, but it does ensure that things will behave the same
                    // whether you are using a local service or some type of remote service.
                    const processedArgs = bsonCodec.decode(bsonCodec.encode(args));
                    const streamOrPromise = await lib[key as keyof T](...processedArgs);
                    resetTimeout();

                    const resStream = isPromise(streamOrPromise) ? await streamOrPromise : streamOrPromise;

                    resStream.on('data', (chunk: any) => {
                        resetTimeout();
                        outStream.push(chunk);
                    });
                    resStream.on('end', () => {
                        outStream.push(null);
                        if (timeoutId) { clearTimeout(timeoutId); }
                        timeoutId = null;
                    });
                    resStream.on('error', (err: any) => {
                        if (timeoutId) { clearTimeout(timeoutId); }
                        timeoutId = null;

                        outStream.destroy(makeError({
                            type: 'error',
                            message: err?.message ?? 'Unknown error',
                            ...(err?.stack ? {stack: err.stack} : {}),
                        }));
                    });

                    return outStream;
                };
            } else {
                (<any>output)[key] = async (...args: any[]) => {
                    const processedArgs = bsonCodec.decode(bsonCodec.encode(args));
                    const result = await Promise.race([
                        lib[key as keyof T](...processedArgs),
                        new Promise((resolve, reject) => setTimeout(reject, methodOpts.timeout, new Error(`Timeout calling ${String(key)} after ${methodOpts.timeout}ms`))),
                    ]);
                    const processedResult = bsonCodec.decode(bsonCodec.encode(result));

                    return processedResult;
                }
            };
        }
        return output;
    }
}

export { LocalService };

