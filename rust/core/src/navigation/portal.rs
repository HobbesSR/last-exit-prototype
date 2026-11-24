//! Straight-line portal routing and the hunter's persistent corridor (22.6).

use super::{
    geometry::Point,
    search::{QueueEntry, distance},
};
use crate::runtime_map::Graph;
use std::collections::BinaryHeap;

fn region_at(graph: Graph<'_>, point: Point) -> Option<usize> {
    let (cell, cols, rows) = graph.grid();
    let col = (point[0] / cell).floor();
    let row = (point[1] / cell).floor();
    if !col.is_finite()
        || !row.is_finite()
        || col < 0.0
        || row < 0.0
        || col >= cols as f64
        || row >= rows as f64
    {
        return None;
    }
    let owner = graph.owner.i32(row as usize * cols + col as usize);
    (owner >= 0).then_some(owner as usize)
}

#[derive(Clone, Copy)]
struct Node {
    best: f64,
    parent: usize,
    closed: bool,
}

fn relax(
    heap: &mut BinaryHeap<QueueEntry<usize>>,
    nodes: &mut [Node],
    node: usize,
    via: usize,
    g: f64,
    point: Point,
    goal: Point,
) {
    if g >= nodes[node].best {
        return;
    }
    nodes[node].best = g;
    nodes[node].parent = via;
    heap.push(QueueEntry {
        f: g + distance(goal, point),
        g,
        node,
    });
}

/// The ordered portal slots in a straight-reach corridor between two regions.
fn route(
    graph: Graph<'_>,
    from: Point,
    to: Point,
    from_region: usize,
    to_region: usize,
) -> Option<Vec<usize>> {
    let count = graph.portal_count();
    let start = count;
    let goal = count + 1;
    let exits = graph.region(from_region).unwrap().portals;
    let entries = graph.region(to_region).unwrap().portals;
    let mut last = vec![None; count];
    for i in 0..entries.len() {
        let node = entries.u32(i) as usize;
        last[node] = Some(distance(to, graph.portal(node).unwrap().position));
    }
    let mut nodes = vec![
        Node {
            best: f64::INFINITY,
            parent: usize::MAX,
            closed: false
        };
        count + 2
    ];
    let mut heap = BinaryHeap::new();
    nodes[start].best = 0.0;
    nodes[start].closed = true;
    for i in 0..exits.len() {
        let node = exits.u32(i) as usize;
        let point = graph.portal(node).unwrap().position;
        relax(
            &mut heap,
            &mut nodes,
            node,
            start,
            distance(from, point),
            point,
            to,
        );
    }
    while let Some(QueueEntry { node, g, .. }) = heap.pop() {
        if nodes[node].closed || g > nodes[node].best {
            continue;
        }
        nodes[node].closed = true;
        if node == goal {
            break;
        }
        let portal = graph.portal(node).unwrap();
        if let Some(d) = last[node] {
            relax(&mut heap, &mut nodes, goal, node, g + d, to, to);
        }
        for side in 0..2 {
            if side == 1 && portal.regions[1] == portal.regions[0] {
                break;
            }
            let region = graph.region(portal.regions[side]).unwrap();
            for j in 0..region.portals.len() {
                let next = region.portals.u32(j) as usize;
                let point = graph.portal(next).unwrap().position;
                let d = distance(portal.position, point);
                if d != f64::INFINITY && !nodes[next].closed {
                    relax(&mut heap, &mut nodes, next, node, g + d, point, to);
                }
            }
        }
    }
    if !nodes[goal].closed {
        return None;
    }
    let mut portals = Vec::new();
    let mut node = nodes[goal].parent;
    while node != start {
        portals.push(node);
        node = nodes[node].parent;
    }
    portals.reverse();
    Some(portals)
}

/// Owned by one hunter, retained across ticks and cleared when its navigation graph changes.
#[derive(Default)]
pub(crate) struct Corridor {
    goal_region: usize,
    regions: Vec<usize>,
    crossings: Vec<Point>,
    direct: bool,
}

impl Corridor {
    pub(crate) fn leg_goal(
        cache: &mut Option<Self>,
        graph: Option<Graph<'_>>,
        from: Point,
        target: Point,
    ) -> Point {
        let Some(graph) = graph else {
            *cache = None;
            return target;
        };
        let (Some(from_region), Some(to_region)) =
            (region_at(graph, from), region_at(graph, target))
        else {
            *cache = None;
            return target;
        };
        if from_region == to_region {
            *cache = None;
            return target;
        }
        let replan = cache.as_ref().is_none_or(|corridor| {
            corridor.goal_region != to_region
                || (!corridor.direct && !corridor.regions.contains(&from_region))
        });
        if replan {
            let route = route(graph, from, target, from_region, to_region);
            let mut regions = vec![from_region];
            let mut crossings = Vec::new();
            let direct = route.is_none();
            for node in route.into_iter().flatten() {
                let portal = graph.portal(node).unwrap();
                let [a, b] = portal.regions;
                let at = *regions.last().unwrap();
                regions.push(if a == at { b } else { a });
                crossings.push(portal.position);
            }
            *cache = Some(Self {
                goal_region: to_region,
                regions,
                crossings,
                direct,
            });
        }
        let corridor = cache.as_ref().unwrap();
        if corridor.direct {
            return target;
        }
        let at = corridor
            .regions
            .iter()
            .rposition(|&region| region == from_region)
            .unwrap();
        corridor.crossings.get(at + 1).copied().unwrap_or(target)
    }

    pub(crate) fn abandon(cache: &mut Option<Self>) {
        if let Some(corridor) = cache {
            corridor.direct = true;
        }
    }
}
