//! The ground as the core keeps it (#1214, docs/27 "The state flip", step 6d).
//!
//! One store per world: each ground record's rule fields, in the list's order. Stage 6d.1 keeps it current. Node's
//! ground helpers (`shared/simulation/ground-items.ts`) write each change through as they make it (`add`, `remove`,
//! `replace`), and the adapter uploads the whole list only when Node changed it without them, as match setup and
//! tests may (`shared/simulation/ground-store.ts`). So a tick costs only its own changes, never the map's size. The
//! readers still pack the records they need until 6d.2.

use std::collections::BTreeMap;

/// Words per record, uploaded and dumped alike: id, the body's world key (`item:<label>`, whose order is the labels'),
/// x, y, kind (`ITEM_KINDS`, -2 unknown), weapon type (`WEAPONS`, NaN absent), ammo, count, charge, ammo family
/// (`AMMO_FAMILIES`, -1 absent), instance, lineage, quality, the dropper's roster index (-1 another player, -2
/// absent), `pickupAfter`, and the absence mask of the optional fields.
pub const RECORD: usize = 16;
/// A record's position words.
pub const X: usize = 2;
pub const Y: usize = 3;
/// The grid's cell size, in world units: `ground-items.ts`'s fine cells.
const CELL: f64 = 64.0;
/// Cells this far from the origin, or farther, are not kept: such a record is offered to every query, as the
/// JavaScript grid keeps it loose.
const SPAN: f64 = 32768.0;

type Cell = (i64, i64);

fn cell_of(x: f64, y: f64) -> Option<Cell> {
    let (cx, cy) = ((x / CELL).floor(), (y / CELL).floor());
    (cx.abs() < SPAN && cy.abs() < SPAN).then_some((cx as i64, cy as i64))
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Record {
    pub(crate) words: [f64; RECORD],
}

#[derive(Default)]
pub struct Ground {
    /// The records, in the list's order.
    pub(crate) records: Vec<Record>,
    /// The records by body key: which item bodies left the ground (6d.2), and where a waiting item lies (6d.3).
    by_key: BTreeMap<u64, Record>,
    /// The sequence numbers of the records holding each id, by its bits: `groundItem`'s question (6d.6c).
    ids: BTreeMap<u64, Vec<u64>>,
    /// The grid (#1214 stage 6d.6c), as `ground-items.ts` keeps its own: each record's sequence number, in the list's
    /// order, so a query returns records in list order; a replacement keeps its record's number.
    seqs: Vec<u64>,
    by_seq: BTreeMap<u64, Record>,
    cells: BTreeMap<Cell, Vec<u64>>,
    /// Records outside every cell (a position not finite, or far off the map), offered to every query.
    loose: Vec<u64>,
    next: u64,
    input: Vec<f64>,
}

/// A record's body key, when its label is known.
fn key_of(r: &Record) -> Option<u64> {
    let key = r.words[1];
    (key.is_finite() && key >= 0.0).then_some(key as u64)
}

impl Ground {
    fn enter(&mut self, seq: u64, record: Record) {
        match cell_of(record.words[X], record.words[Y]) {
            Some(cell) => self.cells.entry(cell).or_default().push(seq),
            None => self.loose.push(seq),
        }
        self.by_seq.insert(seq, record);
        self.ids
            .entry(record.words[0].to_bits())
            .or_default()
            .push(seq);
        if let Some(key) = key_of(&record) {
            self.by_key.insert(key, record);
        }
    }

    fn leave(&mut self, seq: u64) {
        let record = self.by_seq.remove(&seq).expect("a held record");
        let bucket = match cell_of(record.words[X], record.words[Y]) {
            Some(cell) => self.cells.get_mut(&cell).expect("its cell"),
            None => &mut self.loose,
        };
        let at = bucket
            .iter()
            .position(|&s| s == seq)
            .expect("in its bucket");
        bucket.swap_remove(at);
        let id = record.words[0].to_bits();
        if let Some(seqs) = self.ids.get_mut(&id) {
            seqs.retain(|&s| s != seq);
            if seqs.is_empty() {
                self.ids.remove(&id);
            }
        }
        if let Some(key) = key_of(&record) {
            self.by_key.remove(&key);
        }
    }

    fn push(&mut self, record: Record) {
        let seq = self.next;
        self.next += 1;
        self.seqs.push(seq);
        self.records.push(record);
        self.enter(seq, record);
    }

    /// Every record that could be within `reach` of `(x, y)`, in the list's order: a superset, never a ruling, as
    /// `itemsNear` gives it. A point that is not finite is offered the whole list.
    pub(crate) fn near(&self, x: f64, y: f64, reach: f64) -> Vec<Record> {
        self.near_seqs(x, y, reach)
            .into_iter()
            .map(|s| self.by_seq[&s])
            .collect()
    }

    /// `near`'s records by sequence number, in the list's order.
    fn near_seqs(&self, x: f64, y: f64, reach: f64) -> Vec<u64> {
        if !x.is_finite() || !y.is_finite() {
            return self.seqs.clone();
        }
        let mut seqs: Vec<u64> = self.loose.clone();
        match (cell_of(x - reach, y - reach), cell_of(x + reach, y + reach)) {
            (Some((x0, y0)), Some((x1, y1))) => {
                for cx in x0..=x1 {
                    for (_, bucket) in self.cells.range((cx, y0)..=(cx, y1)) {
                        seqs.extend_from_slice(bucket);
                    }
                }
            }
            // A reach that leaves the cells' span reads every cell.
            _ => seqs.extend(self.cells.values().flatten()),
        }
        seqs.sort_unstable();
        seqs.dedup();
        seqs
    }

    /// Whether a record with this id is on the ground (`groundItem`).
    pub(crate) fn holds_id(&self, id: f64) -> bool {
        self.ids.contains_key(&id.to_bits())
    }

    /// Where the record `groundItem` names by this id lies in the list: the last that holds it, as its map keeps the
    /// last, and that record's sequence number.
    pub(crate) fn find_id(&self, id: f64) -> Option<(usize, u64)> {
        let seq = *self.ids.get(&id.to_bits())?.iter().max()?;
        let at = self.seqs.binary_search(&seq).ok()?;
        Some((at, seq))
    }

    /// The record `groundItem` names by this id.
    pub(crate) fn by_id(&self, id: f64) -> Option<Record> {
        self.find_id(id).map(|(at, _)| self.records[at])
    }

    /// `near`, keeping only records whose sequence numbers exceed `after`: those after a removed record in the list.
    pub(crate) fn near_after(&self, x: f64, y: f64, reach: f64, after: u64) -> Vec<Record> {
        self.near_seqs(x, y, reach)
            .into_iter()
            .filter(|&s| s > after)
            .map(|s| self.by_seq[&s])
            .collect()
    }

    /// The input buffer, resized for `count` records.
    pub fn input(&mut self, count: usize) -> &mut [f64] {
        self.input.resize(count * RECORD, 0.0);
        &mut self.input
    }

    /// The input as last filled.
    pub(crate) fn input_words(&self) -> &[f64] {
        &self.input
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
        let rows: Vec<Record> = self.rows().collect();
        self.records.clear();
        self.by_key.clear();
        self.ids.clear();
        self.seqs.clear();
        self.by_seq.clear();
        self.cells.clear();
        self.loose.clear();
        for record in rows {
            self.push(record);
        }
    }

    /// Whether a record with this body key is on the ground.
    pub(crate) fn holds(&self, key: u64) -> bool {
        self.by_key.contains_key(&key)
    }

    /// The record with this body key, if it is on the ground.
    pub(crate) fn by_key(&self, key: u64) -> Option<&Record> {
        self.by_key.get(&key)
    }

    /// The body key of the record at `at`, if its label is known.
    pub(crate) fn key_at(&self, at: usize) -> Option<u64> {
        self.records.get(at).and_then(key_of)
    }

    /// The body keys of the records from position `start` on, in the list's order.
    pub(crate) fn keys_from(&self, start: usize) -> impl Iterator<Item = u64> + '_ {
        self.records[start..].iter().filter_map(key_of)
    }

    /// The body keys of the records, in the list's order.
    pub(crate) fn keys(&self) -> impl Iterator<Item = u64> + '_ {
        self.records.iter().filter_map(key_of)
    }

    /// Append the input's records, as `addItems` appends them.
    pub fn add(&mut self) {
        let added: Vec<Record> = self.rows().collect();
        for record in added {
            self.push(record);
        }
    }

    /// Take the record at `at` off, as `removeItem` does; later records keep their order.
    pub fn remove(&mut self, at: usize) {
        assert!(at < self.records.len(), "no ground record {at}");
        self.records.remove(at);
        let seq = self.seqs.remove(at);
        self.leave(seq);
    }

    /// Put the input's one record where the record at `at` is, as `replaceItem` does.
    pub fn replace(&mut self, at: usize) {
        assert!(at < self.records.len(), "no ground record {at}");
        let record = self.rows().next().expect("one record");
        let seq = self.seqs[at];
        self.leave(seq);
        self.enter(seq, record);
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

    fn put(ground: &mut Ground, rows: &[(f64, f64, f64)]) {
        let input = ground.input(rows.len());
        for (k, &(id, x, y)) in rows.iter().enumerate() {
            input[k * RECORD] = id;
            input[k * RECORD + 1] = f64::NAN;
            input[k * RECORD + X] = x;
            input[k * RECORD + Y] = y;
        }
    }

    fn ids(records: &[Record]) -> Vec<f64> {
        records.iter().map(|r| r.words[0]).collect()
    }

    #[test]
    fn the_grid_answers_in_list_order_and_offers_loose_records_to_every_query() {
        let mut ground = Ground::default();
        put(
            &mut ground,
            &[
                (1.0, 500.0, 500.0),
                (2.0, 10.0, 10.0),
                (3.0, f64::NAN, 0.0),
                (4.0, 40.0, 5.0),
            ],
        );
        ground.load();
        // The far record is not offered; the NaN one is.
        assert_eq!(ids(&ground.near(20.0, 20.0, 30.0)), vec![2.0, 3.0, 4.0]);
        // A replacement keeps its place in the list.
        put(&mut ground, &[(1.0, 15.0, 15.0)]);
        ground.replace(0);
        assert_eq!(
            ids(&ground.near(20.0, 20.0, 30.0)),
            vec![1.0, 2.0, 3.0, 4.0]
        );
        assert_eq!(
            ids(&ground.near(f64::NAN, 0.0, 1.0)),
            vec![1.0, 2.0, 3.0, 4.0]
        );
        // A record far in another row of the same columns is not offered.
        put(&mut ground, &[(5.0, 20.0, 900.0)]);
        ground.add();
        assert_eq!(
            ids(&ground.near(20.0, 20.0, 30.0)),
            vec![1.0, 2.0, 3.0, 4.0]
        );
        ground.remove(1);
        assert_eq!(ids(&ground.near(20.0, 20.0, 30.0)), vec![1.0, 3.0, 4.0]);
        assert!(ground.holds_id(5.0) && !ground.holds_id(2.0));
    }
}
