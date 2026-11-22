use crate::ecs::{entity_index, Collider2D, Collider3D, EntityHandle, RigidBody, World, INVALID_ENTITY};
use crate::joints::JointSolver;
use crate::terrain::TerrainHeightmap;
use glam::{Mat3, Quat, Vec2, Vec3};

pub const EVENT_COLLISION_ENTER: u32 = 1;
pub const EVENT_TRIGGER_ENTER: u32 = 2;
pub const EVENT_TRIGGER_EXIT: u32 = 3;
pub const EVENT_STRIDE_U32: usize = 6;

const CELL_SIZE: f32 = 2.5;

#[derive(Clone, Copy, Debug)]
pub struct PhysicsConfig {
    pub fixed_dt: f32,
    pub max_frame_dt: f32,
    pub gravity: Vec3,
    pub max_substeps: u32,
    pub solver_iterations: u32,
}

impl Default for PhysicsConfig {
    fn default() -> Self {
        Self {
            fixed_dt: 1.0 / 60.0,
            max_frame_dt: 0.1,
            gravity: Vec3::new(0.0, -20.0, 0.0),
            max_substeps: 6,
            solver_iterations: 6,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct StepResult {
    pub alpha: f32,
    pub steps_executed: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct RayHit {
    pub entity: EntityHandle,
    pub distance: f32,
    pub point: Vec3,
    pub normal: Vec3,
}

#[derive(Clone, Copy, Debug)]
pub struct PhysicsEvent {
    pub kind: u32,
    pub entity_a: EntityHandle,
    pub entity_b: EntityHandle,
    pub normal: Vec3,
}

#[derive(Clone, Debug)]
pub struct TileGrid2D {
    pub origin: Vec2,
    pub tile_size: f32,
    pub width: usize,
    pub height: usize,
    pub solid: Vec<u8>,
}

impl TileGrid2D {
    pub fn new(origin: Vec2, tile_size: f32, width: usize, height: usize, solid: Vec<u8>) -> Self {
        Self {
            origin,
            tile_size: tile_size.max(0.001),
            width,
            height,
            solid,
        }
    }

    #[inline]
    pub fn is_solid(&self, tx: isize, ty: isize) -> bool {
        if tx < 0 || ty < 0 {
            return false;
        }
        let (ux, uy) = (tx as usize, ty as usize);
        if ux >= self.width || uy >= self.height {
            return false;
        }
        self.solid.get(uy * self.width + ux).copied().unwrap_or(0) != 0
    }
}

#[derive(Clone, Copy, Debug)]
struct BvhNode {
    min: Vec3,
    max: Vec3,
    left_or_leaf: u32, // u32::MAX means leaf
    right_or_count: u32,
    first_tri: u32,
}

#[derive(Clone, Debug)]
pub struct StaticTriMesh {
    pub entity: EntityHandle,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
    pub triangles: Vec<[Vec3; 3]>,
    tri_indices: Vec<usize>,
    tri_centroids: Vec<Vec3>,
    tri_bounds: Vec<(Vec3, Vec3)>,
    nodes: Vec<BvhNode>,
}

impl StaticTriMesh {
    pub fn new(entity: EntityHandle, triangles: Vec<[Vec3; 3]>) -> Self {
        let mut bounds_min = Vec3::splat(f32::INFINITY);
        let mut bounds_max = Vec3::splat(f32::NEG_INFINITY);
        let mut tri_centroids = Vec::with_capacity(triangles.len());
        let mut tri_bounds = Vec::with_capacity(triangles.len());
        let mut tri_indices = Vec::with_capacity(triangles.len());

        for (i, tri) in triangles.iter().enumerate() {
            let tmin = tri[0].min(tri[1]).min(tri[2]);
            let tmax = tri[0].max(tri[1]).max(tri[2]);
            bounds_min = bounds_min.min(tmin);
            bounds_max = bounds_max.max(tmax);
            tri_bounds.push((tmin, tmax));
            tri_centroids.push((tri[0] + tri[1] + tri[2]) / 3.0);
            tri_indices.push(i);
        }

        let mut mesh = Self {
            entity,
            bounds_min,
            bounds_max,
            triangles,
            tri_indices,
            tri_centroids,
            tri_bounds,
            nodes: Vec::new(),
        };
        if !mesh.tri_indices.is_empty() {
            let len = mesh.tri_indices.len();
            mesh.build_node(0, len);
        }
        mesh
    }

    fn build_node(&mut self, start: usize, end: usize) -> u32 {
        let mut bmin = Vec3::splat(f32::INFINITY);
        let mut bmax = Vec3::splat(f32::NEG_INFINITY);
        for &tri_id in &self.tri_indices[start..end] {
            let (tmin, tmax) = self.tri_bounds[tri_id];
            bmin = bmin.min(tmin);
            bmax = bmax.max(tmax);
        }
        let count = end - start;
        let node_idx = self.nodes.len() as u32;
        if count <= 4 {
            self.nodes.push(BvhNode {
                min: bmin,
                max: bmax,
                left_or_leaf: u32::MAX,
                right_or_count: count as u32,
                first_tri: start as u32,
            });
            return node_idx;
        }

        let extent = bmax - bmin;
        let axis = if extent.x >= extent.y && extent.x >= extent.z {
            0
        } else if extent.y >= extent.z {
            1
        } else {
            2
        };
        let mid = start + count / 2;
        self.tri_indices[start..end].select_nth_unstable_by(mid - start, |&a, &b| {
            self.tri_centroids[a][axis].total_cmp(&self.tri_centroids[b][axis])
        });

        self.nodes.push(BvhNode {
            min: bmin,
            max: bmax,
            left_or_leaf: 0,
            right_or_count: 0,
            first_tri: 0,
        });
        let left = self.build_node(start, mid);
        let right = self.build_node(mid, end);
        self.nodes[node_idx as usize].left_or_leaf = left;
        self.nodes[node_idx as usize].right_or_count = right;
        node_idx
    }

    fn query_aabb(&self, qmin: Vec3, qmax: Vec3, out: &mut Vec<usize>) -> usize {
        out.clear();
        if self.nodes.is_empty() {
            return 0;
        }
        let mut stack = [0u32; 64];
        let mut sp = 1usize;
        let mut visited = 0usize;
        while sp > 0 {
            sp -= 1;
            let node = self.nodes[stack[sp] as usize];
            if qmax.x < node.min.x
                || qmin.x > node.max.x
                || qmax.y < node.min.y
                || qmin.y > node.max.y
                || qmax.z < node.min.z
                || qmin.z > node.max.z
            {
                continue;
            }
            if node.left_or_leaf == u32::MAX {
                let start = node.first_tri as usize;
                let end = start + node.right_or_count as usize;
                for &tid in &self.tri_indices[start..end] {
                    out.push(tid);
                    visited += 1;
                }
            } else {
                if sp + 2 < stack.len() {
                    stack[sp] = node.left_or_leaf;
                    stack[sp + 1] = node.right_or_count;
                    sp += 2;
                }
            }
        }
        visited
    }

    fn raycast(&self, origin: Vec3, dir: Vec3, max_dist: f32) -> (Option<(f32, Vec3)>, usize) {
        if self.nodes.is_empty() {
            return (None, 0);
        }
        let mut stack = [0u32; 64];
        let mut sp = 1usize;
        let mut best_t = max_dist;
        let mut best_n = Vec3::Y;
        let mut hit_any = false;
        let mut visited = 0usize;

        while sp > 0 {
            sp -= 1;
            let node = self.nodes[stack[sp] as usize];
            let Some((t_box, _)) = ray_aabb(origin, dir, node.min, node.max) else {
                continue;
            };
            if t_box > best_t {
                continue;
            }
            if node.left_or_leaf == u32::MAX {
                let start = node.first_tri as usize;
                let end = start + node.right_or_count as usize;
                for &tid in &self.tri_indices[start..end] {
                    visited += 1;
                    let tri = self.triangles[tid];
                    if let Some((t, n)) = ray_triangle(origin, dir, tri[0], tri[1], tri[2]) {
                        if t >= 0.0 && t < best_t {
                            best_t = t;
                            best_n = n;
                            hit_any = true;
                        }
                    }
                }
            } else if sp + 2 < stack.len() {
                stack[sp] = node.left_or_leaf;
                stack[sp + 1] = node.right_or_count;
                sp += 2;
            }
        }

        if hit_any {
            (Some((best_t, best_n)), visited)
        } else {
            (None, visited)
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ContactPoint {
    point: Vec3,
    normal: Vec3,
    depth: f32,
}

#[derive(Clone, Copy, Debug)]
struct Contact2D {
    normal: Vec2,
    depth: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct OverlapPair {
    a: EntityHandle,
    b: EntityHandle,
    is_trigger: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct CharacterController {
    pub step_height: f32,
    pub max_slope_cos: f32,
}

pub struct PhysicsWorld {
    pub config: PhysicsConfig,
    accumulator: f32,
    pub tile_grids_2d: Vec<TileGrid2D>,
    pub static_meshes: Vec<StaticTriMesh>,
    pub terrain: Option<TerrainHeightmap>,
    pub terrain_entity: EntityHandle,
    pub joints: JointSolver,
    pub character_controllers: Vec<Option<CharacterController>>,
    ground_support: Vec<Option<(usize, Vec3)>>,
    dynamic_indices: Vec<usize>,
    awake_indices: Vec<usize>,
    static_indices_3d: Vec<usize>,
    static_indices_2d: Vec<usize>,

    dyn_cells: Vec<(u64, usize)>,
    pair_scratch: Vec<(usize, usize)>,
    bvh_scratch: Vec<usize>,

    prev_overlaps: Vec<OverlapPair>,
    curr_overlaps: Vec<OverlapPair>,
    events: Vec<PhysicsEvent>,
    pub event_words: Vec<u32>,
}

impl PhysicsWorld {
    pub fn new(config: PhysicsConfig) -> Self {
        Self {
            config,
            accumulator: 0.0,
            tile_grids_2d: Vec::new(),
            static_meshes: Vec::new(),
            terrain: None,
            terrain_entity: INVALID_ENTITY,
            joints: JointSolver::new(),
            character_controllers: Vec::new(),
            ground_support: Vec::new(),
            dynamic_indices: Vec::new(),
            awake_indices: Vec::new(),
            static_indices_3d: Vec::new(),
            static_indices_2d: Vec::new(),
            dyn_cells: Vec::new(),
            pair_scratch: Vec::new(),
            bvh_scratch: Vec::new(),
            prev_overlaps: Vec::new(),
            curr_overlaps: Vec::new(),
            events: Vec::new(),
            event_words: Vec::new(),
        }
    }

    pub fn set_character_controller(
        &mut self,
        entity: EntityHandle,
        step_height: f32,
        max_slope_deg: f32,
    ) {
        let idx = entity_index(entity);
        if idx >= self.character_controllers.len() {
            self.character_controllers.resize(idx + 1, None);
        }
        let cos = max_slope_deg.clamp(1.0, 89.0).to_radians().cos();
        self.character_controllers[idx] = Some(CharacterController {
            step_height: step_height.max(0.0),
            max_slope_cos: cos,
        });
    }

    pub fn clear_static_geometry(&mut self) {
        self.tile_grids_2d.clear();
        self.static_meshes.clear();
        self.terrain = None;
        self.terrain_entity = INVALID_ENTITY;
        self.joints.clear();
        self.character_controllers.clear();
        self.ground_support.clear();
        self.prev_overlaps.clear();
        self.curr_overlaps.clear();
        self.clear_events();
        self.accumulator = 0.0;
    }

    pub fn clear_events(&mut self) {
        self.events.clear();
        self.event_words.clear();
    }

    pub fn events(&self) -> &[PhysicsEvent] {
        &self.events
    }

    pub fn add_static_mesh(&mut self, entity: EntityHandle, triangles: Vec<[Vec3; 3]>) {
        if triangles.is_empty() {
            return;
        }
        self.static_meshes.push(StaticTriMesh::new(entity, triangles));
    }

    pub fn apply_impulse(
        &self,
        world: &mut World,
        entity: EntityHandle,
        impulse: Vec3,
        world_point: Option<Vec3>,
    ) -> bool {
        if !world.is_alive(entity) {
            return false;
        }
        let idx = entity_index(entity);
        let Some(rb) = &mut world.rigid_bodies[idx] else {
            return false;
        };
        if !rb.dynamic {
            return false;
        }
        rb.sleeping = false;
        rb.sleep_timer = 0.0;
        let mass = rb.mass;
        let lock_rot = rb.lock_rotation;
        let inv_m = 1.0 / mass.max(0.01);
        world.velocities[idx] += impulse * inv_m;
        if !lock_rot {
            if let Some(pt) = world_point {
                let r = pt - world.curr_pos[idx];
                let inv_i = collider_inv_inertia(world.colliders_3d[idx], mass);
                world.angular_velocities[idx] += r.cross(impulse) * inv_i;
            }
        }
        true
    }

    pub fn step(&mut self, world: &mut World, frame_dt: f32) -> StepResult {
        let clamped_dt = frame_dt.clamp(0.0, self.config.max_frame_dt);
        self.accumulator += clamped_dt;

        let fixed_dt = self.config.fixed_dt.max(1e-4);
        let mut steps_executed = 0u32;

        while self.accumulator >= fixed_dt && steps_executed < self.config.max_substeps {
            world.snapshot_prev_transforms();
            self.step_fixed(world, fixed_dt);
            self.accumulator -= fixed_dt;
            steps_executed += 1;
        }

        if steps_executed == self.config.max_substeps && self.accumulator >= fixed_dt {
            self.accumulator %= fixed_dt;
        }

        let alpha = (self.accumulator / fixed_dt).clamp(0.0, 1.0);
        world.compute_interpolated_matrices(alpha);
        StepResult {
            alpha,
            steps_executed,
        }
    }

    fn step_fixed(&mut self, world: &mut World, dt: f32) {
        self.dynamic_indices.clear();
        self.awake_indices.clear();
        self.static_indices_3d.clear();
        self.static_indices_2d.clear();
        self.curr_overlaps.clear();

        let count = world.alive.len();
        if self.ground_support.len() < count {
            self.ground_support.resize(count, None);
        }

        // Apply spring joint impulses before integration
        self.joints.retain_alive(world);
        self.joints.apply_springs(world, dt);

        // Wake riders whose supporting platform moved
        for i in 0..count {
            if !world.alive[i] {
                self.ground_support[i] = None;
                continue;
            }
            if let Some((plat_idx, last_pos)) = self.ground_support[i] {
                if plat_idx < count && world.alive[plat_idx] {
                    if world.curr_pos[plat_idx].distance_squared(last_pos) > 1e-8 {
                        if let Some(rb) = &mut world.rigid_bodies[i] {
                            rb.sleeping = false;
                            rb.sleep_timer = 0.0;
                        }
                    }
                } else {
                    self.ground_support[i] = None;
                }
            }
        }

        for i in 0..count {
            if !world.alive[i] {
                continue;
            }
            if let Some(rb) = &mut world.rigid_bodies[i] {
                if rb.dynamic {
                    self.dynamic_indices.push(i);
                    if rb.sleeping {
                        continue;
                    }
                    rb.grounded = false;
                    world.velocities[i] += self.config.gravity * rb.gravity_scale * dt;
                    let lin_damp = (1.0 - rb.linear_damping * dt).clamp(0.0, 1.0);
                    world.velocities[i] *= lin_damp;
                    world.curr_pos[i] += world.velocities[i] * dt;

                    if !rb.lock_rotation {
                        let ang_damp = (1.0 - rb.angular_damping * dt).clamp(0.0, 1.0);
                        world.angular_velocities[i] *= ang_damp;
                        let w = world.angular_velocities[i];
                        if w.length_squared() > 1e-10 {
                            let dq = Quat::from_scaled_axis(w * dt);
                            world.curr_rot[i] = (dq * world.curr_rot[i]).normalize();
                        }
                    } else {
                        world.angular_velocities[i] = Vec3::ZERO;
                    }
                    self.awake_indices.push(i);
                    continue;
                }
            }
            if world.colliders_3d[i].is_some() {
                self.static_indices_3d.push(i);
            }
            if world.colliders_2d[i].is_some() {
                self.static_indices_2d.push(i);
            }
        }

        // Carry grounded riders along moving platforms (using net delta since previous substep)
        for &i in &self.awake_indices {
            if let Some((plat_idx, last_pos)) = self.ground_support[i] {
                if plat_idx < count && world.alive[plat_idx] {
                    let delta = world.curr_pos[plat_idx] - last_pos;
                    if delta.length_squared() > 1e-10 {
                        world.curr_pos[i] += delta;
                    }
                }
                self.ground_support[i] = None;
            }
        }

        self.static_meshes
            .retain(|m| m.entity == INVALID_ENTITY || world.is_alive(m.entity));

        // Build spatial hash candidate pairs for dynamic 3D bodies once per fixed tick.
        self.build_dynamic_pairs(world);

        for iter in 0..self.config.solver_iterations {
            for idx_pos in 0..self.awake_indices.len() {
                let dyn_idx = self.awake_indices[idx_pos];
                if world.colliders_3d[dyn_idx].is_some() {
                    self.resolve_3d_static(world, dyn_idx, iter == 0);
                }
                if world.colliders_2d[dyn_idx].is_some() {
                    self.resolve_2d_entity(world, dyn_idx);
                }
            }
            self.resolve_3d_dynamic_pairs(world, iter == 0);
            self.joints.solve_constraints(world, dt);
        }

        // Snapshot updated platform positions for next tick's rider carry
        for i in 0..self.ground_support.len() {
            if let Some((plat_idx, _)) = self.ground_support[i] {
                if plat_idx < count && world.alive[plat_idx] {
                    self.ground_support[i] = Some((plat_idx, world.curr_pos[plat_idx]));
                } else {
                    self.ground_support[i] = None;
                }
            }
        }

        // Update sleeping timers
        for idx_pos in 0..self.awake_indices.len() {
            let i = self.awake_indices[idx_pos];
            let v_sq = world.velocities[i].length_squared();
            let w_sq = world.angular_velocities[i].length_squared();
            if let Some(rb) = &mut world.rigid_bodies[i] {
                if !rb.is_trigger && rb.grounded && v_sq < 0.015 && w_sq < 0.02 {
                    rb.sleep_timer += dt;
                    if rb.sleep_timer >= 0.45 {
                        rb.sleeping = true;
                        world.velocities[i] = Vec3::ZERO;
                        world.angular_velocities[i] = Vec3::ZERO;
                    }
                } else {
                    rb.sleep_timer = 0.0;
                }
            }
        }

        self.emit_overlap_events();
    }

    fn build_dynamic_pairs(&mut self, world: &World) {
        self.dyn_cells.clear();
        self.pair_scratch.clear();
        for &idx in &self.dynamic_indices {
            let Some(col) = world.colliders_3d[idx] else {
                continue;
            };
            let pos = world.curr_pos[idx];
            let r = collider3d_bounding_radius(col);
            let min_cx = ((pos.x - r) / CELL_SIZE).floor() as i32;
            let max_cx = ((pos.x + r) / CELL_SIZE).floor() as i32;
            let min_cy = ((pos.y - r) / CELL_SIZE).floor() as i32;
            let max_cy = ((pos.y + r) / CELL_SIZE).floor() as i32;
            let min_cz = ((pos.z - r) / CELL_SIZE).floor() as i32;
            let max_cz = ((pos.z + r) / CELL_SIZE).floor() as i32;
            for cz in min_cz..=max_cz {
                for cy in min_cy..=max_cy {
                    for cx in min_cx..=max_cx {
                        self.dyn_cells.push((hash_cell(cx, cy, cz), idx));
                    }
                }
            }
        }

        self.dyn_cells.sort_unstable_by_key(|&(h, _)| h);
        let mut i = 0;
        while i < self.dyn_cells.len() {
            let h = self.dyn_cells[i].0;
            let mut j = i + 1;
            while j < self.dyn_cells.len() && self.dyn_cells[j].0 == h {
                j += 1;
            }
            for a_pos in i..j {
                let a = self.dyn_cells[a_pos].1;
                let a_sleep = world.rigid_bodies[a].map_or(false, |r| r.sleeping);
                for b_pos in (a_pos + 1)..j {
                    let b = self.dyn_cells[b_pos].1;
                    if a == b {
                        continue;
                    }
                    let b_sleep = world.rigid_bodies[b].map_or(false, |r| r.sleeping);
                    if a_sleep && b_sleep {
                        continue;
                    }
                    let pair = if a < b { (a, b) } else { (b, a) };
                    self.pair_scratch.push(pair);
                }
            }
            i = j;
        }
        self.pair_scratch.sort_unstable();
        self.pair_scratch.dedup();
    }

    #[allow(clippy::too_many_arguments)]
    fn gather_static_contacts(
        &mut self,
        world: &World,
        dyn_idx: usize,
        col: Collider3D,
        pos_a: Vec3,
        rot_a: Quat,
        rb_a: RigidBody,
        record_overlaps: bool,
        handle_a: EntityHandle,
        contacts: &mut [ContactPoint; 32],
    ) -> usize {
        let mut contact_count = 0usize;
        let mut ground_stat_idx: Option<usize> = None;

        // 1. Static AABB / Sphere / Capsule entities (including triggers)
        for s_pos in 0..self.static_indices_3d.len() {
            let stat_idx = self.static_indices_3d[s_pos];
            let Some(stat_col) = world.colliders_3d[stat_idx] else {
                continue;
            };
            let rb_b = world.rigid_bodies[stat_idx];
            if !layers_match(Some(rb_a), rb_b) {
                continue;
            }
            let stat_handle = make_handle(world, stat_idx);
            let is_trigger_pair = rb_a.is_trigger || rb_b.map_or(false, |r| r.is_trigger);
            if !is_trigger_pair && self.joints.has_pair(handle_a, stat_handle) {
                continue;
            }
            if is_trigger_pair {
                let mut tmp = [ContactPoint {
                    point: Vec3::ZERO,
                    normal: Vec3::ZERO,
                    depth: 0.0,
                }; 4];
                let mut tmp_count = 0usize;
                collect_3d_contacts(
                    col,
                    pos_a,
                    rot_a,
                    stat_col,
                    world.curr_pos[stat_idx],
                    world.curr_rot[stat_idx],
                    Some(stat_idx),
                    false,
                    &mut tmp,
                    &mut tmp_count,
                );
                if tmp_count > 0 && record_overlaps {
                    self.record_overlap(handle_a, make_handle(world, stat_idx), true);
                }
                continue;
            }
            let before = contact_count;
            collect_3d_contacts(
                col,
                pos_a,
                rot_a,
                stat_col,
                world.curr_pos[stat_idx],
                world.curr_rot[stat_idx],
                Some(stat_idx),
                false,
                contacts,
                &mut contact_count,
            );
            if contact_count > before {
                if record_overlaps {
                    self.record_overlap(handle_a, make_handle(world, stat_idx), false);
                }
                if contacts[before..contact_count].iter().any(|c| c.normal.y > 0.45) {
                    ground_stat_idx = Some(stat_idx);
                }
            }
        }
        if record_overlaps {
            if let Some(p_idx) = ground_stat_idx {
                if dyn_idx < self.ground_support.len() {
                    self.ground_support[dyn_idx] = Some((p_idx, world.curr_pos[p_idx]));
                }
            }
        }

        // 2. Static triangle meshes via BVH + Terrain heightmap (skipped for triggers)
        if !rb_a.is_trigger {
            if let Some(hm) = &self.terrain {
                let (rx, bottom_off, rz) = match col {
                    Collider3D::Sphere { radius } => (radius * 0.6, radius, radius * 0.6),
                    Collider3D::Capsule { radius, half_height } => (radius * 0.65, radius + half_height, radius * 0.65),
                    Collider3D::Aabb { half_extents } => (half_extents.x * 0.75, half_extents.y, half_extents.z * 0.75),
                };
                let bottom_y = pos_a.y - bottom_off;
                let samples = [
                    (pos_a.x, pos_a.z),
                    (pos_a.x + rx, pos_a.z),
                    (pos_a.x - rx, pos_a.z),
                    (pos_a.x, pos_a.z + rz),
                    (pos_a.x, pos_a.z - rz),
                ];
                let mut best_depth = 0.0f32;
                let mut best_h = 0.0f32;
                let mut best_n = Vec3::Y;
                let mut best_pt = Vec3::ZERO;
                for (sx, sz) in samples {
                    if let Some((th, tn)) = hm.sample_height_and_normal(sx, sz) {
                        let pen = (th - bottom_y) * tn.y.max(0.35);
                        if pen > best_depth {
                            best_depth = pen;
                            best_h = th;
                            best_n = tn;
                            best_pt = Vec3::new(sx, th, sz);
                        }
                    }
                }
                if best_depth > 0.0 && contact_count < contacts.len() {
                    let _ = best_h;
                    contacts[contact_count] = ContactPoint {
                        point: best_pt,
                        normal: best_n,
                        depth: best_depth,
                    };
                    contact_count += 1;
                }
            }

            let r_bound = collider3d_bounding_radius(col) + 0.1;
            let qmin = pos_a - Vec3::splat(r_bound);
            let qmax = pos_a + Vec3::splat(r_bound);
            for m_idx in 0..self.static_meshes.len() {
                self.static_meshes[m_idx].query_aabb(qmin, qmax, &mut self.bvh_scratch);
                for &t_idx in &self.bvh_scratch {
                    let tri = self.static_meshes[m_idx].triangles[t_idx];
                    collect_triangle_contacts(
                        col,
                        pos_a,
                        rot_a,
                        tri,
                        contacts,
                        &mut contact_count,
                    );
                }
            }
        }
        contact_count
    }

    fn has_blocking_wall(
        &mut self,
        world: &World,
        dyn_idx: usize,
        col: Collider3D,
        rot_a: Quat,
        rb_a: RigidBody,
        test_pos: Vec3,
        slope_cos: f32,
    ) -> bool {
        let mut probe = [ContactPoint {
            point: Vec3::ZERO,
            normal: Vec3::ZERO,
            depth: 0.0,
        }; 32];
        let count = self.gather_static_contacts(
            world,
            dyn_idx,
            col,
            test_pos,
            rot_a,
            rb_a,
            false,
            INVALID_ENTITY,
            &mut probe,
        );
        probe[..count].iter().any(|c| {
            (c.normal.y.abs() < slope_cos && c.depth > 0.025)
                || (c.normal.y < -0.5 && c.depth > 0.02)
        })
    }

    fn resolve_3d_static(&mut self, world: &mut World, dyn_idx: usize, record_overlaps: bool) {
        let Some(col) = world.colliders_3d[dyn_idx] else {
            return;
        };
        let Some(rb_a) = world.rigid_bodies[dyn_idx] else {
            return;
        };

        let mut contacts = [ContactPoint {
            point: Vec3::ZERO,
            normal: Vec3::ZERO,
            depth: 0.0,
        }; 32];
        let pos_a = world.curr_pos[dyn_idx];
        let rot_a = world.curr_rot[dyn_idx];
        let handle_a = make_handle(world, dyn_idx);
        let mut contact_count = self.gather_static_contacts(
            world,
            dyn_idx,
            col,
            pos_a,
            rot_a,
            rb_a,
            record_overlaps,
            handle_a,
            &mut contacts,
        );

        if contact_count == 0 {
            return;
        }

        let cc = self.character_controllers.get(dyn_idx).copied().flatten();
        let slope_cos = cc.map_or(0.45, |c| c.max_slope_cos);

        // Stair auto-step-up for CharacterController when horizontal motion meets a low curb/step
        if record_overlaps && !rb_a.is_trigger {
            if let Some(ctrl) = cc {
                if ctrl.step_height > 0.01 {
                    let has_wall = contacts[..contact_count]
                        .iter()
                        .any(|c| c.normal.y.abs() < ctrl.max_slope_cos && c.depth > 0.005);
                    let hv = Vec3::new(world.velocities[dyn_idx].x, 0.0, world.velocities[dyn_idx].z);
                    if has_wall && hv.length_squared() > 0.01 {
                        let nudge = hv.normalize() * 0.08;
                        for frac in [0.25f32, 0.5, 0.75, 1.0] {
                            let h = ctrl.step_height * frac;
                            let test_pos = pos_a + Vec3::Y * h + nudge;
                            if !self.has_blocking_wall(
                                world,
                                dyn_idx,
                                col,
                                rot_a,
                                rb_a,
                                test_pos,
                                ctrl.max_slope_cos,
                            ) {
                                let stepped_pos = pos_a + Vec3::Y * (h + 0.01) + nudge * 0.5;
                                world.curr_pos[dyn_idx] = stepped_pos;
                                world.velocities[dyn_idx].y = world.velocities[dyn_idx].y.max(0.0);
                                contact_count = self.gather_static_contacts(
                                    world,
                                    dyn_idx,
                                    col,
                                    stepped_pos,
                                    rot_a,
                                    rb_a,
                                    false,
                                    handle_a,
                                    &mut contacts,
                                );
                                if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                                    rb.grounded = true;
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }

        if contact_count == 0 {
            return;
        }

        contacts[..contact_count].sort_by(|a, b| {
            let a_floor = a.normal.y > 0.5;
            let b_floor = b.normal.y > 0.5;
            b_floor
                .cmp(&a_floor)
                .then_with(|| b.depth.total_cmp(&a.depth))
        });

        let mut max_push = Vec3::ZERO;
        for c in &contacts[..contact_count] {
            if c.normal.y >= slope_cos {
                if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                    rb.grounded = true;
                }
            }
            let push_mag = (c.depth - 0.0005).max(0.0);
            let candidate = c.normal * push_mag;
            if candidate.length_squared() > max_push.length_squared() {
                max_push = candidate;
            }
        }
        world.curr_pos[dyn_idx] += max_push;

        let inv_m = 1.0 / rb_a.mass.max(0.01);
        let inv_i = if rb_a.lock_rotation {
            0.0
        } else {
            collider_inv_inertia(Some(col), rb_a.mass)
        };

        let scale = 1.0 / (contact_count.max(1) as f32);
        for c in &contacts[..contact_count] {
            let n = c.normal;
            let ra = c.point - world.curr_pos[dyn_idx];
            let va = world.velocities[dyn_idx] + world.angular_velocities[dyn_idx].cross(ra);
            let vn = va.dot(n);
            if vn < 0.0 {
                let rn = ra.cross(n);
                let denom = inv_m + rn.length_squared() * inv_i;
                let e = if vn.abs() < 1.2 { 0.0 } else { rb_a.restitution };
                let jn = (-(1.0 + e) * vn / denom.max(1e-6)) * scale;
                let mut impulse = n * jn;

                if rb_a.friction > 0.0 {
                    let tang = va - n * vn;
                    let t_len = tang.length();
                    if t_len > 1e-5 {
                        let t = tang / t_len;
                        let rt = ra.cross(t);
                        let denom_t = inv_m + rt.length_squared() * inv_i;
                        let jt = ((-va.dot(t) / denom_t.max(1e-6)) * scale)
                            .clamp(-rb_a.friction * jn, rb_a.friction * jn);
                        impulse += t * jt;
                    }
                }
                world.velocities[dyn_idx] += impulse * inv_m;
                if !rb_a.lock_rotation {
                    world.angular_velocities[dyn_idx] += ra.cross(impulse) * inv_i;
                }
            } else if rb_a.friction > 0.0 && c.depth > 0.0 {
                let tang = va - n * vn;
                let t_len = tang.length();
                if t_len > 1e-5 {
                    let t = tang / t_len;
                    let rt = ra.cross(t);
                    let denom_t = inv_m + rt.length_squared() * inv_i;
                    let max_rest = rb_a.friction * rb_a.mass * 0.25 * scale;
                    let jt = ((-va.dot(t) / denom_t.max(1e-6)) * scale).clamp(-max_rest, max_rest);
                    let imp = t * jt;
                    world.velocities[dyn_idx] += imp * inv_m;
                    if !rb_a.lock_rotation {
                        world.angular_velocities[dyn_idx] += ra.cross(imp) * inv_i;
                    }
                }
            }
        }
    }

    fn resolve_3d_dynamic_pairs(&mut self, world: &mut World, record_overlaps: bool) {
        let mut contacts = [ContactPoint {
            point: Vec3::ZERO,
            normal: Vec3::ZERO,
            depth: 0.0,
        }; 16];

        for p_idx in 0..self.pair_scratch.len() {
            let (a, b) = self.pair_scratch[p_idx];
            let (Some(col_a), Some(col_b)) = (world.colliders_3d[a], world.colliders_3d[b]) else {
                continue;
            };
            let (Some(rb_a), Some(rb_b)) = (world.rigid_bodies[a], world.rigid_bodies[b]) else {
                continue;
            };
            if !layers_match(Some(rb_a), Some(rb_b)) {
                continue;
            }
            if self.joints.has_pair(make_handle(world, a), make_handle(world, b)) {
                continue;
            }
            let pos_a = world.curr_pos[a];
            let pos_b = world.curr_pos[b];
            let r_sum = collider3d_bounding_radius(col_a) + collider3d_bounding_radius(col_b);
            if pos_a.distance_squared(pos_b) > r_sum * r_sum {
                continue;
            }

            let mut count = 0usize;
            collect_3d_contacts(
                col_a,
                pos_a,
                world.curr_rot[a],
                col_b,
                pos_b,
                world.curr_rot[b],
                Some(b),
                true,
                &mut contacts,
                &mut count,
            );
            if count == 0 {
                continue;
            }

            let is_trigger_pair = rb_a.is_trigger || rb_b.is_trigger;
            if record_overlaps {
                self.record_overlap(make_handle(world, a), make_handle(world, b), is_trigger_pair);
            }
            if is_trigger_pair {
                continue;
            }

            // Wake sleeping partner on energetic contact (or if partner was asleep under/on an awake mover)
            let rel_speed_sq = (world.velocities[a] - world.velocities[b]).length_squared();
            if rel_speed_sq > 0.02 || !rb_a.sleeping || !rb_b.sleeping {
                if rel_speed_sq > 0.02 {
                    if let Some(rb) = &mut world.rigid_bodies[a] {
                        rb.sleeping = false;
                        rb.sleep_timer = 0.0;
                    }
                    if let Some(rb) = &mut world.rigid_bodies[b] {
                        rb.sleeping = false;
                        rb.sleep_timer = 0.0;
                    }
                }
            }

            let inv_m_a = 1.0 / rb_a.mass.max(0.01);
            let inv_m_b = 1.0 / rb_b.mass.max(0.01);
            let inv_i_a = if rb_a.lock_rotation {
                0.0
            } else {
                collider_inv_inertia(Some(col_a), rb_a.mass)
            };
            let inv_i_b = if rb_b.lock_rotation {
                0.0
            } else {
                collider_inv_inertia(Some(col_b), rb_b.mass)
            };

            let mut deepest = contacts[0];
            for c in &contacts[1..count] {
                if c.depth > deepest.depth {
                    deepest = *c;
                }
            }
            let total_inv_m = (inv_m_a + inv_m_b).max(1e-6);
            let push_dist = (deepest.depth - 0.0005).max(0.0);
            world.curr_pos[a] += deepest.normal * (push_dist * (inv_m_a / total_inv_m));
            world.curr_pos[b] -= deepest.normal * (push_dist * (inv_m_b / total_inv_m));
            if deepest.normal.y > 0.45 {
                if let Some(rb) = &mut world.rigid_bodies[a] {
                    rb.grounded = true;
                }
                if a < self.ground_support.len() {
                    self.ground_support[a] = Some((b, world.curr_pos[b]));
                }
            }
            if deepest.normal.y < -0.45 {
                if let Some(rb) = &mut world.rigid_bodies[b] {
                    rb.grounded = true;
                }
                if b < self.ground_support.len() {
                    self.ground_support[b] = Some((a, world.curr_pos[a]));
                }
            }

            let scale = 1.0 / (count.max(1) as f32);
            let cc_a = self.character_controllers.get(a).copied().flatten().is_some();
            let cc_b = self.character_controllers.get(b).copied().flatten().is_some();
            for c in &contacts[..count] {
                let n = c.normal;
                let ra = c.point - world.curr_pos[a];
                let rb = c.point - world.curr_pos[b];
                let va = world.velocities[a] + world.angular_velocities[a].cross(ra);
                let vb = world.velocities[b] + world.angular_velocities[b].cross(rb);
                let v_rel = va - vb;
                let vn = v_rel.dot(n);
                if vn >= 0.0 {
                    continue;
                }
                let denom = inv_m_a
                    + inv_m_b
                    + ra.cross(n).length_squared() * inv_i_a
                    + rb.cross(n).length_squared() * inv_i_b;
                if denom < 1e-8 {
                    continue;
                }
                let e = if vn.abs() < 1.2 {
                    0.0
                } else {
                    rb_a.restitution.max(rb_b.restitution)
                };
                let jn = (-(1.0 + e) * vn / denom) * scale;
                let mut impulse_a = n * jn;
                let mut impulse_b = -n * jn;

                let mu = (rb_a.friction + rb_b.friction) * 0.5;
                if mu > 0.0 && !(cc_a || cc_b) {
                    let tang = v_rel - n * vn;
                    let t_len = tang.length();
                    if t_len > 1e-5 {
                        let t = tang / t_len;
                        let denom_t = inv_m_a
                            + inv_m_b
                            + ra.cross(t).length_squared() * inv_i_a
                            + rb.cross(t).length_squared() * inv_i_b;
                        let jt = (-v_rel.dot(t) / denom_t.max(1e-6)).clamp(-mu * jn, mu * jn);
                        impulse_a += t * jt;
                        impulse_b -= t * jt;
                    }
                }
                world.velocities[a] += impulse_a * inv_m_a;
                world.velocities[b] += impulse_b * inv_m_b;
                if !rb_a.lock_rotation {
                    world.angular_velocities[a] += ra.cross(impulse_a) * inv_i_a;
                }
                if !rb_b.lock_rotation {
                    world.angular_velocities[b] += rb.cross(impulse_b) * inv_i_b;
                }
            }
        }
    }

    fn record_overlap(&mut self, a: EntityHandle, b: EntityHandle, is_trigger: bool) {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        self.curr_overlaps.push(OverlapPair {
            a: lo,
            b: hi,
            is_trigger,
        });
    }

    fn emit_overlap_events(&mut self) {
        self.curr_overlaps.sort_unstable();
        self.curr_overlaps.dedup();

        // Enter events: in curr, not in prev
        for idx in 0..self.curr_overlaps.len() {
            let cur = self.curr_overlaps[idx];
            let existed = self
                .prev_overlaps
                .binary_search_by(|p| (p.a, p.b).cmp(&(cur.a, cur.b)))
                .is_ok();
            if !existed {
                let kind = if cur.is_trigger {
                    EVENT_TRIGGER_ENTER
                } else {
                    EVENT_COLLISION_ENTER
                };
                self.push_event(PhysicsEvent {
                    kind,
                    entity_a: cur.a,
                    entity_b: cur.b,
                    normal: Vec3::Y,
                });
            }
        }

        // Exit events: in prev, not in curr (for triggers)
        for idx in 0..self.prev_overlaps.len() {
            let prev = self.prev_overlaps[idx];
            if !prev.is_trigger {
                continue;
            }
            let still_here = self
                .curr_overlaps
                .binary_search_by(|p| (p.a, p.b).cmp(&(prev.a, prev.b)))
                .is_ok();
            if !still_here {
                self.push_event(PhysicsEvent {
                    kind: EVENT_TRIGGER_EXIT,
                    entity_a: prev.a,
                    entity_b: prev.b,
                    normal: Vec3::ZERO,
                });
            }
        }

        std::mem::swap(&mut self.prev_overlaps, &mut self.curr_overlaps);
    }

    fn push_event(&mut self, ev: PhysicsEvent) {
        self.events.push(ev);
        self.event_words.extend_from_slice(&[
            ev.kind,
            ev.entity_a,
            ev.entity_b,
            ev.normal.x.to_bits(),
            ev.normal.y.to_bits(),
            ev.normal.z.to_bits(),
        ]);
    }

    fn resolve_2d_entity(&mut self, world: &mut World, dyn_idx: usize) {
        let Some(col) = world.colliders_2d[dyn_idx] else {
            return;
        };
        let rb_a = world.rigid_bodies[dyn_idx];
        let handle_a = make_handle(world, dyn_idx);

        let mut contacts = [Contact2D {
            normal: Vec2::ZERO,
            depth: 0.0,
        }; 16];
        let mut count = 0usize;

        let p2 = Vec2::new(world.curr_pos[dyn_idx].x, world.curr_pos[dyn_idx].y);

        for s_pos in 0..self.static_indices_2d.len() {
            let stat_idx = self.static_indices_2d[s_pos];
            let Some(stat_col) = world.colliders_2d[stat_idx] else {
                continue;
            };
            let rb_b = world.rigid_bodies[stat_idx];
            if !layers_match(rb_a, rb_b) {
                continue;
            }
            let sp = Vec2::new(world.curr_pos[stat_idx].x, world.curr_pos[stat_idx].y);
            if let Some((normal, depth)) = intersect_2d(col, p2, stat_col, sp) {
                let is_trig = rb_a.map_or(false, |r| r.is_trigger)
                    || rb_b.map_or(false, |r| r.is_trigger);
                self.record_overlap(handle_a, make_handle(world, stat_idx), is_trig);
                if !is_trig && count < contacts.len() {
                    contacts[count] = Contact2D { normal, depth };
                    count += 1;
                }
            }
        }

        if !rb_a.map_or(false, |r| r.is_trigger) {
            for grid in &self.tile_grids_2d {
                let r = match col {
                    Collider2D::Circle2D { radius } => radius,
                    Collider2D::Aabb2D { half_extents } => half_extents.x.max(half_extents.y),
                };
                let min_tx = ((p2.x - r - grid.origin.x) / grid.tile_size).floor() as isize;
                let max_tx = ((p2.x + r - grid.origin.x) / grid.tile_size).floor() as isize;
                let min_ty = ((p2.y - r - grid.origin.y) / grid.tile_size).floor() as isize;
                let max_ty = ((p2.y + r - grid.origin.y) / grid.tile_size).floor() as isize;

                let half_tile = Vec2::splat(grid.tile_size * 0.5);
                for ty in min_ty..=max_ty {
                    for tx in min_tx..=max_tx {
                        if !grid.is_solid(tx, ty) {
                            continue;
                        }
                        let tile_center = grid.origin
                            + Vec2::new(
                                (tx as f32 + 0.5) * grid.tile_size,
                                (ty as f32 + 0.5) * grid.tile_size,
                            );
                        if let Some((normal, depth)) = intersect_2d(
                            col,
                            p2,
                            Collider2D::Aabb2D {
                                half_extents: half_tile,
                            },
                            tile_center,
                        ) {
                            let nx = if normal.x > 0.7 {
                                1
                            } else if normal.x < -0.7 {
                                -1
                            } else {
                                0
                            };
                            let ny = if normal.y > 0.7 {
                                1
                            } else if normal.y < -0.7 {
                                -1
                            } else {
                                0
                            };
                            if (nx != 0 || ny != 0) && grid.is_solid(tx + nx, ty + ny) {
                                continue;
                            }
                            if count < contacts.len() {
                                contacts[count] = Contact2D { normal, depth };
                                count += 1;
                            }
                        }
                    }
                }
            }
        }

        if count == 0 {
            return;
        }

        contacts[..count].sort_by(|a, b| b.depth.total_cmp(&a.depth));
        for c in &contacts[..count] {
            world.curr_pos[dyn_idx].x += c.normal.x * c.depth;
            world.curr_pos[dyn_idx].y += c.normal.y * c.depth;
            if c.normal.y > 0.5 {
                if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                    rb.grounded = true;
                }
            }
            let vel = &mut world.velocities[dyn_idx];
            let vn = vel.x * c.normal.x + vel.y * c.normal.y;
            if vn < 0.0 {
                vel.x -= c.normal.x * vn;
                vel.y -= c.normal.y * vn;
            }
        }
    }

    pub fn raycast_3d(
        &self,
        world: &World,
        origin: Vec3,
        dir: Vec3,
        max_dist: f32,
    ) -> Option<RayHit> {
        self.raycast_3d_ex(world, origin, dir, max_dist, u32::MAX, 0.0)
    }

    pub fn raycast_3d_ex(
        &self,
        world: &World,
        origin: Vec3,
        dir: Vec3,
        max_dist: f32,
        mask: u32,
        sphere_radius: f32,
    ) -> Option<RayHit> {
        let dir_len = dir.length();
        if dir_len < 1e-6 {
            return None;
        }
        let d = dir / dir_len;
        let r_pad = sphere_radius.max(0.0);
        let mut best: Option<RayHit> = None;
        let mut best_t = max_dist;

        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            if let Some(rb) = world.rigid_bodies[i] {
                if rb.is_trigger || (rb.layer & mask) == 0 {
                    continue;
                }
            } else if (1 & mask) == 0 {
                continue;
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let pos = world.curr_pos[i];
            let rot = world.curr_rot[i];
            let hit = match col {
                Collider3D::Aabb { half_extents } => {
                    ray_obb(origin, d, pos, rot, half_extents + Vec3::splat(r_pad))
                }
                Collider3D::Sphere { radius } => ray_sphere(origin, d, pos, radius + r_pad),
                Collider3D::Capsule {
                    radius,
                    half_height,
                } => {
                    let ext = Vec3::new(radius + r_pad, half_height + radius + r_pad, radius + r_pad);
                    ray_aabb(origin, d, pos - ext, pos + ext)
                }
            };
            if let Some((t, normal)) = hit {
                if t >= 0.0 && t < best_t {
                    best_t = t;
                    best = Some(RayHit {
                        entity: make_handle(world, i),
                        distance: t,
                        point: origin + d * t,
                        normal,
                    });
                }
            }
        }

        for mesh in &self.static_meshes {
            let (hit, _) = mesh.raycast(origin, d, best_t);
            if let Some((t, normal)) = hit {
                if t >= 0.0 && t < best_t {
                    best_t = t;
                    best = Some(RayHit {
                        entity: mesh.entity,
                        distance: t,
                        point: origin + d * t,
                        normal,
                    });
                }
            }
        }

        if let Some(hm) = &self.terrain {
            let step = (hm.cell_size * 0.45).clamp(0.15, 0.5);
            let mut prev_t = 0.0f32;
            let mut t = 0.0f32;
            while t <= best_t {
                let p = origin + d * t;
                if let Some((th, tn)) = hm.sample_height_and_normal(p.x, p.z) {
                    if p.y - r_pad <= th {
                        // Binary refine intersection
                        let mut lo = prev_t;
                        let mut hi = t;
                        let mut final_n = tn;
                        for _ in 0..6 {
                            let mid = 0.5 * (lo + hi);
                            let mp = origin + d * mid;
                            if let Some((mh, mn)) = hm.sample_height_and_normal(mp.x, mp.z) {
                                if mp.y - r_pad <= mh {
                                    hi = mid;
                                    final_n = mn;
                                } else {
                                    lo = mid;
                                }
                            } else {
                                lo = mid;
                            }
                        }
                        if hi < best_t {
                            best = Some(RayHit {
                                entity: self.terrain_entity,
                                distance: hi,
                                point: origin + d * hi,
                                normal: final_n,
                            });
                        }
                        break;
                    }
                }
                prev_t = t;
                t += step;
            }
        }
        best
    }

    pub fn raycast_static_meshes_counted(
        &self,
        origin: Vec3,
        dir: Vec3,
        max_dist: f32,
    ) -> (Option<(f32, Vec3)>, usize) {
        let d = dir.normalize_or_zero();
        let mut total_visited = 0usize;
        let mut best: Option<(f32, Vec3)> = None;
        let mut best_t = max_dist;
        for mesh in &self.static_meshes {
            let (hit, visited) = mesh.raycast(origin, d, best_t);
            total_visited += visited;
            if let Some((t, n)) = hit {
                if t < best_t {
                    best_t = t;
                    best = Some((t, n));
                }
            }
        }
        (best, total_visited)
    }

    pub fn query_mesh_aabb_counted(&mut self, mesh_idx: usize, qmin: Vec3, qmax: Vec3) -> usize {
        self.static_meshes
            .get(mesh_idx)
            .map_or(0, |m| m.query_aabb(qmin, qmax, &mut self.bvh_scratch))
    }
}

#[inline]
fn make_handle(world: &World, idx: usize) -> EntityHandle {
    ((world.generations[idx] as u32) << 20) | ((idx as u32) & 0xFFFFF)
}

#[inline]
fn hash_cell(x: i32, y: i32, z: i32) -> u64 {
    let ux = x as i64 as u64;
    let uy = y as i64 as u64;
    let uz = z as i64 as u64;
    ux.wrapping_mul(73856093) ^ uy.wrapping_mul(19349663) ^ uz.wrapping_mul(83492791)
}

#[inline]
fn layers_match(a: Option<RigidBody>, b: Option<RigidBody>) -> bool {
    let (la, ma) = a.map_or((1, u32::MAX), |r| (r.layer, r.mask));
    let (lb, mb) = b.map_or((1, u32::MAX), |r| (r.layer, r.mask));
    (la & mb) != 0 && (lb & ma) != 0
}

#[inline]
fn collider_inv_inertia(col: Option<Collider3D>, mass: f32) -> f32 {
    let m = mass.max(0.01);
    let r_sq = match col {
        Some(Collider3D::Aabb { half_extents }) => {
            let e = half_extents * 2.0;
            (e.x * e.x + e.y * e.y + e.z * e.z) / 12.0
        }
        Some(Collider3D::Sphere { radius }) => 0.4 * radius * radius,
        Some(Collider3D::Capsule { radius, half_height }) => {
            0.4 * (radius + half_height) * (radius + half_height)
        }
        None => 0.5,
    };
    1.0 / (m * r_sq.max(0.02))
}

#[inline]
fn collider3d_bounding_radius(col: Collider3D) -> f32 {
    match col {
        Collider3D::Sphere { radius } => radius,
        Collider3D::Capsule {
            radius,
            half_height,
        } => radius + half_height,
        Collider3D::Aabb { half_extents } => half_extents.length(),
    }
}

#[inline]
fn push_contact(
    contacts: &mut [ContactPoint],
    count: &mut usize,
    _other_idx: Option<usize>,
    _other_is_dynamic: bool,
    point: Vec3,
    normal: Vec3,
    depth: f32,
) {
    if depth > 0.0 && *count < contacts.len() {
        contacts[*count] = ContactPoint {
            point,
            normal,
            depth,
        };
        *count += 1;
    }
}

#[inline]
fn obb_corners(pos: Vec3, rot: Quat, h: Vec3) -> [Vec3; 8] {
    [
        pos + rot * Vec3::new(-h.x, -h.y, -h.z),
        pos + rot * Vec3::new(h.x, -h.y, -h.z),
        pos + rot * Vec3::new(-h.x, h.y, -h.z),
        pos + rot * Vec3::new(h.x, h.y, -h.z),
        pos + rot * Vec3::new(-h.x, -h.y, h.z),
        pos + rot * Vec3::new(h.x, -h.y, h.z),
        pos + rot * Vec3::new(-h.x, h.y, h.z),
        pos + rot * Vec3::new(h.x, h.y, h.z),
    ]
}

#[allow(clippy::too_many_arguments)]
fn collect_3d_contacts(
    a: Collider3D,
    pa: Vec3,
    ra: Quat,
    b: Collider3D,
    pb: Vec3,
    rb: Quat,
    other_idx: Option<usize>,
    other_is_dynamic: bool,
    contacts: &mut [ContactPoint],
    count: &mut usize,
) {
    match (a, b) {
        (Collider3D::Aabb { half_extents: ha }, Collider3D::Aabb { half_extents: hb }) => {
            obb_vs_obb_sat(
                pa,
                ra,
                ha,
                pb,
                rb,
                hb,
                other_idx,
                other_is_dynamic,
                contacts,
                count,
            );
        }
        (Collider3D::Sphere { radius }, Collider3D::Aabb { half_extents }) => {
            let local_center = rb.conjugate() * (pa - pb);
            if let Some((ln, depth, local_closest)) =
                sphere_vs_local_box(local_center, radius, half_extents)
            {
                push_contact(
                    contacts,
                    count,
                    other_idx,
                    other_is_dynamic,
                    pb + rb * local_closest,
                    rb * ln,
                    depth,
                );
            }
        }
        (Collider3D::Aabb { half_extents }, Collider3D::Sphere { radius }) => {
            let local_center = ra.conjugate() * (pb - pa);
            if let Some((ln, depth, local_closest)) =
                sphere_vs_local_box(local_center, radius, half_extents)
            {
                push_contact(
                    contacts,
                    count,
                    other_idx,
                    other_is_dynamic,
                    pa + ra * local_closest,
                    -(ra * ln),
                    depth,
                );
            }
        }
        (Collider3D::Sphere { radius: r1 }, Collider3D::Sphere { radius: r2 }) => {
            if let Some((n, d)) = sphere_vs_sphere(pa, r1, pb, r2) {
                push_contact(
                    contacts,
                    count,
                    other_idx,
                    other_is_dynamic,
                    pb + n * r2,
                    n,
                    d,
                );
            }
        }
        (
            Collider3D::Capsule {
                radius,
                half_height,
            },
            Collider3D::Aabb { half_extents },
        ) => {
            if let Some((n, d)) = capsule_vs_aabb(pa, radius, half_height, pb, half_extents) {
                push_contact(
                    contacts,
                    count,
                    other_idx,
                    other_is_dynamic,
                    pa - n * radius,
                    n,
                    d,
                );
            }
        }
        (
            Collider3D::Capsule {
                radius: r1,
                half_height: h1,
            },
            Collider3D::Sphere { radius: r2 },
        ) => {
            let clamped_y = pb.y.clamp(pa.y - h1, pa.y + h1);
            if let Some((n, d)) = sphere_vs_sphere(Vec3::new(pa.x, clamped_y, pa.z), r1, pb, r2) {
                push_contact(
                    contacts,
                    count,
                    other_idx,
                    other_is_dynamic,
                    pb + n * r2,
                    n,
                    d,
                );
            }
        }
        (
            Collider3D::Capsule {
                radius: r1,
                half_height: h1,
            },
            Collider3D::Capsule {
                radius: r2,
                half_height: h2,
            },
        ) => {
            let y1 = pb.y.clamp(pa.y - h1, pa.y + h1);
            let y2 = y1.clamp(pb.y - h2, pb.y + h2);
            if let Some((n, d)) =
                sphere_vs_sphere(Vec3::new(pa.x, y1, pa.z), r1, Vec3::new(pb.x, y2, pb.z), r2)
            {
                push_contact(
                    contacts,
                    count,
                    other_idx,
                    other_is_dynamic,
                    Vec3::new(pb.x, y2, pb.z) + n * r2,
                    n,
                    d,
                );
            }
        }
        (Collider3D::Aabb { .. }, Collider3D::Capsule { .. })
        | (Collider3D::Sphere { .. }, Collider3D::Capsule { .. }) => {
            let before = *count;
            collect_3d_contacts(b, pb, rb, a, pa, ra, other_idx, other_is_dynamic, contacts, count);
            for c in &mut contacts[before..*count] {
                c.normal = -c.normal;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn obb_vs_obb_sat(
    pa: Vec3,
    ra: Quat,
    ha: Vec3,
    pb: Vec3,
    rb: Quat,
    hb: Vec3,
    other_idx: Option<usize>,
    other_is_dynamic: bool,
    contacts: &mut [ContactPoint],
    count: &mut usize,
) {
    let ma = Mat3::from_quat(ra);
    let mb = Mat3::from_quat(rb);
    let ax = [ma.x_axis, ma.y_axis, ma.z_axis];
    let bx = [mb.x_axis, mb.y_axis, mb.z_axis];
    let t = pa - pb;

    let mut best_score = f32::INFINITY;
    let mut best_depth = 0.0f32;
    let mut best_axis = Vec3::Y;

    let mut test_axis = |axis: Vec3, is_edge: bool| -> bool {
        let len_sq = axis.length_squared();
        if len_sq < 1e-8 {
            return true;
        }
        let l = axis / len_sq.sqrt();
        let proj_a = ha.x * ax[0].dot(l).abs() + ha.y * ax[1].dot(l).abs() + ha.z * ax[2].dot(l).abs();
        let proj_b = hb.x * bx[0].dot(l).abs() + hb.y * bx[1].dot(l).abs() + hb.z * bx[2].dot(l).abs();
        let dist = t.dot(l).abs();
        let overlap = proj_a + proj_b - dist;
        if overlap <= 0.0 {
            return false;
        }
        let score = if is_edge { overlap * 1.04 } else { overlap };
        if score < best_score {
            best_score = score;
            best_depth = overlap;
            best_axis = l;
        }
        true
    };

    for i in 0..3 {
        if !test_axis(ax[i], false) {
            return;
        }
    }
    for i in 0..3 {
        if !test_axis(bx[i], false) {
            return;
        }
    }
    for i in 0..3 {
        for j in 0..3 {
            if !test_axis(ax[i].cross(bx[j]), true) {
                return;
            }
        }
    }

    let normal = if t.dot(best_axis) >= 0.0 {
        best_axis
    } else {
        -best_axis
    };

    let eps = 1e-3;
    let start_count = *count;

    // Collect penetrating corners of A inside B (using <= so aligned faces emit all 4 support corners!)
    let inv_rb = rb.conjugate();
    for corner in obb_corners(pa, ra, ha) {
        let local = inv_rb * (corner - pb);
        if local.x.abs() <= hb.x + eps
            && local.y.abs() <= hb.y + eps
            && local.z.abs() <= hb.z + eps
        {
            push_contact(
                contacts,
                count,
                other_idx,
                other_is_dynamic,
                corner,
                normal,
                best_depth,
            );
        }
    }

    // Collect penetrating corners of B inside A
    let inv_ra = ra.conjugate();
    for corner in obb_corners(pb, rb, hb) {
        let local = inv_ra * (corner - pa);
        if local.x.abs() <= ha.x + eps
            && local.y.abs() <= ha.y + eps
            && local.z.abs() <= ha.z + eps
        {
            push_contact(
                contacts,
                count,
                other_idx,
                other_is_dynamic,
                corner,
                normal,
                best_depth,
            );
        }
    }

    // Edge-edge or exact parallel face contact where neither corner set fell inside:
    // emit midpoint between A's and B's support faces along `normal`.
    if *count == start_count {
        let sup_a = pa
            - ma * Vec3::new(
                if ax[0].dot(normal) >= 0.0 { ha.x } else { -ha.x },
                if ax[1].dot(normal) >= 0.0 { ha.y } else { -ha.y },
                if ax[2].dot(normal) >= 0.0 { ha.z } else { -ha.z },
            );
        let sup_b = pb
            + mb * Vec3::new(
                if bx[0].dot(normal) >= 0.0 { hb.x } else { -hb.x },
                if bx[1].dot(normal) >= 0.0 { hb.y } else { -hb.y },
                if bx[2].dot(normal) >= 0.0 { hb.z } else { -hb.z },
            );
        push_contact(
            contacts,
            count,
            other_idx,
            other_is_dynamic,
            (sup_a + sup_b) * 0.5,
            normal,
            best_depth,
        );
    }
}

fn collect_triangle_contacts(
    col: Collider3D,
    pos: Vec3,
    rot: Quat,
    tri: [Vec3; 3],
    contacts: &mut [ContactPoint],
    count: &mut usize,
) {
    match col {
        Collider3D::Sphere { radius } => {
            if let Some((n, d)) = sphere_vs_triangle(pos, radius, tri) {
                push_contact(contacts, count, None, false, pos - n * radius, n, d);
            }
        }
        Collider3D::Capsule {
            radius,
            half_height,
        } => {
            let samples = [pos.y - half_height, pos.y, pos.y + half_height];
            let mut best: Option<(Vec3, f32, Vec3)> = None;
            for y in samples {
                let sp = Vec3::new(pos.x, y, pos.z);
                if let Some((n, d)) = sphere_vs_triangle(sp, radius, tri) {
                    if best.map_or(true, |(_, bd, _)| d > bd) {
                        best = Some((n, d, sp - n * radius));
                    }
                }
            }
            if let Some((n, d, pt)) = best {
                push_contact(contacts, count, None, false, pt, n, d);
            }
        }
        Collider3D::Aabb { half_extents } => {
            let tri_n = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
            if tri_n.length_squared() < 1e-6 {
                return;
            }
            let center_dist = (pos - tri[0]).dot(tri_n);
            if center_dist < -half_extents.length() {
                return;
            }

            let corners = obb_corners(pos, rot, half_extents);
            for corner in corners {
                let d_plane = (corner - tri[0]).dot(tri_n);
                if d_plane < 0.0 && d_plane > -0.65 {
                    let proj = corner - tri_n * d_plane;
                    if point_in_triangle(proj, tri[0], tri[1], tri[2], 0.02) {
                        push_contact(contacts, count, None, false, corner, tri_n, -d_plane);
                    }
                }
            }

            let inv_rot = rot.conjugate();
            for v in tri {
                let local = inv_rot * (v - pos);
                if local.x.abs() < half_extents.x
                    && local.y.abs() < half_extents.y
                    && local.z.abs() < half_extents.z
                {
                    let dx_min = local.x + half_extents.x;
                    let dx_max = half_extents.x - local.x;
                    let dy_min = local.y + half_extents.y;
                    let dy_max = half_extents.y - local.y;
                    let dz_min = local.z + half_extents.z;
                    let dz_max = half_extents.z - local.z;
                    let mut best_d = dy_min;
                    let mut best_ln = Vec3::Y;
                    for &(d, ln) in &[
                        (dy_max, Vec3::NEG_Y),
                        (dx_min, Vec3::X),
                        (dx_max, Vec3::NEG_X),
                        (dz_min, Vec3::Z),
                        (dz_max, Vec3::NEG_Z),
                    ] {
                        if d < best_d {
                            best_d = d;
                            best_ln = ln;
                        }
                    }
                    push_contact(contacts, count, None, false, v, rot * best_ln, best_d);
                }
            }
        }
    }
}

fn point_in_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3, margin: f32) -> bool {
    let v0 = b - a;
    let v1 = c - a;
    let v2 = p - a;
    let d00 = v0.dot(v0);
    let d01 = v0.dot(v1);
    let d11 = v1.dot(v1);
    let d20 = v2.dot(v0);
    let d21 = v2.dot(v1);
    let denom = d00 * d11 - d01 * d01;
    if denom.abs() < 1e-8 {
        return false;
    }
    let v = (d11 * d20 - d01 * d21) / denom;
    let w = (d00 * d21 - d01 * d20) / denom;
    let u = 1.0 - v - w;
    u >= -margin && v >= -margin && w >= -margin
}

fn sphere_vs_local_box(center: Vec3, radius: f32, half: Vec3) -> Option<(Vec3, f32, Vec3)> {
    let closest = center.clamp(-half, half);
    let diff = center - closest;
    let dist_sq = diff.length_squared();
    if dist_sq >= radius * radius {
        return None;
    }
    if dist_sq > 1e-8 {
        let dist = dist_sq.sqrt();
        return Some((diff / dist, radius - dist, closest));
    }
    let dx_min = (center.x + half.x).abs();
    let dx_max = (half.x - center.x).abs();
    let dy_min = (center.y + half.y).abs();
    let dy_max = (half.y - center.y).abs();
    let dz_min = (center.z + half.z).abs();
    let dz_max = (half.z - center.z).abs();
    let mut best_dist = dy_max;
    let mut best_normal = Vec3::Y;
    for &(d, n) in &[
        (dy_min, Vec3::NEG_Y),
        (dx_min, Vec3::NEG_X),
        (dx_max, Vec3::X),
        (dz_min, Vec3::NEG_Z),
        (dz_max, Vec3::Z),
    ] {
        if d < best_dist {
            best_dist = d;
            best_normal = n;
        }
    }
    Some((best_normal, radius + best_dist, closest))
}

fn sphere_vs_sphere(pa: Vec3, ra: f32, pb: Vec3, rb: f32) -> Option<(Vec3, f32)> {
    let diff = pa - pb;
    let dist_sq = diff.length_squared();
    let r_sum = ra + rb;
    if dist_sq >= r_sum * r_sum {
        return None;
    }
    let dist = dist_sq.sqrt();
    if dist < 1e-6 {
        return Some((Vec3::Y, r_sum));
    }
    Some((diff / dist, r_sum - dist))
}

fn sphere_vs_aabb(center: Vec3, radius: f32, box_pos: Vec3, half: Vec3) -> Option<(Vec3, f32)> {
    sphere_vs_local_box(center - box_pos, radius, half).map(|(n, d, _)| (n, d))
}

fn capsule_vs_aabb(
    cap_pos: Vec3,
    radius: f32,
    half_height: f32,
    box_pos: Vec3,
    half: Vec3,
) -> Option<(Vec3, f32)> {
    let seg_min_y = cap_pos.y - half_height;
    let seg_max_y = cap_pos.y + half_height;
    let box_min_y = box_pos.y - half.y;
    let box_max_y = box_pos.y + half.y;

    let sample_y = if seg_max_y < box_min_y {
        seg_max_y
    } else if seg_min_y > box_max_y {
        seg_min_y
    } else {
        box_pos.y.clamp(seg_min_y, seg_max_y)
    };

    let mut best: Option<(Vec3, f32)> = None;
    for &y in &[seg_min_y, sample_y, seg_max_y] {
        if let Some((n, d)) =
            sphere_vs_aabb(Vec3::new(cap_pos.x, y, cap_pos.z), radius, box_pos, half)
        {
            let replace = match best {
                None => true,
                Some((bn, bd)) => {
                    if (n.y > 0.5) != (bn.y > 0.5) {
                        n.y > 0.5
                    } else {
                        d > bd
                    }
                }
            };
            if replace {
                best = Some((n, d));
            }
        }
    }
    best
}

fn sphere_vs_triangle(center: Vec3, radius: f32, tri: [Vec3; 3]) -> Option<(Vec3, f32)> {
    let closest = closest_point_on_triangle(center, tri[0], tri[1], tri[2]);
    let diff = center - closest;
    let dist_sq = diff.length_squared();
    if dist_sq >= radius * radius {
        return None;
    }
    let dist = dist_sq.sqrt();
    if dist < 1e-6 {
        let tri_n = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
        return Some((
            if tri_n.length_squared() > 0.0 {
                tri_n
            } else {
                Vec3::Y
            },
            radius,
        ));
    }
    Some((diff / dist, radius - dist))
}

fn closest_point_on_triangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    let ab = b - a;
    let ac = c - a;
    let ap = p - a;

    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return a;
    }

    let bp = p - b;
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return b;
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return a + ab * v;
    }

    let cp = p - c;
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return c;
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return a + ac * w;
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return b + (c - b) * w;
    }

    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    a + ab * v + ac * w
}

fn intersect_2d(a: Collider2D, pa: Vec2, b: Collider2D, pb: Vec2) -> Option<(Vec2, f32)> {
    match (a, b) {
        (Collider2D::Circle2D { radius }, Collider2D::Aabb2D { half_extents }) => {
            let min = pb - half_extents;
            let max = pb + half_extents;
            let closest = pa.clamp(min, max);
            let diff = pa - closest;
            let dist_sq = diff.length_squared();
            if dist_sq >= radius * radius {
                return None;
            }
            if dist_sq > 1e-8 {
                let dist = dist_sq.sqrt();
                return Some((diff / dist, radius - dist));
            }
            let dx = (half_extents.x - (pa.x - pb.x).abs()).max(0.0);
            let dy = (half_extents.y - (pa.y - pb.y).abs()).max(0.0);
            if dy <= dx {
                let sy = if pa.y >= pb.y { 1.0 } else { -1.0 };
                Some((Vec2::new(0.0, sy), radius + dy))
            } else {
                let sx = if pa.x >= pb.x { 1.0 } else { -1.0 };
                Some((Vec2::new(sx, 0.0), radius + dx))
            }
        }
        (Collider2D::Aabb2D { half_extents }, Collider2D::Circle2D { radius }) => intersect_2d(
            Collider2D::Circle2D { radius },
            pb,
            Collider2D::Aabb2D { half_extents },
            pa,
        )
        .map(|(n, d)| (-n, d)),
        (Collider2D::Circle2D { radius: r1 }, Collider2D::Circle2D { radius: r2 }) => {
            let diff = pa - pb;
            let dist_sq = diff.length_squared();
            let r_sum = r1 + r2;
            if dist_sq >= r_sum * r_sum {
                return None;
            }
            let dist = dist_sq.sqrt();
            if dist < 1e-6 {
                return Some((Vec2::Y, r_sum));
            }
            Some((diff / dist, r_sum - dist))
        }
        (Collider2D::Aabb2D { half_extents: ha }, Collider2D::Aabb2D { half_extents: hb }) => {
            let diff = pa - pb;
            let overlap = (ha + hb) - diff.abs();
            if overlap.x <= 0.0 || overlap.y <= 0.0 {
                return None;
            }
            if overlap.y <= overlap.x {
                Some((
                    Vec2::new(0.0, if diff.y >= 0.0 { 1.0 } else { -1.0 }),
                    overlap.y,
                ))
            } else {
                Some((
                    Vec2::new(if diff.x >= 0.0 { 1.0 } else { -1.0 }, 0.0),
                    overlap.x,
                ))
            }
        }
    }
}

fn ray_triangle(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3) -> Option<(f32, Vec3)> {
    let e1 = b - a;
    let e2 = c - a;
    let h = dir.cross(e2);
    let det = e1.dot(h);
    if det.abs() < 1e-7 {
        return None;
    }
    let inv_det = 1.0 / det;
    let s = origin - a;
    let u = inv_det * s.dot(h);
    if !(0.0..=1.0).contains(&u) {
        return None;
    }
    let q = s.cross(e1);
    let v = inv_det * dir.dot(q);
    if v < 0.0 || u + v > 1.0 {
        return None;
    }
    let t = inv_det * e2.dot(q);
    if t < 0.0 {
        return None;
    }
    let n = e1.cross(e2).normalize_or_zero();
    Some((t, if n.dot(dir) <= 0.0 { n } else { -n }))
}

fn ray_obb(origin: Vec3, dir: Vec3, pos: Vec3, rot: Quat, half: Vec3) -> Option<(f32, Vec3)> {
    let inv = rot.conjugate();
    let local_o = inv * (origin - pos);
    let local_d = inv * dir;
    ray_aabb(local_o, local_d, -half, half).map(|(t, ln)| (t, rot * ln))
}

fn ray_aabb(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3) -> Option<(f32, Vec3)> {
    let mut tmin = f32::NEG_INFINITY;
    let mut tmax = f32::INFINITY;
    let mut hit_normal = Vec3::ZERO;

    for axis in 0..3 {
        let o = origin[axis];
        let d = dir[axis];
        let bmin = min[axis];
        let bmax = max[axis];
        if d.abs() < 1e-8 {
            if o < bmin || o > bmax {
                return None;
            }
        } else {
            let inv = 1.0 / d;
            let mut t1 = (bmin - o) * inv;
            let mut t2 = (bmax - o) * inv;
            let mut n = Vec3::ZERO;
            n[axis] = if inv >= 0.0 { -1.0 } else { 1.0 };
            if t1 > t2 {
                std::mem::swap(&mut t1, &mut t2);
                n[axis] = -n[axis];
            }
            if t1 > tmin {
                tmin = t1;
                hit_normal = n;
            }
            tmax = tmax.min(t2);
            if tmin > tmax {
                return None;
            }
        }
    }
    if tmax < 0.0 {
        return None;
    }
    Some((tmin.max(0.0), hit_normal))
}

fn ray_sphere(origin: Vec3, dir: Vec3, center: Vec3, radius: f32) -> Option<(f32, Vec3)> {
    let oc = origin - center;
    let b = oc.dot(dir);
    let c = oc.dot(oc) - radius * radius;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let t = -b - disc.sqrt();
    if t < 0.0 {
        return None;
    }
    let hit_pt = origin + dir * t;
    Some((t, (hit_pt - center).normalize_or_zero()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecs::{entity_index, Collider2D, Collider3D, RigidBody, World};
    use glam::{Quat, Vec2, Vec3};

    #[test]
    fn test_clamp_huge_frame_dt_prevents_spiral() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());
        let e = world.spawn();
        world.set_transform_immediate(e, Vec3::ZERO, Quat::IDENTITY, Vec3::ONE);
        world.velocities[entity_index(e)] = Vec3::new(10.0, 0.0, 0.0);
        world.rigid_bodies[entity_index(e)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            linear_damping: 0.0,
            ..Default::default()
        });

        let result = phys.step(&mut world, 5.0);
        assert!(result.steps_executed <= phys.config.max_substeps);
        assert!(world.curr_pos[entity_index(e)].x <= 1.05);
    }

    #[test]
    fn test_capsule_wall_slide_without_jitter() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig {
            gravity: Vec3::ZERO,
            ..Default::default()
        });

        let wall = world.spawn();
        world.set_transform_immediate(wall, Vec3::new(0.0, 1.0, 2.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(wall)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(10.0, 2.0, 0.5),
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(0.0, 1.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.4,
            half_height: 0.5,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            friction: 0.0,
            lock_rotation: true,
            ..Default::default()
        });

        let mut prev_z = 0.0f32;
        let mut max_z_osc = 0.0f32;
        for tick in 0..120 {
            world.velocities[entity_index(player)] = Vec3::new(4.0, 0.0, 4.0);
            phys.step(&mut world, 1.0 / 60.0);
            let pos = world.curr_pos[entity_index(player)];
            assert!(pos.x > 0.0);
            assert!(pos.z <= 1.105, "penetrated wall: z={}", pos.z);
            if tick > 30 {
                max_z_osc = max_z_osc.max((pos.z - prev_z).abs());
            }
            prev_z = pos.z;
        }
        assert!(world.curr_pos[entity_index(player)].x > 7.5);
        assert!(max_z_osc < 1e-4, "z jitter detected: {max_z_osc}");
    }

    #[test]
    fn test_adjacent_tile_seam_no_snag() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig {
            gravity: Vec3::ZERO,
            ..Default::default()
        });

        let tile1 = world.spawn();
        world.set_transform_immediate(tile1, Vec3::new(1.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(tile1)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(1.0, 0.5, 2.0),
        });
        let tile2 = world.spawn();
        world.set_transform_immediate(tile2, Vec3::new(4.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(tile2)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(2.0, 0.5, 2.0),
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(0.5, 0.9, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.4,
            half_height: 0.5,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            friction: 0.0,
            lock_rotation: true,
            ..Default::default()
        });

        for _ in 0..90 {
            world.velocities[entity_index(player)] = Vec3::new(3.0, -1.0, 0.0);
            phys.step(&mut world, 1.0 / 60.0);
        }

        let pos = world.curr_pos[entity_index(player)];
        assert!(pos.x > 3.2, "snagged on floor seam at x=2.0! pos.x={}", pos.x);
        assert!((pos.y - 0.9).abs() < 0.015, "unexpected y shift: {}", pos.y);

        let w1 = world.spawn();
        world.set_transform_immediate(w1, Vec3::new(1.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_2d[entity_index(w1)] = Some(Collider2D::Aabb2D {
            half_extents: Vec2::new(1.0, 0.5),
        });
        let w2 = world.spawn();
        world.set_transform_immediate(w2, Vec3::new(4.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_2d[entity_index(w2)] = Some(Collider2D::Aabb2D {
            half_extents: Vec2::new(2.0, 0.5),
        });
        let mover2d = world.spawn();
        world.set_transform_immediate(mover2d, Vec3::new(0.5, 0.9, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_2d[entity_index(mover2d)] = Some(Collider2D::Circle2D { radius: 0.4 });
        world.rigid_bodies[entity_index(mover2d)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            friction: 0.0,
            lock_rotation: true,
            ..Default::default()
        });
        for _ in 0..90 {
            world.velocities[entity_index(mover2d)] = Vec3::new(3.0, -1.0, 0.0);
            phys.step(&mut world, 1.0 / 60.0);
        }
        assert!(world.curr_pos[entity_index(mover2d)].x > 3.2);
    }

    #[test]
    fn test_gravity_ground_landing_and_stability() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(10.0, 0.5, 10.0),
        });

        let ball = world.spawn();
        world.set_transform_immediate(ball, Vec3::new(0.0, 3.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(ball)] = Some(Collider3D::Sphere { radius: 0.5 });
        world.rigid_bodies[entity_index(ball)] = Some(RigidBody::default());

        for _ in 0..120 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let pos = world.curr_pos[entity_index(ball)];
        let rb = world.rigid_bodies[entity_index(ball)].unwrap();
        assert!(rb.grounded);
        assert!((pos.y - 0.5).abs() < 0.01, "expected y=0.5, got {}", pos.y);
        assert!(world.velocities[entity_index(ball)].y.abs() < 1e-3);
    }

    #[test]
    fn test_raycast_3d_hits_aabb() {
        let mut world = World::new();
        let phys = PhysicsWorld::new(PhysicsConfig::default());
        let box_e = world.spawn();
        world.set_transform_immediate(box_e, Vec3::new(0.0, 0.0, 5.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(box_e)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(1.0),
        });

        let hit = phys.raycast_3d(&world, Vec3::ZERO, Vec3::Z, 20.0).unwrap();
        assert_eq!(hit.entity, box_e);
        assert!((hit.distance - 4.0).abs() < 1e-4);
    }

    #[test]
    fn test_cube_stops_sliding_due_to_friction() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(30.0, 0.5, 30.0),
        });

        let cube = world.spawn();
        world.set_transform_immediate(cube, Vec3::new(0.0, 0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(cube)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(cube)] = Some(RigidBody {
            dynamic: true,
            friction: 0.8,
            ..Default::default()
        });
        world.velocities[entity_index(cube)] = Vec3::new(6.0, 0.0, 0.0);

        for _ in 0..180 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let vel = world.velocities[entity_index(cube)];
        assert!(vel.x.abs() < 0.08, "cube kept sliding endlessly: vx={}", vel.x);
    }

    #[test]
    fn test_cube_tilts_on_ramp() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let ramp = world.spawn();
        world.set_transform_immediate(ramp, Vec3::ZERO, Quat::IDENTITY, Vec3::ONE);
        let h = 2.3;
        let p0 = Vec3::new(-5.0, 0.0, 5.0);
        let p1 = Vec3::new(5.0, 0.0, 5.0);
        let p2 = Vec3::new(5.0, h, -5.0);
        let p3 = Vec3::new(-5.0, h, -5.0);
        phys.add_static_mesh(ramp, vec![[p0, p1, p2], [p0, p2, p3]]);

        let cube = world.spawn();
        world.set_transform_immediate(cube, Vec3::new(0.0, 2.2, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(cube)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(cube)] = Some(RigidBody {
            dynamic: true,
            friction: 0.6,
            lock_rotation: false,
            ..Default::default()
        });

        for _ in 0..90 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let rot = world.curr_rot[entity_index(cube)];
        let tilt_angle = rot.angle_between(Quat::IDENTITY);
        assert!(
            tilt_angle > 0.12,
            "cube did not tilt on ramp! angle={tilt_angle}"
        );
    }

    #[test]
    fn test_bvh_20k_triangles_visits_under_64() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let mut tris = Vec::with_capacity(20_000);
        for z in 0..100 {
            for x in 0..100 {
                let x0 = x as f32;
                let z0 = z as f32;
                let p0 = Vec3::new(x0, 0.0, z0);
                let p1 = Vec3::new(x0 + 1.0, 0.0, z0);
                let p2 = Vec3::new(x0 + 1.0, 0.0, z0 + 1.0);
                let p3 = Vec3::new(x0, 0.0, z0 + 1.0);
                tris.push([p0, p2, p1]);
                tris.push([p0, p3, p2]);
            }
        }
        assert_eq!(tris.len(), 20_000);
        let terrain = world.spawn();
        phys.add_static_mesh(terrain, tris);

        let (hit, ray_visited) =
            phys.raycast_static_meshes_counted(Vec3::new(50.3, 5.0, 50.3), Vec3::NEG_Y, 20.0);
        assert!(hit.is_some());
        assert!(ray_visited < 64, "BVH visited too many triangles on raycast: {ray_visited}");

        let query_visited = phys.query_mesh_aabb_counted(
            0,
            Vec3::new(49.5, -0.5, 49.5),
            Vec3::new(51.0, 0.5, 51.0),
        );
        assert!(query_visited < 64, "BVH visited too many triangles on AABB query: {query_visited}");
    }

    #[test]
    fn test_broadphase_and_sleeping_500_bodies() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(200.0, 0.5, 200.0),
        });

        let mut cubes = Vec::with_capacity(500);
        for i in 0..500 {
            let x = ((i % 25) as f32 - 12.0) * 2.2;
            let z = ((i / 25) as f32 - 10.0) * 2.2;
            let c = world.spawn();
            world.set_transform_immediate(c, Vec3::new(x, 0.52, z), Quat::IDENTITY, Vec3::ONE);
            world.colliders_3d[entity_index(c)] = Some(Collider3D::Aabb {
                half_extents: Vec3::splat(0.45),
            });
            world.rigid_bodies[entity_index(c)] = Some(RigidBody::default());
            cubes.push(c);
        }

        for _ in 0..90 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let sleeping_count = cubes
            .iter()
            .filter(|&&c| world.rigid_bodies[entity_index(c)].unwrap().sleeping)
            .count();
        assert!(sleeping_count >= 450, "expected bodies to sleep, got {sleeping_count}/500");

        let target = cubes[0];
        assert!(phys.apply_impulse(&mut world, target, Vec3::new(0.0, 6.0, 0.0), None));
        assert!(!world.rigid_bodies[entity_index(target)].unwrap().sleeping);
    }

    #[test]
    fn test_trigger_enter_exit_and_collision_layers() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig {
            gravity: Vec3::ZERO,
            ..Default::default()
        });

        let sensor = world.spawn();
        world.set_transform_immediate(sensor, Vec3::new(3.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(sensor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(1.0),
        });
        world.rigid_bodies[entity_index(sensor)] = Some(RigidBody {
            dynamic: false,
            is_trigger: true,
            layer: 0b01,
            mask: 0b01,
            ..Default::default()
        });

        let mover = world.spawn();
        world.set_transform_immediate(mover, Vec3::new(0.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(mover)] = Some(Collider3D::Sphere { radius: 0.5 });
        world.rigid_bodies[entity_index(mover)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            linear_damping: 0.0,
            layer: 0b01,
            mask: 0b01,
            ..Default::default()
        });
        world.velocities[entity_index(mover)] = Vec3::new(6.0, 0.0, 0.0);

        let mut entered = false;
        let mut exited = false;
        for _ in 0..90 {
            phys.clear_events();
            phys.step(&mut world, 1.0 / 60.0);
            for ev in phys.events() {
                if ev.kind == EVENT_TRIGGER_ENTER {
                    entered = true;
                }
                if ev.kind == EVENT_TRIGGER_EXIT {
                    exited = true;
                }
            }
        }
        assert!(entered, "TriggerEnter never fired");
        assert!(exited, "TriggerExit never fired");
        assert!(world.curr_pos[entity_index(mover)].x > 7.5);

        let blocker = world.spawn();
        world.set_transform_immediate(blocker, Vec3::new(10.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(blocker)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(1.0),
        });
        world.rigid_bodies[entity_index(blocker)] = Some(RigidBody {
            dynamic: false,
            layer: 0b10,
            mask: 0b10,
            ..Default::default()
        });
        for _ in 0..60 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        assert!(world.curr_pos[entity_index(mover)].x > 12.0);
    }

    #[test]
    fn test_aligned_stacked_cubes_do_not_pass_through() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(30.0, 0.5, 30.0),
        });

        // Stacked cubes with identical X, Z and unrotated IDENTITY orientation
        let bottom = world.spawn();
        world.set_transform_immediate(bottom, Vec3::new(0.0, 0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(bottom)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(bottom)] = Some(RigidBody::default());

        let top = world.spawn();
        world.set_transform_immediate(top, Vec3::new(0.0, 1.55, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(top)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(top)] = Some(RigidBody::default());

        // Horizontal striker cube at identical Y=0.5, Z=0.0
        let striker = world.spawn();
        world.set_transform_immediate(striker, Vec3::new(-2.5, 0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(striker)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(striker)] = Some(RigidBody::default());
        world.velocities[entity_index(striker)] = Vec3::new(6.0, 0.0, 0.0);

        for _ in 0..90 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let bottom_pos = world.curr_pos[entity_index(bottom)];
        let top_pos = world.curr_pos[entity_index(top)];
        let striker_pos = world.curr_pos[entity_index(striker)];

        // Cubes must not pass through each other horizontally or vertically
        assert!(
            striker_pos.x < bottom_pos.x - 0.85,
            "striker cube passed through bottom cube! striker={:?}, bottom={:?}",
            striker_pos,
            bottom_pos
        );
        assert!(
            top_pos.y > 1.35 || top_pos.distance(bottom_pos) > 0.9,
            "top cube fell straight through bottom cube! top={:?}, bottom={:?}",
            top_pos,
            bottom_pos
        );
    }

    #[test]
    fn test_character_controller_steps_up_stair() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(20.0, 0.5, 20.0),
        });

        // Step 0.35m tall from y=0..0.35 at z = 1..5
        let step = world.spawn();
        world.set_transform_immediate(step, Vec3::new(0.0, 0.175, 3.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(step)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(3.0, 0.175, 2.0),
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(0.0, 0.9, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.4,
            half_height: 0.5,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            lock_rotation: true,
            friction: 0.0,
            ..Default::default()
        });
        phys.set_character_controller(player, 0.5, 50.0);

        for _ in 0..70 {
            world.velocities[entity_index(player)].z = 4.0;
            phys.step(&mut world, 1.0 / 60.0);
        }

        let pos = world.curr_pos[entity_index(player)];
        assert!(pos.z > 1.2, "character blocked by stair step instead of climbing: {pos:?}");
        assert!(pos.y >= 1.15, "character did not rise onto step: {pos:?}");
    }

    #[test]
    fn test_character_controller_rides_moving_platform() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let plat = world.spawn();
        world.set_transform_immediate(plat, Vec3::new(0.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(plat)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(3.0, 0.25, 3.0),
        });
        world.rigid_bodies[entity_index(plat)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            mass: 500.0,
            lock_rotation: true,
            linear_damping: 0.0,
            ..Default::default()
        });

        let rider = world.spawn();
        world.set_transform_immediate(rider, Vec3::new(0.0, 1.15, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(rider)] = Some(Collider3D::Capsule {
            radius: 0.4,
            half_height: 0.5,
        });
        world.rigid_bodies[entity_index(rider)] = Some(RigidBody {
            dynamic: true,
            lock_rotation: true,
            ..Default::default()
        });
        phys.set_character_controller(rider, 0.4, 50.0);

        // Settle onto platform
        for _ in 0..20 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        let start_x = world.curr_pos[entity_index(rider)].x;

        // Move platform sideways at 3 m/s
        for _ in 0..60 {
            world.velocities[entity_index(plat)] = Vec3::new(3.0, 0.0, 0.0);
            phys.step(&mut world, 1.0 / 60.0);
        }
        let end_x = world.curr_pos[entity_index(rider)].x;
        let plat_x = world.curr_pos[entity_index(plat)].x;
        assert!(
            end_x - start_x > 2.2 && (end_x - plat_x).abs() < 0.4,
            "rider slipped off moving platform: rider_x={end_x}, plat_x={plat_x}"
        );
    }

    #[test]
    fn test_terrain_heightmap_physics_collision_and_raycast() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());
        let heights = vec![
            0.0, 0.0, 2.0,
            0.0, 0.0, 2.0,
            0.0, 0.0, 2.0,
        ];
        phys.terrain = TerrainHeightmap::new(-4.0, -4.0, 4.0, 3, 3, heights);

        let box_e = world.spawn();
        world.set_transform_immediate(box_e, Vec3::new(2.0, 4.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(box_e)] = Some(Collider3D::Capsule {
            radius: 0.4,
            half_height: 0.4,
        });
        world.rigid_bodies[entity_index(box_e)] = Some(RigidBody {
            lock_rotation: true,
            friction: 1.5,
            ..Default::default()
        });

        for _ in 0..45 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        let bp = world.curr_pos[entity_index(box_e)];
        // Terrain around x=1..2 is sloped ~1.0..1.5 -> capsule bottom (y - 0.8) rests above slope!
        assert!(bp.y > 1.3 && bp.y < 3.0, "body rested wrong on terrain: {bp:?}");

        let ray = phys.raycast_3d(&world, Vec3::new(0.0, 6.0, 0.0), -Vec3::Y, 20.0);
        assert!(ray.is_some());
    }

    #[test]
    fn test_spherecast_3d_and_layer_mask() {
        let mut world = World::new();
        let phys = PhysicsWorld::new(PhysicsConfig::default());

        let wall_layer2 = world.spawn();
        world.set_transform_immediate(wall_layer2, Vec3::new(0.0, 1.0, -5.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(wall_layer2)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(wall_layer2)] = Some(RigidBody {
            dynamic: false,
            layer: 0b10,
            ..Default::default()
        });

        // Thin ray offset slightly at x=0.8 misses box halfExtent 0.5
        assert!(phys.raycast_3d(&world, Vec3::new(0.8, 1.0, 0.0), Vec3::new(0.0, 0.0, -1.0), 20.0).is_none());
        // SphereCast with radius 0.45 hits offset box on layer 2, unless filtered out by mask 0b01!
        let hit_mask2 = phys.raycast_3d_ex(&world, Vec3::new(0.8, 1.0, 0.0), Vec3::new(0.0, 0.0, -1.0), 20.0, 0b10, 0.45);
        assert_eq!(hit_mask2.map(|h| h.entity), Some(wall_layer2));
        let miss_mask1 = phys.raycast_3d_ex(&world, Vec3::new(0.8, 1.0, 0.0), Vec3::new(0.0, 0.0, -1.0), 20.0, 0b01, 0.45);
        assert!(miss_mask1.is_none());
    }
}
