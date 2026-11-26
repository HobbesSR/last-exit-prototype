//! The item registry as the core keeps it (#1214, docs/27 "The state flip", step 6e.1; D6).
//!
//! Node's registry (`shared/item-instances.ts`) maps labels to numeric item IDs and back. The rules ask it three
//! things: whether an ID is registered (`itemLabel` succeeds), which `instance-N` labels are taken (so an allocation
//! skips their phases), and each ID's body key (`item:<label>`, interned). The core keeps exactly that: each
//! registered ID with its body key, and the phases of the `instance-N` labels. Node uploads what it registers outside
//! the core (`registry-store.ts`), and the core registers its own allocations itself (`World::register_allocation`).
//! The labels themselves stay in Node, which names them; a body key is all the core needs of one.

use std::collections::{BTreeMap, BTreeSet};

/// Words per uploaded registration: id, the label's phase when it is `instance-N` (else -1), the body key.
pub const REGISTRATION: usize = 3;

#[derive(Clone, Default)]
pub struct Registry {
    /// Each registered ID, by its bits, with its body key (NaN when Node had none to give).
    keys: BTreeMap<u64, f64>,
    /// The phases of the registered `instance-N` labels: an allocation never takes one.
    reserved: BTreeSet<u64>,
}

impl Registry {
    /// Whether `id` is registered (`itemLabel` would succeed).
    pub fn holds(&self, id: f64) -> bool {
        self.keys.contains_key(&id.to_bits())
    }

    /// The body key of a registered `id`.
    pub fn key(&self, id: f64) -> Option<f64> {
        self.keys.get(&id.to_bits()).copied()
    }

    /// Whether the label `instance-<phase>` is registered.
    pub fn reserved(&self, phase: f64) -> bool {
        phase >= 0.0 && phase.fract() == 0.0 && self.reserved.contains(&(phase as u64))
    }

    /// Register `id`, with its label's phase (-1 for a label that is not `instance-N`) and its body key.
    pub fn insert(&mut self, id: f64, phase: f64, key: f64) {
        self.keys.insert(id.to_bits(), key);
        if phase >= 0.0 && phase.fract() == 0.0 {
            self.reserved.insert(phase as u64);
        }
    }

    /// How many IDs are registered.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Every registration in the upload's layout, in ID order (by bits), for tests that hold it equal to Node's.
    pub fn dump(&self, out: &mut Vec<f64>) {
        for (&bits, &key) in &self.keys {
            out.extend_from_slice(&[f64::from_bits(bits), key]);
        }
        out.push(self.reserved.len() as f64);
        out.extend(self.reserved.iter().map(|&p| p as f64));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrations_answer_ids_keys_and_reserved_phases() {
        let mut r = Registry::default();
        r.insert(7.0, 3.0, 40.0);
        r.insert(9.0, -1.0, 41.0);
        assert!(r.holds(7.0) && r.holds(9.0) && !r.holds(8.0));
        assert_eq!(r.key(9.0), Some(41.0));
        assert!(r.reserved(3.0) && !r.reserved(4.0) && !r.reserved(-1.0));
    }
}
