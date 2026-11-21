use crate::ecs::{Collider2D, Collider3D, EntityHandle, World, INVALID_ENTITY};
use glam::{Quat, Vec2, Vec3};

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

#[derive(Clone, Debug)]
pub struct StaticTriMesh {
    pub entity: EntityHandle,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
    pub triangles: Vec<[Vec3; 3]>,
}

#[derive(Clone, Copy, Debug)]
struct ContactPoint {
    other_idx: Option<usize>,
    other_is_dynamic: bool,
    point: Vec3,
    normal: Vec3,
    depth: f32,
}

#[derive(Clone, Copy, Debug)]
struct Contact2D {
    normal: Vec2,
    depth: f32,
}

pub struct PhysicsWorld {
    pub config: PhysicsConfig,
    accumulator: f32,
    pub tile_grids_2d: Vec<TileGrid2D>,
    pub static_meshes: Vec<StaticTriMesh>,
    dynamic_indices: Vec<usize>,
    static_indices_3d: Vec<usize>,
    static_indices_2d: Vec<usize>,
}

impl PhysicsWorld {
    pub fn new(config: PhysicsConfig) -> Self {
        Self {
            config,
            accumulator: 0.0,
            tile_grids_2d: Vec::new(),
            static_meshes: Vec::new(),
            dynamic_indices: Vec::new(),
            static_indices_3d: Vec::new(),
            static_indices_2d: Vec::new(),
        }
    }

    pub fn clear_static_geometry(&mut self) {
        self.tile_grids_2d.clear();
        self.static_meshes.clear();
        self.accumulator = 0.0;
    }

    pub fn add_static_mesh(&mut self, entity: EntityHandle, triangles: Vec<[Vec3; 3]>) {
        if triangles.is_empty() {
            return;
        }
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for tri in &triangles {
            for &v in tri {
                min = min.min(v);
                max = max.max(v);
            }
        }
        self.static_meshes.push(StaticTriMesh {
            entity,
            bounds_min: min,
            bounds_max: max,
            triangles,
        });
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
        let idx = crate::ecs::entity_index(entity);
        let Some(rb) = world.rigid_bodies[idx] else {
            return false;
        };
        if !rb.dynamic {
            return false;
        }
        let inv_m = 1.0 / rb.mass.max(0.01);
        world.velocities[idx] += impulse * inv_m;
        if !rb.lock_rotation {
            if let Some(pt) = world_point {
                let r = pt - world.curr_pos[idx];
                let inv_i = collider_inv_inertia(world.colliders_3d[idx], rb.mass);
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
        self.static_indices_3d.clear();
        self.static_indices_2d.clear();

        let count = world.alive.len();
        for i in 0..count {
            if !world.alive[i] {
                continue;
            }
            if let Some(rb) = &mut world.rigid_bodies[i] {
                rb.grounded = false;
                if rb.dynamic {
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
                    self.dynamic_indices.push(i);
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

        self.static_meshes
            .retain(|m| m.entity == INVALID_ENTITY || world.is_alive(m.entity));

        for iter in 0..self.config.solver_iterations {
            for idx_pos in 0..self.dynamic_indices.len() {
                let dyn_idx = self.dynamic_indices[idx_pos];
                if world.colliders_3d[dyn_idx].is_some() {
                    self.resolve_3d_entity(world, dyn_idx, iter == 0);
                }
                if world.colliders_2d[dyn_idx].is_some() {
                    self.resolve_2d_entity(world, dyn_idx);
                }
            }
        }
    }

    fn resolve_3d_entity(&self, world: &mut World, dyn_idx: usize, apply_positional_bias: bool) {
        let Some(col) = world.colliders_3d[dyn_idx] else {
            return;
        };
        let Some(rb_a) = world.rigid_bodies[dyn_idx] else {
            return;
        };

        let mut contacts = [ContactPoint {
            other_idx: None,
            other_is_dynamic: false,
            point: Vec3::ZERO,
            normal: Vec3::ZERO,
            depth: 0.0,
        }; 32];
        let mut contact_count = 0usize;

        let pos_a = world.curr_pos[dyn_idx];
        let rot_a = world.curr_rot[dyn_idx];

        // 1. Static AABB / Sphere / Capsule entities
        for &stat_idx in &self.static_indices_3d {
            let Some(stat_col) = world.colliders_3d[stat_idx] else {
                continue;
            };
            collect_3d_contacts(
                col,
                pos_a,
                rot_a,
                stat_col,
                world.curr_pos[stat_idx],
                world.curr_rot[stat_idx],
                Some(stat_idx),
                false,
                &mut contacts,
                &mut contact_count,
            );
        }

        // 2. Static triangle meshes (ramps, Blender level colliders)
        let r_bound = collider3d_bounding_radius(col) + 0.1;
        for mesh in &self.static_meshes {
            if pos_a.x + r_bound < mesh.bounds_min.x
                || pos_a.x - r_bound > mesh.bounds_max.x
                || pos_a.y + r_bound < mesh.bounds_min.y
                || pos_a.y - r_bound > mesh.bounds_max.y
                || pos_a.z + r_bound < mesh.bounds_min.z
                || pos_a.z - r_bound > mesh.bounds_max.z
            {
                continue;
            }
            for tri in &mesh.triangles {
                collect_triangle_contacts(
                    col,
                    pos_a,
                    rot_a,
                    *tri,
                    &mut contacts,
                    &mut contact_count,
                );
            }
        }

        // 3. Dynamic vs dynamic
        for &other_idx in &self.dynamic_indices {
            if other_idx <= dyn_idx {
                continue;
            }
            let Some(other_col) = world.colliders_3d[other_idx] else {
                continue;
            };
            let pos_b = world.curr_pos[other_idx];
            let r_sum = r_bound + collider3d_bounding_radius(other_col);
            if pos_a.distance_squared(pos_b) > r_sum * r_sum {
                continue;
            }
            collect_3d_contacts(
                col,
                pos_a,
                rot_a,
                other_col,
                pos_b,
                world.curr_rot[other_idx],
                Some(other_idx),
                true,
                &mut contacts,
                &mut contact_count,
            );
        }

        if contact_count == 0 {
            return;
        }

        // Floor contacts first so capsules/boxes clear floor planes before horizontal faces.
        contacts[..contact_count].sort_by(|a, b| {
            let a_floor = a.normal.y > 0.5;
            let b_floor = b.normal.y > 0.5;
            b_floor
                .cmp(&a_floor)
                .then_with(|| b.depth.total_cmp(&a.depth))
        });

        let inv_m_a = 1.0 / rb_a.mass.max(0.01);
        let inv_i_a = if rb_a.lock_rotation {
            0.0
        } else {
            collider_inv_inertia(Some(col), rb_a.mass)
        };

        // Positional depenetration: apply the deepest push per static/dynamic cluster so flat faces don't over-push.
        let mut max_static_push = Vec3::ZERO;
        let mut static_contacts = 0usize;
        for c in &contacts[..contact_count] {
            if c.normal.y > 0.45 {
                if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                    rb.grounded = true;
                }
            }
            if !c.other_is_dynamic {
                static_contacts += 1;
                if apply_positional_bias || c.depth > 0.002 {
                    let slop = 0.0005;
                    let push_mag = (c.depth - slop).max(0.0);
                    let candidate = c.normal * push_mag;
                    if candidate.length_squared() > max_static_push.length_squared() {
                        max_static_push = candidate;
                    }
                }
            } else if let Some(other_idx) = c.other_idx {
                let half = c.normal * ((c.depth - 0.0005).max(0.0) * 0.5);
                world.curr_pos[dyn_idx] += half;
                world.curr_pos[other_idx] -= half;
            }
        }
        if static_contacts > 0 {
            world.curr_pos[dyn_idx] += max_static_push;
        }

        // Sequential impulse + Coulomb friction + angular torque at each contact point.
        let contact_scale = 1.0 / (contact_count.min(4) as f32);
        for c in &contacts[..contact_count] {
            let n = c.normal;
            let ra = c.point - world.curr_pos[dyn_idx];

            if c.other_is_dynamic {
                let Some(other_idx) = c.other_idx else {
                    continue;
                };
                let Some(rb_b) = world.rigid_bodies[other_idx] else {
                    continue;
                };
                let inv_m_b = 1.0 / rb_b.mass.max(0.01);
                let inv_i_b = if rb_b.lock_rotation {
                    0.0
                } else {
                    collider_inv_inertia(world.colliders_3d[other_idx], rb_b.mass)
                };
                let rb = c.point - world.curr_pos[other_idx];

                let va = world.velocities[dyn_idx] + world.angular_velocities[dyn_idx].cross(ra);
                let vb = world.velocities[other_idx] + world.angular_velocities[other_idx].cross(rb);
                let v_rel = va - vb;
                let vn = v_rel.dot(n);
                if vn >= 0.0 {
                    continue;
                }

                let rn_a = ra.cross(n);
                let rn_b = rb.cross(n);
                let denom = inv_m_a
                    + inv_m_b
                    + (rn_a.length_squared() * inv_i_a)
                    + (rn_b.length_squared() * inv_i_b);
                if denom < 1e-8 {
                    continue;
                }
                let e = if vn.abs() < 1.2 {
                    0.0
                } else {
                    rb_a.restitution.max(rb_b.restitution)
                };
                let jn = (-(1.0 + e) * vn / denom) * contact_scale;
                let mut impulse = n * jn;

                // Tangential friction
                let mu = (rb_a.friction + rb_b.friction) * 0.5;
                if mu > 0.0 {
                    let va2 = world.velocities[dyn_idx] + world.angular_velocities[dyn_idx].cross(ra);
                    let vb2 = world.velocities[other_idx] + world.angular_velocities[other_idx].cross(rb);
                    let v_rel2 = va2 - vb2;
                    let tang = v_rel2 - n * v_rel2.dot(n);
                    let t_len = tang.length();
                    if t_len > 1e-5 {
                        let t = tang / t_len;
                        let rt_a = ra.cross(t);
                        let rt_b = rb.cross(t);
                        let denom_t = inv_m_a
                            + inv_m_b
                            + (rt_a.length_squared() * inv_i_a)
                            + (rt_b.length_squared() * inv_i_b);
                        let jt = (-v_rel2.dot(t) / denom_t.max(1e-6)).clamp(-mu * jn, mu * jn);
                        impulse += t * jt;
                    }
                }

                world.velocities[dyn_idx] += impulse * inv_m_a;
                world.velocities[other_idx] -= impulse * inv_m_b;
                if !rb_a.lock_rotation {
                    world.angular_velocities[dyn_idx] += ra.cross(impulse) * inv_i_a;
                }
                if !rb_b.lock_rotation {
                    world.angular_velocities[other_idx] -= rb.cross(impulse) * inv_i_b;
                }
                continue;
            }

            // Static contact
            let va = world.velocities[dyn_idx] + world.angular_velocities[dyn_idx].cross(ra);
            let vn = va.dot(n);
            if vn < 0.0 {
                let rn = ra.cross(n);
                let denom = inv_m_a + rn.length_squared() * inv_i_a;
                let e = if vn.abs() < 1.2 { 0.0 } else { rb_a.restitution };
                let jn = -(1.0 + e) * vn / denom.max(1e-6);
                let mut impulse = n * jn;

                if rb_a.friction > 0.0 {
                    let tang = va - n * vn;
                    let t_len = tang.length();
                    if t_len > 1e-5 {
                        let t = tang / t_len;
                        let rt = ra.cross(t);
                        let denom_t = inv_m_a + rt.length_squared() * inv_i_a;
                        let jt = (-va.dot(t) / denom_t.max(1e-6))
                            .clamp(-rb_a.friction * jn, rb_a.friction * jn);
                        impulse += t * jt;
                    }
                }

                world.velocities[dyn_idx] += impulse * inv_m_a;
                if !rb_a.lock_rotation {
                    world.angular_velocities[dyn_idx] += ra.cross(impulse) * inv_i_a;
                }
            } else if rb_a.friction > 0.0 && c.depth > 0.0 {
                // Resting static friction: gently kill tiny residual tangential drift on floors.
                let tang = va - n * vn;
                let t_len = tang.length();
                if t_len > 1e-5 {
                    let t = tang / t_len;
                    let rt = ra.cross(t);
                    let denom_t = inv_m_a + rt.length_squared() * inv_i_a;
                    let max_rest_jt = rb_a.friction * rb_a.mass * 0.25;
                    let jt = (-va.dot(t) / denom_t.max(1e-6)).clamp(-max_rest_jt, max_rest_jt);
                    let imp = t * jt;
                    world.velocities[dyn_idx] += imp * inv_m_a;
                    if !rb_a.lock_rotation {
                        world.angular_velocities[dyn_idx] += ra.cross(imp) * inv_i_a;
                    }
                }
            }
        }
    }

    fn resolve_2d_entity(&self, world: &mut World, dyn_idx: usize) {
        let Some(col) = world.colliders_2d[dyn_idx] else {
            return;
        };

        let mut contacts = [Contact2D {
            normal: Vec2::ZERO,
            depth: 0.0,
        }; 16];
        let mut count = 0usize;

        let p2 = Vec2::new(world.curr_pos[dyn_idx].x, world.curr_pos[dyn_idx].y);

        for &stat_idx in &self.static_indices_2d {
            let Some(stat_col) = world.colliders_2d[stat_idx] else {
                continue;
            };
            let sp = Vec2::new(world.curr_pos[stat_idx].x, world.curr_pos[stat_idx].y);
            if let Some((normal, depth)) = intersect_2d(col, p2, stat_col, sp) {
                if count < contacts.len() {
                    contacts[count] = Contact2D { normal, depth };
                    count += 1;
                }
            }
        }

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
        let dir_len = dir.length();
        if dir_len < 1e-6 {
            return None;
        }
        let d = dir / dir_len;
        let mut best: Option<RayHit> = None;
        let mut best_t = max_dist;

        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let pos = world.curr_pos[i];
            let rot = world.curr_rot[i];
            let hit = match col {
                Collider3D::Aabb { half_extents } => {
                    ray_obb(origin, d, pos, rot, half_extents)
                }
                Collider3D::Sphere { radius } => ray_sphere(origin, d, pos, radius),
                Collider3D::Capsule {
                    radius,
                    half_height,
                } => {
                    let ext = Vec3::new(radius, half_height + radius, radius);
                    ray_aabb(origin, d, pos - ext, pos + ext)
                }
            };
            if let Some((t, normal)) = hit {
                if t >= 0.0 && t < best_t {
                    best_t = t;
                    let handle = ((world.generations[i] as u32) << 20) | ((i as u32) & 0xFFFFF);
                    best = Some(RayHit {
                        entity: handle,
                        distance: t,
                        point: origin + d * t,
                        normal,
                    });
                }
            }
        }
        best
    }
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
    other_idx: Option<usize>,
    other_is_dynamic: bool,
    point: Vec3,
    normal: Vec3,
    depth: f32,
) {
    if depth > 0.0 && *count < contacts.len() {
        contacts[*count] = ContactPoint {
            other_idx,
            other_is_dynamic,
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
            // Corners of OBB A against OBB B (works for rotated B too, including axis-aligned static floors/walls)
            let inv_rb = rb.conjugate();
            let corners_a = obb_corners(pa, ra, ha);
            for corner in corners_a {
                let local = inv_rb * (corner - pb);
                if local.x.abs() < hb.x && local.y.abs() < hb.y && local.z.abs() < hb.z {
                    let dx_min = local.x + hb.x;
                    let dx_max = hb.x - local.x;
                    let dy_min = local.y + hb.y;
                    let dy_max = hb.y - local.y;
                    let dz_min = local.z + hb.z;
                    let dz_max = hb.z - local.z;
                    let mut best_d = dy_max;
                    let mut best_ln = Vec3::Y;
                    for &(d, ln) in &[
                        (dy_min, Vec3::NEG_Y),
                        (dx_min, Vec3::NEG_X),
                        (dx_max, Vec3::X),
                        (dz_min, Vec3::NEG_Z),
                        (dz_max, Vec3::Z),
                    ] {
                        if d < best_d {
                            best_d = d;
                            best_ln = ln;
                        }
                    }
                    push_contact(
                        contacts,
                        count,
                        other_idx,
                        other_is_dynamic,
                        corner,
                        rb * best_ln,
                        best_d,
                    );
                }
            }

            // Corners of OBB B against OBB A (catches small static pillars / edges poking into a box)
            let inv_ra = ra.conjugate();
            let corners_b = obb_corners(pb, rb, hb);
            for corner in corners_b {
                let local = inv_ra * (corner - pa);
                if local.x.abs() < ha.x && local.y.abs() < ha.y && local.z.abs() < ha.z {
                    let dx_min = local.x + ha.x;
                    let dx_max = ha.x - local.x;
                    let dy_min = local.y + ha.y;
                    let dy_max = ha.y - local.y;
                    let dz_min = local.z + ha.z;
                    let dz_max = ha.z - local.z;
                    let mut best_d = dy_max;
                    let mut best_ln = Vec3::NEG_Y; // push A up if B corner hits bottom of A
                    for &(d, ln) in &[
                        (dy_min, Vec3::Y),
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
                    push_contact(
                        contacts,
                        count,
                        other_idx,
                        other_is_dynamic,
                        corner,
                        ra * best_ln,
                        best_d,
                    );
                }
            }
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
        _ => {}
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

            // Also test triangle vertices inside OBB local box (catches sharp ramp ridges/edges)
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
}
