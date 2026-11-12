import { readPresentation } from '/shared/presentation.ts';
import { WIRE_VERSION, HTTP_ENDPOINT } from '/shared/protocol.ts';
import { DEFAULT_KIT } from '/shared/simulation/rules.ts';
import { $, DEFAULT_CALLSIGN, fillKitOptions } from '/ui.js';

const SIZE_NAMES = { '12x6': 'Standard', '24x12': 'Large', '36x18': 'Huge' };
const sizeLabel = size => { const [w, h] = size.split('x'); return `${SIZE_NAMES[size] ?? 'Custom'} (${w} × ${h})`; };

// The deploy dialog: the ways into a room (the first arena, a new one, Auto, a listed room), the server's
// client configuration that fills the form, and the room browser. Its state lasts the page, not a
// connection. It creates rooms over HTTP and asks the application to connect; it never holds the socket.
export function createDeployController({ fetchJSON, connect, toast, clearInput, ownsRoom, icon, icons }) {
  // The deploy dialog's own choice; a connection may join in another role without changing it.
  let selectedRole = 'contestant';
  let connecting = false;
  // Deploy defaults and limits (22.7): null until `/api/client-config` answers. Until then the form shows
  // neutral placeholders and cannot create or matchmake; nothing else waits for it.
  let clientConfig = null, configLoad = null;
  // A size the address named, kept until the options it must be chosen among exist.
  let requestedSize = null;
  // The lobby browser (22.5): the rooms the directory lists, polled while the deploy dialog is open.
  let listedRooms = [], devPolicy = null, refreshingRooms = false;
  let activeTab = 'join';
  function showError(message) { $('deploy-error').textContent = message; $('deploy-error').hidden = false; }
  /** Runs one way into a room from the deploy dialog, reporting a refusal there; one at a time. */
  async function deploy(enter) {
    if (connecting) return;
    connecting = true; $('deploy-error').hidden = true;
    try { await enter(); }
    catch (error) { showError(error.message); toast(error.message); }
    finally { connecting = false; }
  }
  const player = () => ({ kit: $('kit').value || DEFAULT_KIT, name: $('callsign').value || DEFAULT_CALLSIGN });
  const createRoom = body => fetchJSON(HTTP_ENDPOINT.ROOMS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // The deploy form's room: its options come from the server's configuration, so it waits for that.
  const newArena = () => clientConfig && deploy(async () => {
    // A blank seed lets the server choose, which serves a map from its pool at once (#266); a named one reproduces that map.
    const seed = $('seed').value === '' ? undefined : Number($('seed').value);
    const data = await createRoom({ seed, size: $('map-size').value, name: $('room-name').value });
    await connect({ room: data.id, key: data.ownerKey, role: selectedRole, ...player() });
  });
  // Auto is matchmaking: the directory picks a matchmade room still filling, or starts one.
  const autoMatch = () => clientConfig && deploy(() => connect({ matchmake: true, role: $('role-preference').value, ...player() }));
  /**
   * The room a first visit without a room link opens, at once: it reads nothing from the deploy form, whose
   * options may still be loading. The server chooses whatever is not named; a `?seed=` or `?size=` in the
   * address goes to it as given, for its own validation to accept or refuse.
   */
  const firstArena = overrides => deploy(async () => {
    const data = await createRoom(overrides);
    await connect({ room: data.id, key: data.ownerKey, role: 'contestant', kit: DEFAULT_KIT, name: DEFAULT_CALLSIGN });
  });
  function loadConfig() {
    if (clientConfig || configLoad) return configLoad;
    $('config-error').hidden = true;
    configLoad = fetchJSON(HTTP_ENDPOINT.CLIENT_CONFIG).then(config => {
      if (config?.wireVersion !== undefined && config.wireVersion !== WIRE_VERSION) throw new Error('Incompatible wire version');
      const described = readPresentation(config?.presentation);
      if (!described || !Array.isArray(config.sizes)) throw new Error('Unreadable arena options');
      clientConfig = { ...config, presentation: described };
      applyConfig();
    }).catch(() => { $('config-error').hidden = false; }).finally(() => { configLoad = null; });
    return configLoad;
  }
  // Fills the form from configuration, keeping what the address or the player already chose.
  function applyConfig() {
    const { presentation: described, seed, roomNameMaxLength, playerNameMaxLength, sizes, defaultSize, matchmakingCountdownMs, devTools } = clientConfig;
    devPolicy = devTools ?? devPolicy;
    fillKitOptions($('kit'), described, $('kit').value || DEFAULT_KIT);
    // An unsupported size named in the address stays named, for the server to refuse, rather than becoming another.
    const size = requestedSize ?? ($('map-size').value || defaultSize);
    const offered = sizes.includes(size) ? sizes : [...sizes, size];
    $('map-size').replaceChildren(...offered.map(name => Object.assign(document.createElement('option'), { value: name, textContent: sizeLabel(name) })));
    $('map-size').value = size; $('map-size').disabled = false; requestedSize = null;
    $('seed').min = String(seed.min); $('seed').max = String(seed.max);
    $('callsign').maxLength = playerNameMaxLength;
    $('room-name-limit').textContent = `At most ${roomNameMaxLength} characters.`;
    $('matchmaking-countdown').textContent = `${Math.round(matchmakingCountdownMs / 1000)} seconds`;
    $('auto-match').disabled = false; document.querySelector('#deploy-form .deploy').disabled = false;
    if (listedRooms?.length) renderRooms();
  }
  function selectTab(tabName) {
    activeTab = tabName;
    const isJoin = tabName === 'join';
    $('tab-join')?.classList.toggle('active', isJoin);
    $('tab-join')?.setAttribute('aria-selected', String(isJoin));
    $('tab-join')?.setAttribute('tabindex', isJoin ? '0' : '-1');
    $('tab-create')?.classList.toggle('active', !isJoin);
    $('tab-create')?.setAttribute('aria-selected', String(!isJoin));
    $('tab-create')?.setAttribute('tabindex', !isJoin ? '0' : '-1');
    if ($('panel-join')) $('panel-join').hidden = !isJoin;
    if ($('panel-create')) $('panel-create').hidden = isJoin;
    if (isJoin) void refreshRooms();
  }
  function open(tabName = activeTab) {
    selectTab(tabName);
    if (!$('loadout-dialog').open) $('loadout-dialog').showModal();
  }
  async function refreshRooms() {
    if (refreshingRooms) return;
    refreshingRooms = true;
    try {
      if (!clientConfig) void loadConfig();
      listedRooms = await fetchJSON(HTTP_ENDPOINT.ROOMS);
    } catch { listedRooms = null; }
    finally { refreshingRooms = false; }
    renderRooms();
  }
  function renderRooms() {
    const target = $('room-list'); target.replaceChildren();
    if (!listedRooms?.length) {
      const p = document.createElement('p'); p.className = 'empty-archive';
      p.textContent = listedRooms ? 'No open rooms. Press Auto, or create one below.' : 'The room list is unavailable.';
      target.append(p); return;
    }
    for (const r of listedRooms) {
      const row = document.createElement('div'); row.className = 'room-row';
      const details = document.createElement('div'), title = document.createElement('strong'), sub = document.createElement('small');
      const label = r.name || `Room ${r.id}`; title.textContent = label;
      const status = r.phase === 'live' ? 'live' : r.ready ? r.kind === 'matchmade' ? 'filling' : 'lobby' : 'generating';
      const badge = document.createElement('span'); badge.className = `room-phase phase-${status}`; badge.textContent = status;
      const count = role => `${r.players[role]}/${r.players[role] + r.open[role]}`;
      sub.textContent = `${r.size.replace('x', ' × ')} / ${count('contestant')} contestants / ${count('gladiator')} gladiators`;
      title.append(' ', badge); details.append(title, sub);
      const actions = document.createElement('div');
      // Before the start a player is placed wherever there is room and can change in the lobby (#235); a
      // private match already under way admits only the role chosen.
      const places = r.phase === 'lobby' || r.kind === 'matchmade' ? r.open.contestant + r.open.gladiator : r.open[selectedRole];
      const join = document.createElement('button'); join.type = 'button'; join.className = 'secondary-button'; join.textContent = 'Join';
      join.disabled = !places; join.ariaLabel = `Join ${label}`; join.onclick = () => deploy(() => connect({ room: r.id, role: selectedRole, ...player() }));
      actions.append(join);
      // An `owner` policy asks that this browser hold the room's owner key.
      if (devPolicy === 'all' || devPolicy === 'owner' && ownsRoom(r.id)) {
        const dev = document.createElement('button'); dev.type = 'button'; dev.className = 'icon-button'; dev.innerHTML = icon('eye');
        dev.ariaLabel = `Dev view of ${label}`; dev.dataset.tip = 'Dev view';
        dev.onclick = () => deploy(() => connect({ room: r.id, mode: 'dev' }));
        actions.append(dev);
      }
      row.append(details, actions); target.append(row);
    }
    icons();
  }
  // The kit matters to anyone who may be a gladiator: chosen, or preferred for Auto.
  const showKit = () => { $('kit-options').hidden = selectedRole !== 'gladiator' && $('role-preference').value !== 'gladiator'; };
  $('config-retry').onclick = () => void loadConfig();
  setInterval(() => { if ($('loadout-dialog').open && !$('panel-join').hidden) void refreshRooms(); }, 2000);
  $('new-game').onclick = $('play-again').onclick = () => { clearInput(); $('deploy-error').hidden = true; open('join'); };
  $('tab-join').onclick = () => selectTab('join');
  $('tab-create').onclick = () => selectTab('create');
  $('tab-join').onkeydown = $('tab-create').onkeydown = e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const nextTab = activeTab === 'join' ? 'create' : 'join';
      selectTab(nextTab);
      $(nextTab === 'join' ? 'tab-join' : 'tab-create')?.focus();
    }
  };
  $('deploy-form').onsubmit = e => {
    e.preventDefault();
    if ($('panel-join') && !$('panel-join').hidden) {
      void autoMatch();
    } else {
      void newArena();
    }
  };
  $('auto-match').onclick = () => void autoMatch();
  $('random-seed').onclick = () => { $('seed').value = ''; };
  document.querySelectorAll('[data-role]').forEach(button => button.onclick = () => {
    selectedRole = button.dataset.role; showKit();
    document.querySelectorAll('[data-role]').forEach(b => { const selected = b === button; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', selected); });
    renderRooms();
  });
  $('role-preference').onchange = showKit;
  return {
    open, showError, loadConfig, firstArena,
    close() { $('loadout-dialog').close(); },
    /** What the address named for a new room, shown in the form: `?seed=`, and `?size=` once sizes are known. */
    prefill({ seed, size }) {
      if (seed) $('seed').value = seed;
      if (size) requestedSize = size;
    },
  };
}
