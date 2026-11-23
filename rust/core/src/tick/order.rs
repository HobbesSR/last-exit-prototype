use super::state::{ActorId, ActorKind, Tick};

/// Fixed-width SplitMix64 finalizer. Wrapping operations have the same result in every build.
fn mix(mut word: u64) -> u64 {
    word = (word ^ (word >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    word = (word ^ (word >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    word ^ (word >> 31)
}

fn hash(seed: u64, tick: Tick, words: &[u64]) -> u64 {
    let mut value = mix(seed ^ 0x9e37_79b9_7f4a_7c15);
    for word in std::iter::once(u64::from(tick)).chain(words.iter().copied()) {
        value = mix(value ^ word);
    }
    value
}

/// Give each contest its own stable key, including the ID of the contested resource.
/// Compare by (score, canonical ID) so even a hash collision is order independent.
pub fn contest_score(seed: u64, tick: Tick, contest_key: u64, entity_id: u64) -> u64 {
    hash(seed, tick, &[0, contest_key, entity_id])
}

/// Scatter uses its own hash domain and never advances a match RNG.
pub fn scatter_score(
    seed: u64,
    tick: Tick,
    dropper: ActorId,
    slot_or_family: u64,
    copy_index: u32,
) -> u64 {
    hash(
        seed,
        tick,
        &[
            1,
            actor_word(dropper),
            slot_or_family,
            u64::from(copy_index),
        ],
    )
}

pub fn actor_word(actor: ActorId) -> u64 {
    let kind = match actor.kind {
        ActorKind::Contestant => 0,
        ActorKind::Gladiator => 1,
    };
    (kind << 32) | u64::from(actor.seat)
}
