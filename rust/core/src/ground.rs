//! The ground as the core keeps it (#1214, docs/27 "The state flip", step 6d).
//!
//! One store per world: each ground record's rule fields, in the list's order. Stage 6d.1 keeps it current. Node's
//! ground helpers (`shared/simulation/ground-items.ts`) write each change through as they make it (`add`, `remove`,
//! `replace`), and the adapter uploads the whole list only when Node changed it without them, as match setup and
//! tests may (`shared/simulation/ground-store.ts`). So a tick costs only its own changes, never the map's size. The
//! readers still pack the records they need until 6d.2.

use std::collections::BTreeSet;

/// Words per record, uploaded and dumped alike: id, the body's world key (`item:<label>`, whose order is the labels'),
/// x, y, kind (`ITEM_KINDS`, -2 unknown), weapon type (`WEAPONS`, NaN absent), ammo, count, charge, ammo family
/// (`AMMO_FAMILIES`, -1 absent), instance, lineage, quality, the dropper's roster index (-1 another player, -2
/// absent), `pickupAfter`, and the absence mask of the optional fields.
pub const RECORD: usize = 16;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Record {
    pub(crate) words: [f64; RECORD],
}

#[derive(Default)]
pub struct Ground {
    /// The records, in the list's order.
    pub(crate) records: Vec<Record>,
    /// The records' body keys, for the body sync's question of which item bodies left the ground (6d.2).
    keys: BTreeSet<u64>,
    input: Vec<f64>,
}

/// A record's body key, when its label is known.
fn key_of(r: &Record) -> Option<u64> {
    let key = r.words[1];
    (key.is_finite() && key >= 0.0).then_some(key as u64)
}

impl Ground {
    /// The input buffer, resized for `count` records.
    pub fn input(&mut self, count: usize) -> &mut [f64] {
        self.input.resize(count * RECORD, 0.0);
        &mut self.input
    }

    fn rows(&self) -> impl Iterator<Item = Record> + '_ {
        self.input
            .as_chunks::<RECORD>()
            .0
            .iter()
            .map(|&words| Record { words })
    }

    /// Replace the store with the input's records.
    pub fn load(&mut self) {
        self.records = self.rows().collect();
        self.keys = self.records.iter().filter_map(key_of).collect();
    }

    /// Whether a record with this body key is on the ground.
    pub(crate) fn holds(&self, key: u64) -> bool {
        self.keys.contains(&key)
    }

    /// Append the input's records, as `addItems` appends them.
    pub fn add(&mut self) {
        let added: Vec<Record> = self.rows().collect();
        self.keys.extend(added.iter().filter_map(key_of));
        self.records.extend(added);
    }

    /// Take the record at `at` off, as `removeItem` does; later records keep their order.
    pub fn remove(&mut self, at: usize) {
        assert!(at < self.records.len(), "no ground record {at}");
        let gone = self.records.remove(at);
        if let Some(key) = key_of(&gone) {
            self.keys.remove(&key);
        }
    }

    /// Put the input's one record where the record at `at` is, as `replaceItem` does.
    pub fn replace(&mut self, at: usize) {
        assert!(at < self.records.len(), "no ground record {at}");
        let record = self.rows().next().expect("one record");
        if let Some(key) = key_of(&self.records[at]) {
            self.keys.remove(&key);
        }
        self.keys.extend(key_of(&record));
        self.records[at] = record;
    }

    /// The store in the upload's layout, written into the input buffer, for tests that hold it equal to the list.
    pub fn dump(&mut self) -> &[f64] {
        let mut words = std::mem::take(&mut self.input);
        words.clear();
        for r in &self.records {
            words.extend_from_slice(&r.words);
        }
        self.input = words;
        &self.input
    }

    /// How many records the store holds.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// Whether the store holds no record.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(ground: &mut Ground, ids: &[f64]) {
        let input = ground.input(ids.len());
        for (k, &id) in ids.iter().enumerate() {
            input[k * RECORD] = id;
        }
    }

    #[test]
    fn writes_follow_the_list_helpers() {
        let mut ground = Ground::default();
        rows(&mut ground, &[1.0, 2.0, 3.0]);
        ground.load();
        rows(&mut ground, &[4.0]);
        ground.add();
        ground.remove(1);
        rows(&mut ground, &[9.0]);
        ground.replace(0);
        let ids: Vec<f64> = ground.records.iter().map(|r| r.words[0]).collect();
        assert_eq!(ids, vec![9.0, 3.0, 4.0]);
        assert_eq!(ground.dump().len(), 3 * RECORD);
    }
}
