import { DEFAULT_KIT } from '/shared/simulation/rules.ts';
import { $, kitName, fillKitOptions } from '/ui.js';

// The pre-match lobby dialog: the roster the room last announced, a player's own role and kit choice,
// and the start countdown. It never touches the socket: the application sends what it asks for, and
// tells it which room, player and descriptor it is showing.
export function createLobbyController({
  getRoomId, getPlayerId, isOwner, getPresentation, choose, start, copyLink, onOwnChoice, icons,
}) {
  let players = [];
  // Advertised by the room rather than transcribed here: the roster that decides them is match content.
  let capacity = null;
  let startsAt = null;
  // Whether the room's map exists yet (#258), and whether the owner's start is waiting on it.
  let ready = true, starting = false;
  // The gladiator kit this player last held or picked in the lobby, kept across a spell as a contestant.
  let kit = DEFAULT_KIT;
  // The lobby message last shown, so new labels can redraw it without changing what it said.
  let shown = {};
  const open = () => $('lobby-dialog').open;
  function update(data = {}) {
    shown = data;
    startsAt = data.startsAt || null;
    if ('ready' in data) ready = data.ready;
    starting = !!data.starting;
    if (data.players) players = data.players;
    if (data.capacity) capacity = data.capacity;
    const owner = isOwner(), described = getPresentation();
    const contestants = players.filter(p => p.role === 'contestant');
    const gladiators = players.filter(p => p.role === 'gladiator');
    $('lobby-room').textContent = getRoomId() || data.room || '';
    if ('name' in data) $('lobby-title').textContent = data.name || 'Arena lobby.';
    if (data.size) $('lobby-size').textContent = data.size.replace('x', ' × ');
    const places = role => capacity ? `/${capacity[role]}` : '';
    $('lobby-count').textContent = `${contestants.length}${places('contestant')} contestants / ${gladiators.length}${places('gladiator')} gladiators`;
    const render = (target, list, empty) => {
      target.replaceChildren();
      if (!list.length) {
        const li = document.createElement('li'); li.className = 'empty'; li.textContent = empty; target.append(li); return;
      }
      for (const p of list) {
        const li = document.createElement('li'), name = document.createElement('strong'), meta = document.createElement('span');
        const held = p.role === 'gladiator' ? ` / ${kitName(p.kit, described)}` : '';
        name.textContent = p.name; meta.textContent = `${p.role}${held}`;
        li.append(name, meta); target.append(li);
      }
    };
    render($('lobby-contestants'), contestants, 'Open contestant slots will be bots.');
    render($('lobby-gladiators'), gladiators, 'Open gladiator slots will be bots.');
    showChoice(data.started);
    $('start-match').hidden = !owner;
    $('start-match').disabled = !owner || data.started || starting;
    $('lobby-waiting').hidden = owner && ready;
    $('lobby-waiting').textContent = waiting(data.matchmade);
    icons();
  }
  // A player's own role and kit, changeable until the start (#235). The room holds the choice; this only asks.
  function showChoice(started) {
    const me = players.find(p => p.id === getPlayerId());
    $('lobby-choice').hidden = !me || !!started;
    if (!me) return;
    for (const button of document.querySelectorAll('[data-lobby-role]')) {
      const role = button.dataset.lobbyRole, mine = role === me.role;
      button.setAttribute('aria-pressed', String(mine));
      // Another side is open while it holds fewer people than places.
      button.disabled = !mine && !!capacity && players.filter(p => p.role === role).length >= capacity[role];
    }
    if (me.role === 'gladiator') kit = me.kit;
    $('lobby-kit').hidden = me.role !== 'gladiator';
    // The room's own kits, not the deploy form's: rebuilt without asking for anything.
    kit = fillKitOptions($('lobby-kit'), getPresentation(), kit) || kit;
    onOwnChoice(me.role, me.kit);
  }
  function waiting(matchmade) {
    if (!ready) return starting || matchmade ? 'Generating the arena. The match starts when it is ready.' : 'Generating the arena…';
    return matchmade ? 'Match found. Preparing the arena…' : 'Waiting for the room owner to start the match.';
  }
  document.querySelectorAll('[data-lobby-role]').forEach(button => button.onclick = () => {
    const role = button.dataset.lobbyRole, me = players.find(p => p.id === getPlayerId());
    // The role already held asks nothing, so it cannot send a kit that is not the player's own.
    if (!me || role === me.role) return;
    // Back to gladiator with the lobby's latest kit; a contestant's kit is never shown.
    choose(role, role === 'gladiator' ? kit : undefined);
  });
  $('lobby-kit').onchange = () => { kit = $('lobby-kit').value; choose('gladiator', kit); };
  $('start-match').onclick = () => start();
  $('copy-lobby-link').onclick = () => copyLink();
  setInterval(() => {
    if (!startsAt || !open()) return;
    const seconds = Math.ceil((startsAt - Date.now()) / 1000);
    $('lobby-waiting').textContent = seconds <= 0 && !ready ? waiting(true) : `Match starts in ${Math.max(0, seconds)}s. Open slots will be filled by bots.`;
  }, 250);
  return {
    open, update,
    /** Redraws the last message under the current descriptor's labels. */
    redraw: () => update(shown),
    // Not modal: people walk about the waiting area while it is open (#236).
    show(data) { update(data); if (!open()) $('lobby-dialog').show(); },
    hide() { if (open()) $('lobby-dialog').close(); },
    /** A new connection: nothing of the last room's roster, and the kit this one joins with. */
    reset(joinKit) {
      $('lobby-title').textContent = 'Arena lobby.';
      players = []; shown = {}; capacity = null; ready = true; starting = false; kit = joinKit;
    },
  };
}
