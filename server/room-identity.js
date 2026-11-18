import { randomBytes, randomUUID } from 'node:crypto';

// A room's identity, minted in one place whether the room runs inline (room.js) or in its own thread
// (room-thread.js), so the two hosts cannot drift apart in format (#1187).

/** A room's public id: eight hex characters, short enough to read out or type. */
export const newRoomId = () => randomBytes(4).toString('hex');
/** The secret that proves ownership of a private room. */
export const newOwnerKey = () => randomUUID();
