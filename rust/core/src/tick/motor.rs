//! Pure character motor intent and floor-surface selection (27.2 R4, 29.1).
use super::{ActorKind, Motor, Point};
use crate::math::{hypot, js_max};
use std::cmp::Ordering;

#[derive(Clone, Debug)]
pub struct MotorTuning {
    pub base_speed: [f64; 2],
    pub boost: [f64; 2],
    pub stun: f64,
    pub sneak: f64,
    pub acceleration: f64,
    pub braking: f64,
}

#[derive(Clone, Debug)]
pub struct MotorSurface {
    pub id: String,
    pub priority: f64,
    pub origin: Point,
    pub size: Point,
    pub speed: f64,
    pub traction: f64,
    pub braking: f64,
    pub drag: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
pub struct MotorInput {
    pub kind: ActorKind,
    pub position: Point,
    pub axes: Point,
    pub boosted: bool,
    pub stunned: bool,
    pub sneak: bool,
}

pub(super) fn surface_order(a: &MotorSurface, b: &MotorSurface) -> Ordering {
    b.priority
        .partial_cmp(&a.priority)
        .expect("finite surface priority")
        .then_with(|| a.id.encode_utf16().cmp(b.id.encode_utf16()))
}

/// Surfaces and tuning are validated at content ingestion; ties use authored IDs.
pub fn motor<'a>(
    tuning: &MotorTuning,
    surfaces: impl IntoIterator<Item = &'a MotorSurface>,
    input: MotorInput,
) -> Motor {
    let role = match input.kind {
        ActorKind::Contestant => 0,
        ActorKind::Gladiator => 1,
    };
    let mut speed = tuning.base_speed[role];
    if input.boosted {
        speed *= tuning.boost[role];
    }
    if input.stunned {
        speed *= tuning.stun;
    }
    if input.sneak && input.kind == ActorKind::Contestant {
        speed *= tuning.sneak;
    }
    let surface = surfaces
        .into_iter()
        .filter(|s| {
            input.position[0] >= s.origin[0]
                && input.position[0] < s.origin[0] + s.size[0]
                && input.position[1] >= s.origin[1]
                && input.position[1] < s.origin[1] + s.size[1]
        })
        .min_by(|a, b| surface_order(a, b));
    let [x, y] = input.axes;
    let length = js_max(1.0, hypot(x, y));
    let scale = surface.map_or(1.0, |s| s.speed);
    let acceleration = if x != 0.0 || y != 0.0 {
        tuning.acceleration * surface.map_or(1.0, |s| s.traction)
    } else {
        tuning.braking * surface.map_or(1.0, |s| s.braking)
    };
    Motor {
        velocity: [x / length * speed * scale, y / length * speed * scale],
        acceleration,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tuning() -> MotorTuning {
        MotorTuning {
            base_speed: [100.0, 200.0],
            boost: [2.0, 3.0],
            stun: 0.5,
            sneak: 0.25,
            acceleration: 40.0,
            braking: 20.0,
        }
    }

    fn input() -> MotorInput {
        MotorInput {
            kind: ActorKind::Contestant,
            position: [0.0, 0.0],
            axes: [0.5, 0.0],
            boosted: true,
            stunned: true,
            sneak: true,
        }
    }

    #[test]
    fn modifiers_and_analog_normalization() {
        let result = motor(&tuning(), &[], input());
        assert_eq!(result.velocity, [12.5, 0.0]);
        assert_eq!(result.acceleration, 40.0);
        let result = motor(
            &tuning(),
            &[],
            MotorInput {
                kind: ActorKind::Gladiator,
                axes: [3.0, 4.0],
                ..input()
            },
        );
        assert_eq!(result.velocity, [180.0, 240.0]);
    }

    #[test]
    fn overlap_priority_id_braking_and_half_open_edges() {
        let surface = |id: &str, priority, speed, traction, braking| MotorSurface {
            id: id.into(),
            priority,
            origin: [0.0, 0.0],
            size: [10.0, 10.0],
            speed,
            traction,
            braking,
            drag: None,
        };
        let surfaces = [
            surface("z", 2.0, 0.8, 0.8, 0.8),
            surface("a", 2.0, 0.5, 0.25, 0.1),
            surface("low", 1.0, 0.1, 0.1, 0.1),
        ];
        let moving = motor(&tuning(), &surfaces, input());
        assert_eq!(moving.velocity, [6.25, 0.0]);
        assert_eq!(moving.acceleration, 10.0);
        let stopped = motor(
            &tuning(),
            &surfaces,
            MotorInput {
                axes: [0.0, 0.0],
                ..input()
            },
        );
        assert_eq!(stopped.acceleration, 2.0);
        for position in [[10.0, 0.0], [0.0, 10.0]] {
            assert_eq!(
                motor(
                    &tuning(),
                    &surfaces,
                    MotorInput {
                        position,
                        ..input()
                    }
                )
                .acceleration,
                40.0
            );
        }
    }

    /// The table the prediction motor's TypeScript test reads too (`tests/physics-prediction-contract.test.js`):
    /// the core's `motor` answers every row, and a unit axis reads back each row's speed.
    #[test]
    fn motor_matches_the_parity_table() {
        let table = include_str!("../../../../tests/fixtures/motor-parity.txt");
        let numbers = |fields: &[&str]| -> Vec<f64> {
            fields
                .iter()
                .map(|f| f.parse().expect("a number"))
                .collect()
        };
        let mut tuning = None;
        let mut surfaces = Vec::new();
        let mut rows = 0;
        for line in table
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
        {
            let f: Vec<&str> = line.split_whitespace().collect();
            match f[0] {
                "tuning" => {
                    let n = numbers(&f[1..]);
                    tuning = Some(MotorTuning {
                        base_speed: [n[0], n[1]],
                        boost: [n[2], n[3]],
                        stun: n[4],
                        sneak: n[5],
                        acceleration: n[6],
                        braking: n[7],
                    });
                }
                "surface" => {
                    let n = numbers(&f[2..]);
                    surfaces.push(MotorSurface {
                        id: f[1].into(),
                        priority: n[0],
                        origin: [n[1], n[2]],
                        size: [n[3], n[4]],
                        speed: n[5],
                        traction: n[6],
                        braking: n[7],
                        drag: None,
                    });
                }
                "row" => {
                    let n = numbers(&f[2..]);
                    let input = MotorInput {
                        kind: match f[1] {
                            "contestant" => ActorKind::Contestant,
                            _ => ActorKind::Gladiator,
                        },
                        position: [n[5], n[6]],
                        axes: [n[3], n[4]],
                        boosted: n[0] != 0.0,
                        stunned: n[1] != 0.0,
                        sneak: n[2] != 0.0,
                    };
                    let tuning = tuning.as_ref().expect("tuning precedes rows");
                    let got = motor(tuning, &surfaces, input);
                    assert_eq!(
                        (got.velocity, got.acceleration),
                        ([n[8], n[9]], n[10]),
                        "{line}"
                    );
                    let unit = MotorInput {
                        axes: [1.0, 0.0],
                        ..input
                    };
                    assert_eq!(motor(tuning, &[], unit).velocity[0], n[7], "speed: {line}");
                    rows += 1;
                }
                other => panic!("unknown record {other}"),
            }
        }
        assert_eq!(rows, 64);
    }
}
