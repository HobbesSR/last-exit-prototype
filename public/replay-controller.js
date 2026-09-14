import { createReplayTimeline } from '/replay-timeline.js';
import { recordingFit } from '/shared/recording.ts';
import { $, kitName, time } from '/ui.js';

// Recorded-match playback: timeline, wall-clock-anchored playhead, follow subject and the
// replay-* DOM. The application supplies the shared arena/state/scene it must read or restore
// and never has this module send a command or touch the socket.
export function createReplayController({
  fetchJSON, changeMap, acceptState, updateHUD, clearInput, toast, connection,
  getMap, getState, setState, getScene, getLiveMap, getLiveState, liveConnectionLabel,
  downloadReplay, icon, icons,
}) {
  let replay = null, replayTimeline = null, playback = 0, playing = true, followId = null;
  // Where playback was when the clock was last anchored, and when that was. Every jump re-anchors.
  let playbackFrom = 0, playbackAt = 0;
  // The recorded roster may name players the current frame no longer contains.
  const followed = () => followId && replay ? getState()?.players.find(p => p.id === followId) || null : null;

  // The roster comes from the recording rather than the displayed frame, so a subject can be
  // chosen before they appear and stays selectable after they are eliminated.
  function fillFollowOptions(roster = []) {
    const select = $('replay-focus');
    const whole = document.createElement('option'); whole.value = ''; whole.textContent = 'Whole arena';
    const groups = [['contestant', 'Contestants'], ['gladiator', 'Gladiators']].map(([role, label]) => {
      const group = document.createElement('optgroup'); group.label = label;
      for (const player of roster.filter(p => p.role === role)) {
        const option = document.createElement('option'); option.value = player.id;
        option.textContent = player.role === 'gladiator' ? `${player.name} / ${kitName(player.kit)}` : player.name;
        group.append(option);
      }
      return group;
    }).filter(group => group.childElementCount);
    select.replaceChildren(whole, ...groups);
  }
  function setFollow(id) {
    followId = id || null;
    $('replay-focus').value = followId || '';
    // A cut, not a pan: gliding a camera across a 24000 unit arena would lose the subject for seconds.
    getScene()?.cutTo();
    const target = followed();
    if (target) toast(`Following ${target.name}`);
  }
  function applyTick(tick) {
    const sample = replayTimeline?.at(tick);
    if (!sample) return;
    playback = sample.tick;
    if (getState() !== sample.state) { setState(sample.state); getMap().gates = sample.state.gates; updateHUD(); }
    $('replay-seek').value = String(Math.floor(playback)); $('replay-time').textContent = time(playback);
    const status = $('replay-status'); status.hidden = !sample.missing && replayTimeline.complete;
    if (!status.hidden) status.textContent = sample.missing
      ? `MISSING DATA · showing tick ${sample.frameTick}`
      : `PARTIAL RECORDING · ${replayTimeline.droppedFrames} frame${replayTimeline.droppedFrames === 1 ? '' : 's'} omitted`;
  }
  function seek(tick) { applyTick(tick); anchorPlayback(); }
  function anchorPlayback() { playbackFrom = playback; playbackAt = performance.now(); }
  function setPlaying(value) {
    playing = value; if (value) anchorPlayback();
    $('replay-play').innerHTML = icon(value ? 'pause' : 'play');
    $('replay-play').ariaLabel = value ? 'Pause replay' : 'Play replay'; icons();
  }
  async function watch(id) {
    try {
      const data = await fetchJSON(`/api/replays/${id}`);
      const timeline = createReplayTimeline(data);
      if (!timeline.frames.length) throw new Error('Replay contains no playable frames.');
      // The recording states what it is; this build decides whether it can read it. `shared/recording.ts`
      // owns that decision so the writer and the reader cannot disagree about it.
      const fit = recordingFit(data);
      if (fit !== 'ok') throw new Error(`${{
        'too-new': 'This broadcast was recorded by a newer build of the arena.',
        'too-old': 'This broadcast uses a recording format this build no longer reads.',
        'pre-vector': 'This broadcast uses the earlier grid prototype.',
      }[fit]} Its JSON can still be downloaded.`);
      clearInput(); replay = data; replayTimeline = timeline; playback = 0; playing = true;
      changeMap(data.map);
      $('outcome').hidden = true; $('archive-dialog').close(); $('live-hud').hidden = true;
      $('replay-controls').hidden = false; $('replay-seek').min = 0; $('replay-seek').max = timeline.endTick; $('replay-seek').value = 0;
      fillFollowOptions(timeline.roster); setFollow(null);
      document.body.classList.add('replaying'); connection('REPLAY'); setPlaying(true); seek(0); getScene()?.updateCamera(true);
    } catch (error) { toast(error.message); }
  }
  function renderFrame() {
    if (!replay || !playing) return;
    // Playback follows the wall clock rather than accumulating the render delta. Phaser smooths and
    // clamps the delta it reports, so accumulating it runs a replay slow on any client whose frames
    // are long -- the speed control then selects a rate the viewer never actually gets. Anchoring
    // also stops rounding drift accumulating over the thousands of frames a match lasts.
    applyTick(playbackFrom + (performance.now() - playbackAt) / 1000 * replay.hz * Number($('replay-speed').value));
    if (playback >= replayTimeline.endTick) setPlaying(false);
  }
  function close() {
    replay = null; replayTimeline = null; followId = null;
    $('replay-controls').hidden = true; $('live-hud').hidden = false; document.body.classList.remove('replaying');
    const liveMap = getLiveMap(), liveState = getLiveState();
    if (liveMap && liveState) { changeMap(liveMap); acceptState(liveState); }
    connection(liveConnectionLabel()); getScene()?.updateCamera(true);
  }
  function reset() {
    replay = null; replayTimeline = null;
    document.body.classList.remove('replaying'); $('replay-controls').hidden = true;
  }
  $('replay-play').onclick = () => { if (replay && playback >= replayTimeline.endTick) seek(0); setPlaying(!playing); };
  $('replay-seek').oninput = () => { if (replay) seek(Number($('replay-seek').value)); };
  // Without re-anchoring, the time already elapsed would be re-scaled by the new rate and jump.
  $('replay-speed').onchange = () => { if (replay) anchorPlayback(); };
  $('replay-focus').onchange = () => { if (replay) setFollow($('replay-focus').value); };
  $('replay-download').onclick = () => { if (replay) void downloadReplay(replay.id); };
  $('replay-close').onclick = close;
  return {
    active: () => !!replay, followId: () => followId, subject: followed, frameAlpha: () => replayTimeline?.at(playback)?.alpha ?? 0,
    watch, renderFrame, togglePlay: () => setPlaying(!playing), setFollow, reset,
    // Lets the application skip a refetch when downloading the replay already open here.
    cachedData: id => replay?.id === id ? replay : null,
  };
}
