
import { serialize, deserialize, Binary, calculateObjectSize, setInternalBufferSize } from 'bson';
import { Codec } from 'nats';

function fixTypes<T extends any>(v: T) {
    if (v instanceof Binary) {
        return v.buffer;
    }
    return v;
}

export default {
    encode: (data: any) => {
        const sData = {v: data};
        const size = calculateObjectSize(sData);
        // const buffer = Buffer.alloc(size);
        setInternalBufferSize(size + 128); // Add extra window just in case
        return serialize(sData);
    },
    decode: (data: Uint8Array) => {
        const decoded = deserialize(data);
        return fixTypes(decoded.v);
    }
} as Codec<any>;
