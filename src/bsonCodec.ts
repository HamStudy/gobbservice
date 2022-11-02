
import { serialize, deserialize } from 'bson';
import { Codec } from 'nats';
import { Binary } from 'bson';

function fixTypes<T extends any>(v: T) {
    if (v instanceof Binary) {
        return v.buffer;
    }
    return v;
}

export default {
    encode: (data: any) => {
        return serialize({v: data});
    },
    decode: (data: Uint8Array) => {
        const decoded = deserialize(data);
        return fixTypes(decoded.v);
    }
} as Codec<any>;
