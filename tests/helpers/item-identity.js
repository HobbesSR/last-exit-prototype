import { itemIdForLabel, itemLabel as runtimeItemLabel, registerItemLabel } from '../../shared/item-instances.ts';

/** Register a stable label and return its numeric runtime identity. */
export const itemId = (game, label) => registerItemLabel(game, label);

/** Look up an identity already registered by test setup without changing state. */
export function registeredItemId(game, label) {
  const id = itemIdForLabel(game, label);
  if (id === undefined) throw new Error(`Test item label was not registered: ${label}`);
  return id;
}

/**
 * Convert identities deliberately arranged by a test after createGame has normalized
 * map input. This keeps legacy map fixtures readable while ensuring runtime state
 * carries numeric identities.
 */
export function identifyItems(game) {
  const identify = value => typeof value === 'string' ? registerItemLabel(game, value) : value;
  for (const item of game.items) {
    if (typeof item.id === 'string') item.id = identify(item.id);
    if (typeof item.instanceId === 'string') item.instanceId = identify(item.instanceId);
    if (typeof item.lineageId === 'string') item.lineageId = identify(item.lineageId);
  }
  for (const player of game.players ?? []) {
    for (const item of player.inventory ?? []) if (item) {
      if (typeof item.instanceId === 'string') item.instanceId = identify(item.instanceId);
      if (typeof item.lineageId === 'string') item.lineageId = identify(item.lineageId);
    }
    if (typeof player.reload?.instanceId === 'string') player.reload.instanceId = identify(player.reload.instanceId);
  }
  return game;
}

/** Read a public label for an internal numeric ID in assertions. */
export function itemLabel(game, id) {
  return typeof id === 'number' ? runtimeItemLabel(game, id) : id;
}
