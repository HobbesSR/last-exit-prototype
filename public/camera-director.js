import { playerZoom } from '/shared/view.ts';

// Where a directed camera points: replays, spectators and the dev view all share it. It frames the whole
// arena, a free view panned and zoomed by hand, or a followed player, shown in that player's sight
// unless fog is turned off. It never decides what a player's own camera does, and never touches a socket.

// Physical keys, as the input controller reads them, so a layout moves both the same way.
const PAN_KEYS = { KeyW: [0, -1], KeyA: [-1, 0], KeyS: [0, 1], KeyD: [1, 0], ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0] };
// Screen pixels a held pan key covers per second, whatever the zoom.
const PAN_SPEED = 900;
const MIN_ZOOM = 0.02, MAX_ZOOM = 2;
const clampZoom = zoom => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/**
 * `active()` says whether a directed view is showing, so keys only steer it then. `camera()` is where the
 * camera is right now ({ x, y, zoom }, x and y its centre), so a free view starts from what is on screen.
 */
export function createCameraDirector({ getState, active, camera, onFollow = () => {}, onFog = () => {} }) {
  let followId = null, fog = true, view = null;
  const held = new Set();
  const subject = () => followId ? getState()?.players.find(p => p.id === followId) || null : null;

  function setFollow(id) {
    followId = id || null;
    onFollow(subject(), followId);
  }
  /** Stop following, leaving the camera where it is at the zoom it has. */
  function free() {
    if (!followId) return;
    view = camera(); setFollow(null);
  }
  /** Move the view by a distance in world units; panning off a followed player frees it there. */
  function pan(dx, dy) {
    free();
    view ??= camera();
    view = { ...view, x: view.x + dx, y: view.y + dy };
  }
  /** Zoom by a factor about a world point, which stays under the pointer. A follow keeps its centre. */
  function zoomAt(factor, point) {
    const base = view ?? camera(), zoom = clampZoom(base.zoom * factor), kept = base.zoom / zoom;
    view = followId ? { ...base, zoom } : { x: point.x + (base.x - point.x) * kept, y: point.y + (base.y - point.y) * kept, zoom };
  }
  function whole() { view = null; setFollow(null); }
  function setFog(value) { fog = !!value; onFog(fog); }
  function reset() { view = null; followId = null; held.clear(); }

  /** Where the camera points this frame. `focus` is the eased eye on the followed player, if any. */
  function frame({ width, height, map, focus, overview }) {
    if (followId && focus) {
      // Their sight is cut to their own screen, so a fogged follow keeps their zoom exactly.
      const zoom = fog || !view ? playerZoom(width, height, overview) : view.zoom;
      return { x: focus.x, y: focus.y, zoom };
    }
    if (view) return view;
    return { x: map.width / 2, y: map.height / 2, zoom: Math.min((width - 40) / map.width, (height - 150) / map.height) };
  }
  /** Advance held pan keys by one frame of `delta` ms. A stall longer than a quarter second pans no further. */
  function step(delta) {
    if (!held.size || !active()) return;
    delta = Math.min(delta, 250);
    let x = 0, y = 0;
    for (const key of held) { x += PAN_KEYS[key][0]; y += PAN_KEYS[key][1]; }
    const zoom = camera().zoom;
    if (x || y) pan(x * PAN_SPEED * delta / 1000 / zoom, y * PAN_SPEED * delta / 1000 / zoom);
  }

  const typing = event => event.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]');
  addEventListener('keydown', event => {
    if (!active() || typing(event)) return;
    const key = event.code;
    if (PAN_KEYS[key]) { held.add(key); event.preventDefault(); }
    else if (event.repeat) return;
    else if (key === 'Escape') free();
    else if (key === 'KeyF') setFog(!fog);
    else if (key === 'Digit0' || key === 'Home') whole();
  });
  addEventListener('keyup', event => held.delete(event.code));
  addEventListener('blur', () => held.clear());

  return {
    followId: () => followId, subject, setFollow, free, pan, zoomAt, whole, reset, frame, step,
    /** The player whose sight fogs the view, or null for the unfogged directed view. */
    viewer: () => fog ? subject() : null,
    fog: () => fog, setFog,
  };
}
