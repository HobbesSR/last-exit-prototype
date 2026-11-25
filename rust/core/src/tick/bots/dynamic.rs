//! Local, visibility-limited avoidance around actors and pushable props.
use super::Context;
use crate::collision::CollisionMap;
use crate::math::distance;
use crate::swept::{Shape, segment_shape_distance};
use crate::tick::{ActorId, ActorKind, Point, Presence};

const RANGE: f64 = 192.0;
const MARGIN: f64 = 2.0;
const EDGES_PER_BOT: usize = 192;
const EDGES_PER_TICK: usize = 1536;

fn origin(shape: &Shape) -> Point {
    match shape {
        Shape::Circle { x, y, .. } | Shape::Rect { x, y, .. } | Shape::Polygon { x, y, .. } => {
            [*x, *y]
        }
    }
}
struct Body {
    shape: Shape,
    actor: bool,
}
struct Saved {
    goal: Point,
    last: Point,
    route: Vec<Point>,
    generation: u64,
}
#[derive(Default)]
pub(super) struct Detour {
    saved: Option<Saved>,
}

fn clear_bodies(bodies: &[Body], a: Point, b: Point, radius: f64, actors_only: bool) -> bool {
    let left = a[0].min(b[0]) - radius - MARGIN;
    let right = a[0].max(b[0]) + radius + MARGIN;
    let top = a[1].min(b[1]) - radius - MARGIN;
    let bottom = a[1].max(b[1]) + radius + MARGIN;
    bodies.iter().all(|body| {
        if actors_only && !body.actor {
            return true;
        }
        let [x, y, w, h] = body.shape.bounds();
        if x > right || y > bottom || x + w < left || y + h < top {
            return true;
        }
        let gap = segment_shape_distance(a, b, &body.shape);
        if gap >= radius + MARGIN {
            return true;
        }
        let start = segment_shape_distance(a, a, &body.shape);
        start > 0.0
            && start < radius + MARGIN
            && gap >= start - 0.001
            && segment_shape_distance(b, b, &body.shape) > start + 0.001
    })
}
fn known_segment(ctx: &Context<'_>, id: ActorId, a: Point, b: Point, radius: f64) -> bool {
    if id.kind == ActorKind::Gladiator {
        return true;
    }
    let Some(memory) = ctx.memory.get(&id) else {
        return true;
    };
    let crate::navigation::Grid {
        size, cols, rows, ..
    } = ctx.grid();
    let left = (((a[0].min(b[0]) - radius) / size).floor() as isize - 1).max(0);
    let right = (((a[0].max(b[0]) + radius) / size).floor() as isize + 1).min(cols as isize - 1);
    let top = (((a[1].min(b[1]) - radius) / size).floor() as isize - 1).max(0);
    let bottom = (((a[1].max(b[1]) + radius) / size).floor() as isize + 1).min(rows as isize - 1);
    for y in top..=bottom {
        for x in left..=right {
            if !memory
                .surveyed
                .contains(&((y as usize * cols + x as usize) as u32))
            {
                return false;
            }
        }
    }
    true
}
pub(super) struct Waypoint {
    pub(super) pos: Point,
    pub(super) destination: Point,
    pub(super) route_generation: u64,
}

impl Detour {
    pub(super) fn waypoint(
        &mut self,
        ctx: &Context<'_>,
        collision: Option<&CollisionMap>,
        id: ActorId,
        idx: usize,
        waypoint: Waypoint,
        edges: &mut usize,
    ) -> Point {
        let Waypoint {
            pos,
            destination,
            route_generation,
        } = waypoint;
        let mut bodies = Vec::new();
        for &other in ctx.lexical {
            if other == id
                || !ctx
                    .view
                    .state
                    .actors
                    .get(&other)
                    .is_some_and(|a| a.presence == Presence::Active)
            {
                continue;
            }
            let Some(at) = ctx.point(other) else {
                continue;
            };
            if distance(pos, at) <= RANGE && ctx.visible(id, other) {
                bodies.push(Body {
                    shape: Shape::Circle {
                        x: at[0],
                        y: at[1],
                        r: ctx.radius(other),
                    },
                    actor: true,
                });
            }
        }
        for shape in &ctx.bodies.solid_props {
            let at = origin(shape);
            if distance(pos, at) <= RANGE && ctx.visible_point(pos, at) {
                bodies.push(Body {
                    shape: shape.clone(),
                    actor: false,
                });
            }
        }
        let radius = ctx.radius(id);
        let length = distance(pos, destination);
        let scale = if length > RANGE + 64.0 {
            (RANGE + 64.0) / length
        } else {
            1.0
        };
        let goal = [
            pos[0] + (destination[0] - pos[0]) * scale,
            pos[1] + (destination[1] - pos[1]) * scale,
        ];
        if clear_bodies(&bodies, pos, goal, radius, false) {
            self.saved = None;
            return destination;
        }
        let advance = || {
            if clear_bodies(&bodies, pos, goal, radius, true) {
                return destination;
            }
            let (mut low, mut high) = (0.0, 1.0);
            for _ in 0..14 {
                let t = (low + high) / 2.0;
                let point = [
                    pos[0] + (goal[0] - pos[0]) * t,
                    pos[1] + (goal[1] - pos[1]) * t,
                ];
                if clear_bodies(&bodies, pos, point, radius, true) {
                    low = t;
                } else {
                    high = t;
                }
            }
            [
                pos[0] + (goal[0] - pos[0]) * low,
                pos[1] + (goal[1] - pos[1]) * low,
            ]
        };
        let clear = |a, b| {
            clear_bodies(&bodies, a, b, radius, false)
                && known_segment(ctx, id, a, b, radius)
                && ctx.swept_clear(collision, Some(id), a, b, radius)
        };
        if let Some(old) = &mut self.saved
            && old.generation == route_generation
            && distance(old.last, pos) < 64.0
            && distance(old.goal, destination) < 24.0
        {
            while old.route.first().is_some_and(|&p| distance(pos, p) < 3.0) {
                old.route.remove(0);
            }
            if let Some(&next) = old.route.first()
                && clear(pos, next)
            {
                old.last = pos;
                return next;
            }
        }
        self.saved = None;
        if !(ctx.view.tick as usize + idx).is_multiple_of(4) {
            return advance();
        }
        let mut nodes = vec![pos, goal];
        let mut nearest: Vec<_> = bodies.iter().collect();
        nearest.sort_by(|a, b| {
            distance(pos, origin(&a.shape)).total_cmp(&distance(pos, origin(&b.shape)))
        });
        for body in nearest.into_iter().take(8) {
            let [x, y, w, h] = body.shape.bounds();
            let pad = radius + MARGIN + 1.0;
            for px in [x - pad, x + w + pad] {
                for py in [y - pad, y + h + pad] {
                    let point = [px, py];
                    if distance(pos, point) <= RANGE + 64.0 {
                        nodes.push(point);
                    }
                }
            }
        }
        let mut costs = vec![f64::INFINITY; nodes.len()];
        let mut parents = vec![0; nodes.len()];
        let mut closed = vec![false; nodes.len()];
        costs[0] = 0.0;
        let mut used = 0;
        loop {
            let mut at = None;
            for i in 0..nodes.len() {
                if !closed[i] && costs[i].is_finite() && at.is_none_or(|j| costs[i] < costs[j]) {
                    at = Some(i);
                }
            }
            let Some(at) = at else {
                break;
            };
            if at == 1 {
                let mut route = Vec::new();
                let mut i = 1;
                while i != 0 {
                    route.push(nodes[i]);
                    i = parents[i];
                }
                route.reverse();
                let next = route[0];
                self.saved = Some(Saved {
                    goal: destination,
                    last: pos,
                    route,
                    generation: route_generation,
                });
                return next;
            }
            closed[at] = true;
            for i in 1..nodes.len() {
                let candidate = costs[at] + distance(nodes[at], nodes[i]);
                if closed[i] || candidate >= costs[i] {
                    continue;
                }
                if used >= EDGES_PER_BOT || *edges >= EDGES_PER_TICK {
                    return advance();
                }
                used += 1;
                *edges += 1;
                if clear(nodes[at], nodes[i]) {
                    costs[i] = candidate;
                    parents[i] = at;
                }
            }
        }
        advance()
    }
}
