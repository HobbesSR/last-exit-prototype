// Where this player is now, ahead of the server: the input sequence, the inputs the server has not yet
// acknowledged, and the body they predict. Both matches and the waiting area (#975) carry a physics
// profile and are predicted by the Rapier motor (physics-prediction.js, loaded on first need).
export function createInputPrediction({ getMap, getPlayerId, getState, directed }) {
  let seq = 0, pending = [], predicted;
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
    nextSeq: () => seq++,
    /** Discards the physics world: its map or its view is gone. The next physics frame builds another. */
    resetPhysics,
    /** A new connection: nothing predicted and the sequence from zero. */
    reset() { pending = []; seq = 0; predicted = null; resetPhysics(); },
    /** A new map starts its own ticks, so inputs predicted on the old one do not carry over. */
    forgetInputs() { pending = []; },
    /** There is no own player in the frame shown. */
    abandon() { predicted = null; resetPhysics(); },
    /** Starts again from the server's own position, as when a hidden tab returns. */
    restart(me) { resetPhysics(); predicted = me && { ...me }; },
    /** An authoritative frame for this player: drop what it acknowledged and replay the rest over it. */
    reconcile(frame, me) {
      pending = pending.filter(i => i.seq > me.lastSeq).slice(-20);
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
