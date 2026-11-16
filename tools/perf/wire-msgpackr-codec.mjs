// #1130 candidate M: msgpackr records behind the same stateless boundary as the descriptor codec.
// The caller passes the Packr/Unpackr classes, so this file runs in Node and Chrome alike.
// Modes: 'inline' (every record definition travels in the message) and 'provisioned' (a frozen,
// versioned structure table shipped with the client; shapes outside it still go inline).
// No `sequential`: nothing an encoder learns from one message is relied on by the next.
const FORMAT = 0xd2, MESSAGE_IDS = { state: 1, ping: 2, input: 3 }, TYPES = Object.fromEntries(Object.entries(MESSAGE_IDS).map(([k, v]) => [v, k]));

export function createMsgpackrCodec({ Packr, Unpackr }, { mode = 'inline', structures = [], version = 1, maxBytes = 1 << 20, name } = {}) {
  const table = mode === 'provisioned' ? structures.map(keys => [...keys]) : [];
  const snapshot = JSON.stringify(table);
  // maxSharedStructures equal to the table size leaves no free slot, so the encoder cannot grow it.
  const options = { useRecords: true, mapsAsObjects: true, int64AsType: 'number', moreTypes: false,
    ...(mode === 'provisioned' ? { structures: table, maxSharedStructures: table.length } : {}) };
  const packr = new Packr(options);
  const unpackr = () => new Unpackr({ ...options, ...(mode === 'provisioned' ? { structures: table.map(keys => [...keys]) } : {}) });
  const decoder = unpackr();
  return {
    name: name ?? `msgpackr-${mode}`,
    // A fresh decoder per call stands in for a reconnecting client (the check that nothing is sequential).
    freshDecoder: unpackr,
    tableUnchanged: () => JSON.stringify(table) === snapshot,
    encode(message) {
      const id = MESSAGE_IDS[message.type];
      if (!id) throw new TypeError(`unknown type ${message.type}`);
      const body = packr.pack(message);
      const out = new Uint8Array(body.length + 3);
      out[0] = FORMAT; out[1] = version; out[2] = id; out.set(body, 3);
      return out;
    },
    decode(bytes, unpack = decoder) {
      if (bytes.length > maxBytes) throw new RangeError('message too large');
      if (bytes[0] !== FORMAT) throw new RangeError('unknown format');
      if (bytes[1] !== version) throw new RangeError('unsupported version');
      const type = TYPES[bytes[2]];
      if (!type) throw new RangeError('unknown message type');
      const message = unpack.unpack(bytes.subarray(3));
      if (message?.type !== type) throw new RangeError('message type mismatch');
      return message;
    },
  };
}
