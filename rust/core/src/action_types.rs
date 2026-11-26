//! Temporary phase-3 records while JavaScript owns match state (27, D1).
//! Item absence bits distinguish missing properties from explicit NaN values.
pub const ABSENT_AMMO: u32 = 1;
pub const ABSENT_CHARGE: u32 = 2;
pub const ABSENT_INSTANCE: u32 = 4;
pub const ABSENT_LINEAGE: u32 = 8;
pub const ABSENT_QUALITY: u32 = 16;
pub const ABSENT_WEAPON: u32 = 32;
#[derive(Clone, Debug)]
pub struct Item {
    pub kind: f64,
    pub weapon: f64,
    pub ammo: f64,
    pub count: f64,
    pub charge: f64,
    pub instance: f64,
    pub lineage: f64,
    pub quality: f64,
    pub token: f64,
    pub absent: u32,
}
impl Item {
    pub fn read(row: &[f64]) -> Self {
        Self {
            kind: row[0],
            weapon: row[1],
            ammo: row[2],
            count: row[3],
            charge: row[4],
            instance: row[5],
            lineage: row[6],
            quality: row[7],
            token: row[8],
            absent: row[9] as u32,
        }
    }
    pub fn row(&self) -> [f64; 10] {
        [
            self.kind,
            self.weapon,
            self.ammo,
            self.count,
            self.charge,
            self.instance,
            self.lineage,
            self.quality,
            self.token,
            f64::from(self.absent),
        ]
    }
    pub fn missing(&self, bit: u32) -> bool {
        self.absent & bit != 0
    }
    pub fn value(&self, bit: u32, field: f64, fallback: f64) -> f64 {
        if self.missing(bit) { fallback } else { field }
    }
}
#[derive(Clone, Debug)]
pub struct Player {
    pub roster: usize,
    pub key: u32,
    pub role: f64,
    pub status: f64,
    pub kit: usize,
    pub x: f64,
    pub y: f64,
    pub heading: f64,
    pub hp: f64,
    pub max_hp: f64,
    pub shield: f64,
    pub selected: f64,
    pub weapon: f64,
    pub attack_cd: f64,
    pub cooldown: f64,
    pub cloak: f64,
    pub revealed: f64,
    pub boost: f64,
    pub stun: f64,
    pub level: f64,
    pub inventory: Option<Vec<Option<Item>>>,
    pub reserves: Option<[f64; 3]>,
    pub reload: Option<[f64; 3]>,
    pub retired: Vec<Item>,
}
#[derive(Clone, Debug)]
pub struct Weapon {
    pub ammo: f64,
    pub max_ammo: f64,
    pub cooldown: f64,
    pub speed: f64,
    pub life: f64,
    pub damage: f64,
    pub spread: Vec<f64>,
    /// family, magazine, reload ticks; absent without L2 content.
    pub reload: Option<[f64; 3]>,
    pub hearing: f64,
}
#[derive(Clone, Debug)]
pub struct Rules {
    pub weapons: Vec<Weapon>,
    pub ground_capacity: f64,
    pub reloading: bool,
    pub quality_damage: Vec<f64>,
    pub kit_cooldown: Vec<f64>,
    pub acceleration: f64,
    pub braking: f64,
    pub surfaces: Vec<[f64; 7]>,
    pub loot_radius: f64,
    pub hearing_ticks: f64,
    pub discovery_cell: f64,
    pub map_width: f64,
    pub map_height: f64,
    pub hook_cooldown: f64,
    pub hz: f64,
    /// contestant, gladiator, their boosts, stun, sneak: movement.ts owns these values.
    pub movement: [f64; 6],
    /// health restored, shield restored, shield cap: action-records.ts owns these values.
    pub utility: [f64; 3],
}
pub const MAX_SAFE: f64 = 9007199254740991.0;
pub fn safe(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE
}
pub fn present(n: f64, fallback: f64) -> f64 {
    if n.is_nan() { fallback } else { n }
}
pub fn truthy(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}
