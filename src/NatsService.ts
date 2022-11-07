
import { NatsConnection, PublishOptions, headers as makeHeaders, Subscription, Codec } from 'nats';
import { ObjWithMethods, ObjWithMethodOpts, ResponseWithError, getLibMethods } from './types';
import bsonCodec from './bsonCodec';
import { RequestResponseHelper } from './RequestResponseHelper';

// 768kb is the max message size,
// if the stream returns more than that
// we will split it into multiple messages
const DEFAULT_MAX_MSG_SIZE = 1024 * 768;
class NatsService<T extends {}> {
    private lib: ObjWithMethods;

    private sub: Subscription | null = null;

    constructor(protected conn: NatsConnection, protected subjectPrefix: string, lib: T) {
        this.lib = lib as any as ObjWithMethods;
    }

    get maxSize() {

        return ((this.conn?.info?.max_payload ?? 0) * 0.9) || DEFAULT_MAX_MSG_SIZE;
    }

    getValidatorForField(f: string) {
        return this.lib._$_methodOpts?.[f]?.validator || null;
    }
    getFieldType(f: string) {
        return this.lib._$_methodOpts?.[f]?.type || 'promise';
    }
    async start() {
        const sub = this.conn.subscribe(`${this.subjectPrefix}.*`, {
            queue: this.subjectPrefix.replace(/\./g, '_'),
        });
        this.sub = sub;
        for await (const msg of sub) {
            const method = msg.subject.split('.').pop();
            const args = bsonCodec.decode(msg.data);
            const replyTo = msg.headers?.get('rTo') || msg.reply;
            const validateErrors = this.getValidatorForField(method)?.(args);

            if (validateErrors) {
                const err: ResponseWithError = {
                    type: 'error',
                    message: `Validation error calling ${method}: ` + validateErrors.join(', '),
                };
                this.conn.publish(replyTo, bsonCodec.encode(err));
                continue;
            }

            this.handleMethodCall(method, args, replyTo);
        }
        return this;
    }
    isReady() {
        return this.sub && !this.sub.isClosed() && !this.sub.isDraining();
    }
    async stop() {
        const sub = this.sub;
        this.sub = null;
        await sub.drain();
    }

    async handleMethodCall(method: string, args: any[], replyTo: string) {
        const type = this.getFieldType(method);
        try {
            if (typeof this.lib[method] !== "function") {
                throw new Error(`${method} is not a valid service method!`);
            }
            const results = this.lib[method](...args);

            switch(type) {
                case 'promise':
                    const result = await results;

                    this.conn.publish(replyTo, bsonCodec.encode(result));
                    break;
                case 'stream':
                    const stream = ('then' in results ? await results : results) as NodeJS.ReadableStream;

                    const pubHeaders = makeHeaders();
                    pubHeaders.set('type', 'stream');
                    const pubOpts: PublishOptions = {
                        headers: pubHeaders,
                    };

                    const {maxSize} = this;
                    for await (const chunk of stream) {
                        // if stream length is greater than max message size
                        // then split it up into multiple messages
                        if (chunk.length > maxSize) {
                            const numChunks = Math.ceil(chunk.length / maxSize);
                            for (let i = 0; i < numChunks; i++) {
                                const start = i * maxSize;
                                const end = start + maxSize;
                                const chunkToSend = (<Buffer>chunk).subarray(start, end);
                                const bsonData = bsonCodec.encode(chunkToSend);
                                this.conn.publish(replyTo, bsonData, pubOpts);
                            }
                        } else {
                            const bsonData = bsonCodec.encode(chunk);
                            this.conn.publish(replyTo, bsonData, pubOpts);
                        }
                    }

                    // when the stream ends:
                    this.conn.publish(replyTo, bsonCodec.encode(null), pubOpts);
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
            this.conn.publish(replyTo, bsonCodec.encode(errObj));
        }
    }

    static makeConsumer<T extends {}>(nats: NatsConnection, subjectPrefix: string, lib: T & ObjWithMethodOpts, timeout = 25000) {
        let output: T = {} as T;

        const requestHelper = new RequestResponseHelper(nats);

        const methodNames = getLibMethods(lib);
        for (let key of methodNames) {
            if (typeof lib[key as keyof T] == 'function') {
                const methodOpts = {
                    timeout,
                    ...lib._$_methodOpts?.[String(key)] || {}
                };
                const topic = `${subjectPrefix}.${String(key)}`;
                if (methodOpts.type === 'stream') {
                    (<any>output)[key] = async (...args: any[]) => {
                        return requestHelper.requestStream(topic, args, methodOpts);
                    };
                } else {
                    (<any>output)[key] = async (...args: any[]) => {
                        try {
                            return await requestHelper.request(topic, args, methodOpts);
                        } finally {
                            // console.log(`Response from ${topic} received`);
                        }
                    };
                }
            }
        }
        return output;
    }
}

export {NatsService};
