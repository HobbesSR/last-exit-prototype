import { createInputClock } from '/shared/input-clock.ts';

// Where this player is now, ahead of the server: the input sequence, the inputs whose ticks the server
// has not yet run, and the body they predict. Both matches and the waiting area (#975) carry a physics
// profile and are predicted by the Rapier motor (physics-prediction.js, loaded on first need).
export function createInputPrediction({ getMap, getPlayerId, getState, directed, now = () => performance.now() }) {
  let seq = 0, pending = [], predicted;
  // Which tick each input is for, and when the next is due (#1096, 24).
  const clock = createInputClock();
  let physics = null, loading = false, epoch = 0;
  function resetPhysics() {
    epoch++; physics?.dispose(); physics = null; loading = false;
  }
  function correctPhysics(frame) {
    if (physics) { predicted = physics.correct(frame) || predicted; return; }
    if (loading) return;
    loading = true;
    const started = epoch, map = getMap(), id = getPlayerId();
    import('/physics-prediction.js').then(m => m.createPhysicsPrediction(map, id)).then(controller => {
      if (started !== epoch) { controller.dispose(); return; }
      physics = controller; loading = false;
      const state = getState();
      if (state?.physicsProfile && !directed()) {
        predicted = controller.correct(state) || predicted;
        for (const input of pending) predicted = controller.input(input) || predicted;
      }
    }).catch(error => {
      if (started === epoch) {
        // Keep server-driven motion if initialization is unavailable; nothing else predicts a physics match.
        console.error('Physics prediction unavailable', error);
      }
    });
  }
  return {
    /** The predicted player, or nothing while there is no own player to predict. */
    predicted: () => predicted,
    pendingCount: () => pending.length,
    /** The physics motor's counters, or null while no physics path is running. */
    stats: () => physics?.stats() ?? null,
    /**
     * The sequence number and tick stamp for an input sent now, or null while no frame has shown
     * where the server's ticks are. `roundTripMs` is the server's measurement, as its ping reports it.
     */
    stamp(roundTripMs) {
      const tick = clock.stamp(now(), roundTripMs);
      return tick === null ? null : { seq: seq++, tick };
    },
    /** Milliseconds until the next input is due: the clock steers its send rate. */
    sendDelay: () => clock.delay(now()),
    /** The send period and the margins it steers by. */
    clockStats: () => clock.stats(),
    /** Discards the physics world: its map or its view is gone. The next physics frame builds another. */
    resetPhysics,
    /** A new connection: nothing predicted and the sequence from zero. */
    reset() { pending = []; seq = 0; predicted = null; clock.reset(); resetPhysics(); },
    /** A new map starts its own ticks, so neither inputs predicted on the old one nor its clock carry over. */
    forgetInputs() { pending = []; clock.reset(); },
    /** There is no own player in the frame shown. */
    abandon() { predicted = null; resetPhysics(); },
    /** Starts again from the server's own position, as when a hidden tab returns. */
    restart(me) { resetPhysics(); predicted = me && { ...me }; },
    /** An authoritative frame for this player: drop what its tick retired and replay the rest over it. */
    reconcile(frame, me) {
      clock.observe(frame.tick, now(), me.inputMargin);
      // Stamped inputs (#1096): the frame for tick T has spent or discarded everything stamped T or earlier.
      pending = pending.filter(i => i.tick > frame.tick).slice(-20);
      predicted = { ...me };
      if (frame.physicsProfile) correctPhysics(frame);
    },
    /** An input just sent, under the frame it was sent against. */
    apply(input, frame) {
      pending.push(input); pending = pending.slice(-20);
      if (frame.physicsProfile) predicted = physics?.input(input) || predicted;
    },
  };
}
