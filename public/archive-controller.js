import { HTTP_ENDPOINT } from '/shared/protocol.ts';
import { downloadJson } from '/download.js';
import { $, time } from '/ui.js';

// The archive dialog: the list of saved broadcasts, playing or downloading one, and the owner's
// "finish recording". It fetches the list and a recording's file; the application decides what watching
// one means and sends the finish itself.
export function createArchiveController({ fetchJSON, watch, cachedReplay, canFinish, finish, clearInput, toast, icon, icons }) {
  async function load() {
    $('replay-list').textContent = 'Loading broadcasts...';
    $('finish-recording').hidden = !canFinish();
    try {
      const list = await fetchJSON(HTTP_ENDPOINT.REPLAYS); $('replay-list').replaceChildren();
      if (!list.length) { const p = document.createElement('p'); p.className = 'empty-archive'; p.textContent = 'No completed broadcasts yet.'; $('replay-list').append(p); }
      for (const r of list) {
        const row = document.createElement('div'); row.className = 'replay-row';
        const details = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `Arena ${r.seed}${r.recording?.complete === false ? ' · PARTIAL' : ''}`;
        const sub = document.createElement('small'); sub.textContent = `${time(r.ticks)} / ${r.escaped} escaped / ${new Date(r.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        details.append(title, sub); const actions = document.createElement('div');
        const play = document.createElement('button'); play.className = 'icon-button'; play.ariaLabel = `Play arena ${r.seed}`; play.innerHTML = icon('play'); play.onclick = () => watch(r.id);
        const save = document.createElement('button'); save.className = 'icon-button'; save.ariaLabel = `Download arena ${r.seed}`; save.innerHTML = icon('download'); save.onclick = () => download(r.id);
        actions.append(play, save); row.append(details, actions); $('replay-list').append(row);
      }
      icons();
    } catch (error) { $('replay-list').textContent = error.message; }
  }
  /** Saves a recording as a file: the open replay's own copy when it has one, else fetched by id. */
  async function download(id) {
    try {
      const data = cachedReplay(id) || await fetchJSON(`${HTTP_ENDPOINT.REPLAYS}/${id}`);
      downloadJson(`last-exit-${id}.json`, data);
    } catch (error) { toast(error.message); }
  }
  $('archive').onclick = () => { clearInput(); $('archive-dialog').showModal(); void load(); };
  $('finish-recording').onclick = () => { if (finish()) $('finish-recording').disabled = true; };
  return {
    download,
    /** A recording was just saved: an open list shows it. */
    refresh() { if ($('archive-dialog').open) void load(); },
    /** A new connection may finish its own recording. */
    reset() { $('finish-recording').disabled = false; },
  };
}
