use crate::ecs::Collider3D;
use crate::ecs::World;
use crate::physics::TileGrid2D;
use glam::Quat;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

#[derive(Copy, Clone, Debug, PartialEq)]
struct HeapItem {
    f_cost: f32,
    idx: usize,
}

impl Eq for HeapItem {}

impl Ord for HeapItem {
    fn cmp(&self, other: &Self) -> Ordering {
        other.f_cost.total_cmp(&self.f_cost).then_with(|| self.idx.cmp(&other.idx))
    }
}

impl PartialOrd for HeapItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub struct NavGrid {
    pub origin_x: f32,
    pub origin_z: f32,
    pub cell_size: f32,
    pub width: usize,
    pub height: usize,
    pub blocked: Vec<u8>,
    g_score: Vec<f32>,
    parent: Vec<i32>,
    closed_gen: Vec<u32>,
    open_gen: Vec<u32>,
    gen_counter: u32,
    heap: BinaryHeap<HeapItem>,
    raw_cells: Vec<usize>,
    pub path_points: Vec<f32>, // interleaved [x0, z0, x1, z1, ...]
}

impl NavGrid {
    pub fn new() -> Self {
        Self {
            origin_x: 0.0,
            origin_z: 0.0,
            cell_size: 1.0,
            width: 0,
            height: 0,
            blocked: Vec::new(),
            g_score: Vec::new(),
            parent: Vec::new(),
            closed_gen: Vec::new(),
            open_gen: Vec::new(),
            gen_counter: 1,
            heap: BinaryHeap::new(),
            raw_cells: Vec::new(),
            path_points: Vec::new(),
        }
    }

    pub fn resize(&mut self, origin_x: f32, origin_z: f32, cell_size: f32, width: usize, height: usize) {
        self.origin_x = origin_x;
        self.origin_z = origin_z;
        self.cell_size = cell_size.max(0.05);
        self.width = width;
        self.height = height;
        let len = width * height;
        self.blocked.clear();
        self.blocked.resize(len, 0);
        self.g_score.resize(len, f32::INFINITY);
        self.parent.resize(len, -1);
        self.closed_gen.resize(len, 0);
        self.open_gen.resize(len, 0);
    }

    #[inline]
    pub fn world_to_cell(&self, x: f32, z: f32) -> (isize, isize) {
        let cx = ((x - self.origin_x) / self.cell_size).floor() as isize;
        let cz = ((z - self.origin_z) / self.cell_size).floor() as isize;
        (cx, cz)
    }

    #[inline]
    pub fn cell_center(&self, cx: usize, cz: usize) -> (f32, f32) {
        (
            self.origin_x + (cx as f32 + 0.5) * self.cell_size,
            self.origin_z + (cz as f32 + 0.5) * self.cell_size,
        )
    }

    #[inline]
    pub fn is_blocked(&self, cx: isize, cz: isize) -> bool {
        if cx < 0 || cz < 0 {
            return true;
        }
        let (ux, uz) = (cx as usize, cz as usize);
        if ux >= self.width || uz >= self.height {
            return true;
        }
        self.blocked[uz * self.width + ux] != 0
    }

    pub fn set_blocked(&mut self, cx: isize, cz: isize, blocked: bool) {
        if cx < 0 || cz < 0 {
            return;
        }
        let (ux, uz) = (cx as usize, cz as usize);
        if ux < self.width && uz < self.height {
            self.blocked[uz * self.width + ux] = if blocked { 1 } else { 0 };
        }
    }

    pub fn build_from_tile_grid_2d(&mut self, grid: &TileGrid2D) {
        self.resize(grid.origin.x, grid.origin.y, grid.tile_size, grid.width, grid.height);
        let len = self.blocked.len().min(grid.solid.len());
        self.blocked[..len].copy_from_slice(&grid.solid[..len]);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_from_world_3d(
        &mut self,
        world: &World,
        origin_x: f32,
        origin_z: f32,
        cell_size: f32,
        width: usize,
        height: usize,
        min_y: f32,
        max_y: f32,
        agent_radius: f32,
    ) {
        self.resize(origin_x, origin_z, cell_size, width, height);
        let pad = agent_radius.max(0.0);

        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            if let Some(rb) = world.rigid_bodies[i] {
                if rb.dynamic || rb.is_trigger {
                    continue;
                }
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let pos = world.curr_pos[i];
            let rot = world.curr_rot[i];
            let (hx, hy, hz) = collider_world_extents(col, rot);
            // Skip ground slabs strictly below obstacle band
            if pos.y + hy <= min_y || pos.y - hy >= max_y {
                continue;
            }
            let min_c = self.world_to_cell(pos.x - hx - pad, pos.z - hz - pad);
            let max_c = self.world_to_cell(pos.x + hx + pad, pos.z + hz + pad);
            let x0 = min_c.0.max(0) as usize;
            let z0 = min_c.1.max(0) as usize;
            let x1 = (max_c.0.min(self.width as isize - 1)).max(0) as usize;
            let z1 = (max_c.1.min(self.height as isize - 1)).max(0) as usize;
            for cz in z0..=z1 {
                for cx in x0..=x1 {
                    self.blocked[cz * self.width + cx] = 1;
                }
            }
        }
    }

    fn nearest_walkable(&self, cx: isize, cz: isize) -> Option<(usize, usize)> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        let clamped_x = cx.clamp(0, self.width as isize - 1);
        let clamped_z = cz.clamp(0, self.height as isize - 1);
        if !self.is_blocked(clamped_x, clamped_z) {
            return Some((clamped_x as usize, clamped_z as usize));
        }
        for r in 1isize..=4 {
            for dz in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dz.abs() != r {
                        continue;
                    }
                    if !self.is_blocked(clamped_x + dx, clamped_z + dz) {
                        return Some(((clamped_x + dx) as usize, (clamped_z + dz) as usize));
                    }
                }
            }
        }
        None
    }

    pub fn has_line_of_sight_cells(&self, mut x0: isize, mut z0: isize, x1: isize, z1: isize) -> bool {
        let dx = (x1 - x0).abs();
        let dz = (z1 - z0).abs();
        let sx = if x0 < x1 { 1 } else { -1 };
        let sz = if z0 < z1 { 1 } else { -1 };
        let mut err = dx - dz;
        loop {
            if self.is_blocked(x0, z0) {
                return false;
            }
            if x0 == x1 && z0 == z1 {
                return true;
            }
            let e2 = 2 * err;
            if e2 > -dz {
                err -= dz;
                x0 += sx;
            }
            if e2 < dx {
                err += dx;
                z0 += sz;
            }
            // Extra check on diagonal steps to prevent clipping corners
            if e2 > -dz && e2 < dx && (self.is_blocked(x0 - sx, z0) || self.is_blocked(x0, z0 - sz)) {
                return false;
            }
        }
    }

    pub fn find_path(&mut self, start_x: f32, start_z: f32, goal_x: f32, goal_z: f32, smooth: bool) -> usize {
        self.path_points.clear();
        if self.width == 0 || self.height == 0 {
            return 0;
        }
        let s_raw = self.world_to_cell(start_x, start_z);
        let g_raw = self.world_to_cell(goal_x, goal_z);
        let (Some((sx, sz)), Some((gx, gz))) = (self.nearest_walkable(s_raw.0, s_raw.1), self.nearest_walkable(g_raw.0, g_raw.1)) else {
            return 0;
        };

        let start_idx = sz * self.width + sx;
        let goal_idx = gz * self.width + gx;
        if start_idx == goal_idx {
            let (px, pz) = self.cell_center(gx, gz);
            self.path_points.extend_from_slice(&[px, pz]);
            return 1;
        }

        self.gen_counter = self.gen_counter.wrapping_add(1);
        if self.gen_counter == 0 {
            self.closed_gen.fill(0);
            self.open_gen.fill(0);
            self.gen_counter = 1;
        }
        let gen = self.gen_counter;
        self.heap.clear();

        self.g_score[start_idx] = 0.0;
        self.parent[start_idx] = -1;
        self.open_gen[start_idx] = gen;
        self.heap.push(HeapItem {
            f_cost: octile(sx, sz, gx, gz),
            idx: start_idx,
        });

        let mut found = false;
        const DIRS: [(isize, isize, f32); 8] = [
            (1, 0, 1.0),
            (-1, 0, 1.0),
            (0, 1, 1.0),
            (0, -1, 1.0),
            (1, 1, std::f32::consts::SQRT_2),
            (-1, 1, std::f32::consts::SQRT_2),
            (1, -1, std::f32::consts::SQRT_2),
            (-1, -1, std::f32::consts::SQRT_2),
        ];

        while let Some(cur) = self.heap.pop() {
            if self.closed_gen[cur.idx] == gen {
                continue;
            }
            if cur.idx == goal_idx {
                found = true;
                break;
            }
            self.closed_gen[cur.idx] = gen;
            let cx = (cur.idx % self.width) as isize;
            let cz = (cur.idx / self.width) as isize;
            let cur_g = self.g_score[cur.idx];

            for (dx, dz, step_cost) in DIRS {
                let nx = cx + dx;
                let nz = cz + dz;
                if self.is_blocked(nx, nz) {
                    continue;
                }
                if dx != 0 && dz != 0 && (self.is_blocked(cx + dx, cz) || self.is_blocked(cx, cz + dz)) {
                    continue;
                }
                let n_idx = (nz as usize) * self.width + (nx as usize);
                if self.closed_gen[n_idx] == gen {
                    continue;
                }
                let cand_g = cur_g + step_cost;
                if self.open_gen[n_idx] != gen || cand_g < self.g_score[n_idx] {
                    self.g_score[n_idx] = cand_g;
                    self.parent[n_idx] = cur.idx as i32;
                    self.open_gen[n_idx] = gen;
                    self.heap.push(HeapItem {
                        f_cost: cand_g + octile(nx as usize, nz as usize, gx, gz),
                        idx: n_idx,
                    });
                }
            }
        }

        if !found {
            return 0;
        }

        self.raw_cells.clear();
        let mut trace = goal_idx as i32;
        while trace >= 0 {
            self.raw_cells.push(trace as usize);
            trace = self.parent[trace as usize];
        }
        self.raw_cells.reverse();

        if smooth && self.raw_cells.len() > 2 {
            let mut anchor = 0usize;
            let c0 = self.raw_cells[0];
            let (x0, z0) = self.cell_center(c0 % self.width, c0 / self.width);
            self.path_points.extend_from_slice(&[x0, z0]);

            while anchor < self.raw_cells.len() - 1 {
                let ax = (self.raw_cells[anchor] % self.width) as isize;
                let az = (self.raw_cells[anchor] / self.width) as isize;
                let mut furthest = anchor + 1;
                for test in (anchor + 2)..self.raw_cells.len() {
                    let tx = (self.raw_cells[test] % self.width) as isize;
                    let tz = (self.raw_cells[test] / self.width) as isize;
                    if self.has_line_of_sight_cells(ax, az, tx, tz) {
                        furthest = test;
                    }
                }
                let fc = self.raw_cells[furthest];
                let (wx, wz) = self.cell_center(fc % self.width, fc / self.width);
                self.path_points.extend_from_slice(&[wx, wz]);
                anchor = furthest;
            }
        } else {
            for &cell in &self.raw_cells {
                let (wx, wz) = self.cell_center(cell % self.width, cell / self.width);
                self.path_points.extend_from_slice(&[wx, wz]);
            }
        }

        self.path_points.len() / 2
    }
}

impl Default for NavGrid {
    fn default() -> Self {
        Self::new()
    }
}

#[inline]
fn octile(x0: usize, z0: usize, x1: usize, z1: usize) -> f32 {
    let dx = x0.abs_diff(x1) as f32;
    let dz = z0.abs_diff(z1) as f32;
    let (mn, mx) = if dx < dz { (dx, dz) } else { (dz, dx) };
    mx + (std::f32::consts::SQRT_2 - 1.0) * mn
}

fn collider_world_extents(col: Collider3D, rot: Quat) -> (f32, f32, f32) {
    match col {
        Collider3D::Aabb { half_extents } => {
            let m = glam::Mat3::from_quat(rot);
            let ax = m.x_axis.abs();
            let ay = m.y_axis.abs();
            let az = m.z_axis.abs();
            let hx = ax.x * half_extents.x + ay.x * half_extents.y + az.x * half_extents.z;
            let hy = ax.y * half_extents.x + ay.y * half_extents.y + az.y * half_extents.z;
            let hz = ax.z * half_extents.x + ay.z * half_extents.y + az.z * half_extents.z;
            (hx, hy, hz)
        }
        Collider3D::Sphere { radius } => (radius, radius, radius),
        Collider3D::Capsule { radius, half_height } => (radius, half_height + radius, radius),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecs::entity_index;
    use glam::Vec3;

    #[test]
    fn test_astar_navigates_around_u_wall_and_smooths_los() {
        let mut nav = NavGrid::new();
        nav.resize(-5.0, -5.0, 1.0, 10, 10);
        // Wall blocking x=0 from z=-3..3
        for cz in 2..=7 {
            nav.set_blocked(5, cz, true);
        }
        let count = nav.find_path(-2.5, 0.5, 2.5, 0.5, true);
        assert!(count >= 3, "expected detoured path around wall, got {count}");
        // Goal should reach cell near (2.5, 0.5)
        let gx = nav.path_points[nav.path_points.len() - 2];
        let gz = nav.path_points[nav.path_points.len() - 1];
        assert!((gx - 2.5).abs() <= 0.6 && (gz - 0.5).abs() <= 0.6);
        // Verify no waypoint lands in blocked cell x=0.5 (cell 5) inside z=[-3..2]
        for i in 0..count {
            let (cx, cz) = nav.world_to_cell(nav.path_points[i * 2], nav.path_points[i * 2 + 1]);
            assert!(!nav.is_blocked(cx, cz));
        }
    }

    #[test]
    fn test_nav_builds_from_static_3d_obstacles() {
        let mut world = World::new();
        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(20.0, 0.5, 20.0),
        });

        let wall = world.spawn();
        world.set_transform_immediate(wall, Vec3::new(0.5, 1.5, 0.5), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(wall)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(0.5, 1.5, 2.5),
        });

        let mut nav = NavGrid::new();
        nav.build_from_world_3d(&world, -10.0, -10.0, 1.0, 20, 20, 0.1, 4.0, 0.4);
        assert!(!nav.is_blocked(0, 0), "floor slab should not block nav");
        assert!(nav.is_blocked(10, 10), "static wall must mark nav cells blocked");
    }
}
