
import { getLibMethods, isPromise, makeError, ObjWithMethodOpts, ObjWithMethods, ResponseWithError, SimpleReadable } from './types';

import bsonCodec from './bsonCodec';
import { MessagePort } from 'worker_threads';
import * as threads from 'worker_threads';

interface WorkerConsumer {
    get currentlyActive(): number;
}

interface WorkerOptions {
    stopIdleAfter?: number;
    timeout?: number;
}

class WorkerService<T extends {}> {
    private lib: ObjWithMethods;

    constructor(lib: T) {
        this.lib = lib as any as ObjWithMethods;
    }

    getValidatorForField(f: string) {
        return this.lib._$_methodOpts?.[f]?.validator || null;
    }
    getFieldType(f: string) {
        return this.lib._$_methodOpts?.[f]?.type || 'promise';
    }
    async callFunction(method: string, args: any[], port: MessagePort) {
        const validateErrors = this.getValidatorForField(method)?.(args);

        if (validateErrors) {
            const err: ResponseWithError = {
                type: 'error',
                message: `Validation error calling ${method}: ` + validateErrors.join(', '),
            };
            port.postMessage({type: 'error', error: err});
            return;
        }

        this.handleMethodCall(method, args, port);
    }
    async handleMethodCall(method: string, args: any[], port: MessagePort) {
        const type = this.getFieldType(method);
        try {
            if (typeof this.lib[method] !== "function") {
                throw new Error(`${method} is not a valid service method!`);
            }
            let results = this.lib[method](...args);
            if (isPromise(results)) {
                results = await results;
            }

            switch(type) {
                case 'promise':
                    const result = await results;

                    const bsonData = bsonCodec.encode(result);
                    port.postMessage({type: 'result', data: bsonData}, [bsonData.buffer]);
                    break;
                case 'stream':
                    const stream = results as NodeJS.ReadableStream;

                    for await (const chunk of stream) {
                        // if stream length is greater than max message size
                        // then split it up into multiple messages
                        port.postMessage({type: 'stream', chunk}, [(<Buffer>chunk).buffer]);
                    }

                    // when the stream ends:
                    port.postMessage({type: 'stream', chunk: null});
                    break;
                default:
                    throw new Error(`Unknown type ${type} for method ${method}`);
            }
        } catch (err) {
            const errObj: ResponseWithError = {
                type: 'error',
                message: err.message,
                stack: err.stack,
            };
            port.postMessage({type: 'error', error: errObj});
        }
    }

    static makeConsumer<T extends {}>(workerPath: string, lib: T & ObjWithMethodOpts, {timeout, stopIdleAfter}: WorkerOptions = {timeout: 25000, stopIdleAfter: 10000}): T & WorkerConsumer {
        let output: T = {} as T & WorkerConsumer;

        let curWorker: threads.Worker | null = null;

        const methodNames = getLibMethods(lib);

        let curActive = 0;

        /**
         * Starts the worker thread on demand
         * @returns a promise that resolves when the worker is ready
         */
        async function getWorker() {
            if (curWorker) return curWorker;

            curWorker = new threads.Worker(workerPath, {workerData: {}});
            curWorker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`Worker stopped with exit code ${code}`);
                }
                curWorker = null;
            });
            return new Promise<threads.Worker>((resolve, reject) => {
                curWorker.on('error', (err) => {
                    reject(err);
                });
                curWorker.on('message', msg => {
                    if (msg.type === 'ready' && msg.ready) {
                        resolve(curWorker);
                    }
                });
            });
        }

        /**
         * intended to run after a delay so that we don't keep idle threads running if there is no reason
         * to do so.
         */
        function closeIfIdle() {
            if (curActive === 0) {
                curWorker?.terminate();
                curWorker = null;
            }
        }

        for (let key of methodNames) {
            if (typeof lib[key as keyof T] == 'function') {
                const methodOpts = {
                    timeout,
                    ...lib._$_methodOpts?.[String(key)] || {}
                };
                if (methodOpts.type === 'stream') {
                    (<any>output)[key] = async (...args: any[]) => {
                        const worker = await getWorker();
                        curActive++;
                        const { port1, port2 } = new threads.MessageChannel();

                        let timeoutId: NodeJS.Timeout | null = null;

                        let resolved = false;
                        function markResolved() {
                            if (!resolved) {
                                curActive--;
                                resolved = true;
                            }
                            if (timeoutId) { clearTimeout(timeoutId); }

                            if (stopIdleAfter > 0) {
                                setTimeout(closeIfIdle, 5000);
                            }
                        }
                        function resetTimeout() {
                            if (timeoutId) { clearTimeout(timeoutId); }
                            timeoutId = setTimeout(() => {
                                outStream.destroy(makeError({type: 'error', message: `Timeout calling ${String(key)} after ${methodOpts.timeout}ms`}));
                                port1.close();
                                markResolved();
                            }, methodOpts.timeout || 25000);
                        }

                        const outStream = new SimpleReadable();
                        // Log out the basic Readable events

                        port1.on('message', (data: any) => {
                            // console.log("Message from worker: ", data);
                            if (data.type == 'stream') {
                                outStream.push(data.chunk);
                                if (data.chunk === null) {
                                    markResolved();
                                } else {
                                    resetTimeout();
                                }
                            } else if (data.type == 'error') {
                                markResolved();
                                outStream.destroy(makeError(data.error));
                            } else {
                                console.warn("Unexpected message:", data);
                            }
                        });
                        port1.on('messageerror', (err: any) => {
                            console.log("Message error from worker: ", err);
                            if (timeoutId) { clearTimeout(timeoutId); }
                            outStream.destroy(err);
                        });
                        port1.on('close', () => {
                            if (!resolved) {
                                outStream.destroy(new Error("Stream closed before end"));
                                console.log("Worker closed");
                            }
                        });

                        const bsonData = bsonCodec.encode(args);
                        // Post a message to the worker to tell it to do a method call
                        worker.postMessage({
                            method: String(key),
                            data: bsonData,
                            port: port2,
                        }, [bsonData.buffer, port2]);

                        outStream.on('end', () => {
                            markResolved();
                        });

                        return outStream;
                    };
                } else {
                    (<any>output)[key] = async (...args: any[]) => {
                        curActive++;
                        const p = new Promise(async (resolve, reject) => {
                            const worker = await getWorker();
                            const { port1, port2 } = new threads.MessageChannel();

                            let timeoutId: NodeJS.Timeout | null = null;

                            port1.on('message', (data: any) => {
                                if (data.type == 'result') {
                                    resolve(bsonCodec.decode(data.data));
                                } else if (data.type == 'error') {
                                    reject(makeError(data.error));
                                } else {
                                    console.warn("Unexpected message:", data);
                                }
                            });
                            port1.on('messageerror', (err: any) => {
                                reject(err);
                            });

                            const bsonData = bsonCodec.encode(args);
                            // Post a message to the worker to tell it to do a method call
                            worker.postMessage({
                                method: String(key),
                                data: bsonData,
                                port: port2,
                            }, [bsonData.buffer, port2]);

                            timeoutId = setTimeout(() => {
                                reject(makeError({type: 'error', message: `Timeout calling ${String(key)} after ${methodOpts.timeout}ms`}));
                                port1.close();
                            }, methodOpts.timeout || 25000);
                        });
                        p.finally(() => {
                            curActive--;
                        });
                        return p;
                    }
                };
            }
        }
        return {
            ...output,
            get currentlyActive() {
                return curActive;
            }
        };
    }

    static async createOnWorkerThread<T extends {}>(lib: T) {
        if (threads.isMainThread) {
            // This is only useful on a worker thread, so don't do it on the main thread!
            return null;
        }
        const service = new WorkerService(lib);

        threads.parentPort.on('message', (msg: any) => {
            if (msg.type === 'isReady') {
                threads.parentPort?.postMessage({type: 'ready', ready: true});
            } else if (msg.method) {
                const args = bsonCodec.decode(msg.data);
                service.callFunction(msg.method, args, msg.port);
            }
        });
        threads.parentPort.postMessage({type: 'ready', ready: true});

        threads.parentPort.on('close', () => {
            console.log(`worker ${threads.threadId} closed`);
        });

        // worker is ready
        console.log(`worker ${threads.threadId} started`);

        return service;
    }
}

export {WorkerService};
