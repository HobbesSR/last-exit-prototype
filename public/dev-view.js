import { createLayerDecoder } from '/shared/frame-layers.ts';
import { CLIENT_MESSAGE, SERVER_MESSAGE } from '/shared/protocol.ts';
import { envelopePresentation } from '/room-connection.js';
import { $, fillFollowOptions } from '/ui.js';

// The dev view (24) and its `#dev-*` controls. A player who steps out to it (#246) keeps their own socket,
// and their slot, and watches through a second one that this module owns: only frames come from it, while
// pauses, the lobby and replays still arrive on the player's socket. Leaving closes it and returns them to
// their own view. A connection that joined as the dev view (`standalone`) shows the same controls over the
// primary socket and opens no second one.
export function createDevView({
  director, standalone, getRoomId, getOwnerKey, getPlayerId, canEnter, onEnter, showMap, showState, restoreLive,
  presentationChanged, updateHUD, showStatus, cut, pointer, replaying, sendDev, togglePause, toast, icon, icons,
}) {
  let feed = null, presentation = null;
  // The roster the focus list was last built from.
  let roster = '';
  // The framing a player left the dev view with, restored when they step back out in the same room.
  let savedCamera = null;
  const active = () => standalone() || !!feed;
  function show() {
    const on = active();
    $('dev-controls').hidden = !on; $('dev-leave').hidden = !feed;
    updateHUD();
    $('dev-view').classList.toggle('active', !!feed); $('dev-view').setAttribute('aria-pressed', String(!!feed));
    showStatus(on);
  }
  // The dev view opens beside the match rather than in place of it, so a player keeps their slot.
  function enter() {
    if (feed || !canEnter()) return;
    onEnter();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    feed = socket;
    if (savedCamera && savedCamera.roomId === getRoomId()) {
      director.restore(savedCamera.camera);
    }
    show(); const layers = createLayerDecoder();
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: CLIENT_MESSAGE.JOIN, room: getRoomId(), ownerKey: getOwnerKey(), mode: 'dev' })));
    socket.addEventListener('message', event => {
      if (feed !== socket) return;
      const data = JSON.parse(event.data);
      if (data.type === SERVER_MESSAGE.WELCOME || data.type === SERVER_MESSAGE.READY) {
        const described = envelopePresentation(data);
        if (!described) { toast('The dev view sent a match this browser cannot read.'); leave(); return; }
        presentation = described; roster = '';
        if (data.map) showMap(data.map, data.state);
        else presentationChanged();
      }
      else if (data.type === SERVER_MESSAGE.STATE) { layers.decode(data.state); showState(data.state); }
      else if (data.type === SERVER_MESSAGE.ERROR) { toast(data.message); leave(); }
    });
    socket.addEventListener('close', () => { if (feed === socket) leave(); });
  }
  function leave() {
    const socket = feed;
    if (!socket) return;
    savedCamera = { roomId: getRoomId(), camera: director.snapshot() };
    feed = null; presentation = null; roster = ''; socket.close(); director.reset();
    restoreLive();
    show(); cut();
  }
  // T sends the followed player, or your own when you have stepped out of it, to the point under the cursor.
  function teleportToCursor() {
    const id = director.followId() || (feed ? getPlayerId() : null);
    if (!id) return toast('Follow a player to teleport them');
    const point = pointer();
    if (point) sendDev({ action: 'teleport', id, x: point.x, y: point.y });
  }
  addEventListener('keydown', event => {
    if (event.code !== 'KeyT' || event.repeat || !active() || replaying() || event.target.closest?.('input, textarea, select') || document.querySelector('dialog:modal')) return;
    teleportToCursor();
  });
  // Backquote steps out to the dev view and back, wherever the button is.
  addEventListener('keydown', event => {
    if (event.code !== 'Backquote' || event.repeat || event.target.closest?.('input, textarea, select') || document.querySelector('dialog:modal') || $('dev-view').hidden) return;
    feed ? leave() : enter();
  });
  $('dev-view').onclick = () => feed ? leave() : enter();
  $('dev-leave').onclick = () => leave();
  $('dev-focus').onchange = () => director.setFollow($('dev-focus').value);
  $('dev-fog').onclick = () => director.setFog(!director.fog());
  $('dev-whole').onclick = () => director.whole();
  // Focus would leave Space pressing this button as well as toggling the pause, which cancels out.
  $('dev-pause').onclick = event => { togglePause(); event.currentTarget.blur(); };
  return {
    enter, leave,
    /** Whether the dev view is showing, by either route. */
    active,
    /** Whether a player has stepped out to the second socket. */
    feeding: () => !!feed,
    /** The dev feed's own descriptor (22.7), set only by that feed. */
    presentation: () => presentation,
    /** A new connection: the last room's framing and roster are not this one's. */
    forget() { savedCamera = null; roster = ''; },
    /** What a welcome permits: the button to step out, or the controls of a connection that is the dev view. */
    offer(devTools) { $('dev-view').hidden = !devTools || standalone(); $('dev-controls').hidden = !standalone(); },
    /** Labels changed: the next refresh rebuilds the focus list even for the same roster. */
    staleRoster() { roster = ''; },
    // The focus list tracks the live roster: players join, and bots fill slots at the start.
    refreshRoster(players, described) {
      const key = players.map(p => p.id).join();
      if (key === roster) return;
      const select = $('dev-focus'), id = director.followId();
      const previous = [...select.options].find(option => option.value === id)?.textContent;
      roster = key; fillFollowOptions(select, players, described);
      if (id && !players.some(player => player.id === id)) select.add(new Option(previous || `${id} (absent)`, id));
      select.value = id || '';
    },
    /** Names where leaving returns a stepped-out player: to play, or to their results once `ended()`. */
    labelLeave(ended) {
      if (!feed) return;
      const label = ended() ? 'Back to results' : 'Back to player';
      const span = $('dev-leave').querySelector('span');
      if (span && span.textContent !== label) {
        span.textContent = label;
      } else if (!span) {
        $('dev-leave').innerHTML = `<i data-lucide="user"></i><span>${label}</span>`;
        icons();
      }
    },
    showFollow(id) { $('dev-focus').value = id || ''; },
    showFog(fog) { $('dev-fog').classList.toggle('active', fog); $('dev-fog').setAttribute('aria-pressed', String(fog)); },
    showPaused(paused) {
      $('dev-pause').innerHTML = icon(paused ? 'play' : 'pause'); $('dev-pause').ariaLabel = paused ? 'Resume match' : 'Pause match';
      $('dev-pause').dataset.tip = paused ? 'Resume (Space)' : 'Pause (Space)'; icons();
    },
  };
}
