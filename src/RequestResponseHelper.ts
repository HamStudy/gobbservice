
import { type NatsConnection, headers as makeHeaders, type Subscription, type Msg as NatsMsg } from 'nats';
import { isRemoteError, makeError, SimpleReadable } from './types';
import bsonCodec from './bsonCodec';
import * as uuid from 'uuid';
import stream from 'stream';

const processUuid = uuid.v4();
let topicBase = 'nINBOX.dev';

function makeReplyTopic() {
    const topicUuid = uuid.v5(processUuid, uuid.v4());
    return `${topicBase}.${topicUuid}`;
}

function makeDeferred<T>(timeout: number = 30000) {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: Error) => void;
    const promise$ = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout after ${timeout}ms`));
    }, timeout);
    promise$.then(() => clearTimeout(timeoutId), () => clearTimeout(timeoutId));
    return {
        resolve,
        reject,
        promise$,
        timeoutId,
    };
}
type Deferred<T> = ReturnType< typeof makeDeferred<T> >;

type ResponseTarget = {timeout: number} & ({dfd: Deferred<any>} | {stream: stream.Readable});

export interface RequestResponseHelperOptions {
    topicBase?: string;
}

function isDfd(dfd: any): dfd is Deferred<any> {
    return 'promise$' in dfd && 'resolve' in dfd && 'reject' in dfd;
}

export class RequestResponseHelper {
    private _topicMap = new Map<string, Deferred<any> | stream.Readable>();
    activeCount = 0;
    private _sub: Subscription | null = null;

    private _topicBase: string;

    constructor(protected conn: NatsConnection, opts: RequestResponseHelperOptions = {}) {
        const actualOpts = {
            topicBase,
            ...opts,
        };
        this._topicBase = actualOpts.topicBase;
    }
    get wildcardTopic() {
        return `${this._topicBase}.>`;
    }
    get isSubscribed() {
        return !!this._sub;
    }

    private unSubIfEmpty() {
        if (this._topicMap.size === 0) {
            this._sub?.unsubscribe();
            this._sub = null;
        }
    }

    private listenForResponse(replyTopic: string, target: ResponseTarget) {
        this.activeCount++;
        let dfd: Deferred<any> = ('dfd' in target) ? target.dfd : null;
        let stream: stream.Readable = ('stream' in target) ? target.stream : null;
        this._topicMap.set(replyTopic, dfd || stream);

        if (!this.isSubscribed) {
            this._sub = this.conn.subscribe(this.wildcardTopic, {
                callback: (err, msg) => {
                    if (err) {
                        console.warn("Error in subscription callback:", err);
                        if (dfd) {
                            dfd.reject(err);
                        } else {
                            stream.destroy(err);
                        }
                    } else {
                        this._onSubMsg(msg);
                    }
                },
            });
        }
    }
    private _onSubMsg(msg: NatsMsg) {
        const replyTopic = msg.subject;
        const type = msg.headers?.get('type') || 'request';
        if (!replyTopic) {
            console.warn("Received a message with no reply topic:", msg);
            return;
        }
        const target = this._topicMap.get(replyTopic);
        if (!isDfd(target)) { // stream type
            const stream = target;

            try {
                if (!stream) {
                    console.warn("Received a stream message with no stream:", msg);
                    return;
                }

                if (msg.data.length === 0) {
                    stream.push(null);
                    stream.resume();
                    this._topicMap.delete(replyTopic);
                    return;
                }

                // Decode the packet
                const data = bsonCodec.decode(msg.data);
                // Handle errors if any
                if (isRemoteError(data)) {
                    stream.destroy(makeError(data));
                }

                // Write the data to the stream
                // -- if data resolves to null, then we're done and it will close the Readable
                stream.push(data);
                stream.resume();

            } catch (err) {
                console.warn("Error handling stream message:", err);
                stream.destroy(err);
            } finally {
                if (stream.readableEnded) {
                    this._topicMap.delete(replyTopic);
                    setTimeout(() => this.unSubIfEmpty(), 1000);
                }
            }


        } else {
            const dfd = target;
            try {
                if (!dfd) {
                    console.warn("Received a message with no deferred:", msg);
                    return;
                }
                this._topicMap.delete(replyTopic);

                const decoded = bsonCodec.decode(msg.data);

                if (isRemoteError(decoded)) {
                    dfd.reject(makeError(decoded));
                    return;
                }

                dfd.resolve(decoded);
            } catch (err) {
                console.warn("Unexpected error:", err);
                dfd.reject(err);
            } finally {
                // Always wait 1 sec before unsubscribing
                setTimeout(() => this.unSubIfEmpty(), 1000);
            }
        }
    }

    request(topic: string, data: any, {timeout}: {timeout?: number} = {}) {
        const replyTopic = makeReplyTopic();
        const dfd = makeDeferred<any>();
        const headers = makeHeaders();
        headers.set('rTo', replyTopic);

        this.listenForResponse(replyTopic, {dfd, timeout});
        this.conn.publish(topic, bsonCodec.encode(data), {
            headers,
        });

        return Promise.race([
            dfd.promise$,
            new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${timeout}ms`)), timeout)),
        ]);
    }
    requestStream(topic: string, data: any, {timeout}: {timeout?: number} = {}): stream.Readable {
        const replyTopic = makeReplyTopic();
        // console.log("Created stream");
        const outStream = new SimpleReadable();
        outStream.pause();

        // outStream.on("close", () => console.log("Closed stream"));
        // outStream.on("end", () => console.log("Ended stream"));
        // outStream.on("finish", () => console.log("Finished stream"));
        // outStream.on("error", (err) => console.log("Error stream:", err));
        // // On data print the size of the chunk received
        // outStream.on("data", (chunk) => console.log("Received chunk:", chunk.length));

        const headers = makeHeaders();
        headers.set('rTo', replyTopic);

        this.listenForResponse(replyTopic, {stream: outStream, timeout});
        this.conn.publish(topic, bsonCodec.encode(data), {
            headers,
        });

        let timeoutId: NodeJS.Timeout | null = null;
        function resetTimeout() {
            if (timeoutId) { clearTimeout(timeoutId); }
            timeoutId = setTimeout(() => {
                outStream.destroy(new Error(`Timeout after ${timeout}ms`));
            });
        }
        outStream.on('data', resetTimeout);
        outStream.on('end', () => {
            if (timeoutId) { clearTimeout(timeoutId); }
        });
        outStream.on('error', () => {
            if (timeoutId) { clearTimeout(timeoutId); }
        });

        return outStream;
    }
}

export default RequestResponseHelper;