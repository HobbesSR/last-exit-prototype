import { clusterMarks, createReplayTimeline, markLabel, markSeekTick } from '/replay-timeline.js';
import { recordingFit } from '/shared/recording.ts';
import { $, fillFollowOptions, time } from '/ui.js';

// Recorded-match playback: timeline, wall-clock-anchored playhead and the replay-* DOM. The camera
// director owns who is followed. The application supplies the shared arena/state/scene it must read
// or restore and never has this module send a command or touch the socket.
export function createReplayController({
  fetchJSON, changeMap, acceptState, updateHUD, clearInput, toast, connection,
  getMap, getState, setState, getScene, getLiveMap, getLiveState, liveConnectionLabel,
  downloadReplay, icon, icons, director,
}) {
  let replay = null, replayTimeline = null, playback = 0, playing = true;
  // Where playback was when the clock was last anchored, and when that was. Every jump re-anchors.
  let playbackFrom = 0, playbackAt = 0;
  const setFollow = id => director.setFollow(id);
  // Pips sit over the scrubber, positioned within the range thumb's travel. Shape differs by kind as
  // well as colour, and the tooltip names the mark. Marks too close to draw apart share one pip
  // showing their count; activating it opens a list so each stays individually selectable.
  // Choosing a mark seeks to just before it and follows the reporting player, when the roster has them.
  function chooseMark(mark) {
    closeMarkMenu();
    seek(markSeekTick(mark, replay.hz, replayTimeline.firstTick ?? 0));
    if (mark.playerId !== undefined && replayTimeline.roster.some(p => p.id === mark.playerId)) setFollow(mark.playerId);
  }
  function closeMarkMenu() { $('replay-mark-menu').hidden = true; $('replay-mark-menu').replaceChildren(); }
  function openMarkMenu(cluster, left) {
    const menu = $('replay-mark-menu');
    menu.replaceChildren(...cluster.marks.map(mark => {
      const item = document.createElement('button'), who = replayTimeline.roster.find(p => p.id === mark.playerId);
      item.className = `mark-${mark.kind}`; item.textContent = who ? `${markLabel(mark)} \u00b7 ${who.name}` : markLabel(mark);
      item.onclick = () => chooseMark(mark);
      return item;
    }));
    menu.style.left = left; menu.hidden = false; menu.firstChild?.focus();
  }
  function renderMarks() {
    const layer = $('replay-marks'), end = replayTimeline?.endTick;
    layer.replaceChildren(); closeMarkMenu();
    if (!replayTimeline || !end) return;
    const travel = $('replay-track').clientWidth - 16;
    for (const cluster of clusterMarks(replayTimeline.marks.filter(mark => mark.tick <= end), end, travel)) {
      const pip = document.createElement('button'), left = `calc(8px + (100% - 16px) * ${cluster.tick / end})`;
      pip.style.left = left;
      if (cluster.marks.length === 1) {
        const [mark] = cluster.marks;
        pip.className = `mark-${mark.kind}`; pip.title = pip.ariaLabel = markLabel(mark);
        pip.onclick = () => chooseMark(mark);
      } else {
        pip.className = 'mark-cluster'; pip.textContent = String(cluster.marks.length);
        pip.title = pip.ariaLabel = `${cluster.marks.length} marks near tick ${cluster.tick}`;
        pip.onclick = () => openMarkMenu(cluster, left);
      }
      layer.append(pip);
    }
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
      // The roster comes from the recording rather than the displayed frame, so a subject can be
      // chosen before they appear and stays selectable after they are eliminated.
      fillFollowOptions($('replay-focus'), timeline.roster); director.reset(); setFollow(null); renderMarks();
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
    replay = null; replayTimeline = null; director.reset(); $('replay-marks').replaceChildren();
    $('replay-controls').hidden = true; $('live-hud').hidden = false; document.body.classList.remove('replaying');
    const liveMap = getLiveMap(), liveState = getLiveState();
    if (liveMap && liveState) { changeMap(liveMap); acceptState(liveState); }
    connection(liveConnectionLabel()); getScene()?.updateCamera(true);
  }
  function reset() {
    replay = null; replayTimeline = null; $('replay-marks').replaceChildren();
    document.body.classList.remove('replaying'); $('replay-controls').hidden = true;
  }
  // The track narrows with the viewport and when the status label appears, which changes which pips collide.
  new ResizeObserver(() => { if (replayTimeline) renderMarks(); }).observe($('replay-track'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('replay-mark-menu').hidden) { closeMarkMenu(); event.stopPropagation(); } }, true);
  $('replay-play').onclick = () => { if (replay && playback >= replayTimeline.endTick) seek(0); setPlaying(!playing); };
  $('replay-seek').oninput = () => { if (replay) seek(Number($('replay-seek').value)); };
  // Without re-anchoring, the time already elapsed would be re-scaled by the new rate and jump.
  $('replay-speed').onchange = () => { if (replay) anchorPlayback(); };
  $('replay-focus').onchange = () => { if (replay) setFollow($('replay-focus').value); };
  $('replay-download').onclick = () => { if (replay) void downloadReplay(replay.id); };
  $('replay-close').onclick = close;
  return {
    active: () => !!replay, frameAlpha: () => replayTimeline?.at(playback)?.alpha ?? 0,
    watch, renderFrame, togglePlay: () => setPlaying(!playing), reset,
    // Lets the application skip a refetch when downloading the replay already open here.
    cachedData: id => replay?.id === id ? replay : null,
  };
}
