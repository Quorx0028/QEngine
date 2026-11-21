use crate::ecs::{Collider2D, Collider3D, EntityHandle, World, INVALID_ENTITY};
use glam::{Vec2, Vec3};

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
            solver_iterations: 4,
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
struct Contact3D {
    other_idx: Option<usize>,
    tri_idx: Option<(usize, usize)>,
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
            // Drop excess leftover accumulator after clamping spiral-of-death.
            self.accumulator = self.accumulator % fixed_dt;
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
                    world.curr_pos[i] += world.velocities[i] * dt;
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

        // Remove static meshes whose owner entity despawned.
        self.static_meshes
            .retain(|m| m.entity == INVALID_ENTITY || world.is_alive(m.entity));

        for _ in 0..self.config.solver_iterations {
            for idx_pos in 0..self.dynamic_indices.len() {
                let dyn_idx = self.dynamic_indices[idx_pos];
                if world.colliders_3d[dyn_idx].is_some() {
                    self.resolve_3d_entity(world, dyn_idx);
                }
                if world.colliders_2d[dyn_idx].is_some() {
                    self.resolve_2d_entity(world, dyn_idx);
                }
            }
        }
    }

    fn resolve_3d_entity(&self, world: &mut World, dyn_idx: usize) {
        let Some(col) = world.colliders_3d[dyn_idx] else {
            return;
        };

        // Pass 1: resolve static obstacles & floors (floor-facing normals prioritized to avoid seam snags).
        let mut contacts = [Contact3D {
            other_idx: None,
            tri_idx: None,
            normal: Vec3::ZERO,
            depth: 0.0,
        }; 16];
        let mut contact_count = 0usize;

        let dyn_pos = world.curr_pos[dyn_idx];

        for &stat_idx in &self.static_indices_3d {
            let Some(stat_col) = world.colliders_3d[stat_idx] else {
                continue;
            };
            if let Some((normal, depth)) =
                intersect_3d(col, dyn_pos, stat_col, world.curr_pos[stat_idx])
            {
                if contact_count < contacts.len() {
                    contacts[contact_count] = Contact3D {
                        other_idx: Some(stat_idx),
                        tri_idx: None,
                        normal,
                        depth,
                    };
                    contact_count += 1;
                }
            }
        }

        // Static triangle meshes
        for (m_idx, mesh) in self.static_meshes.iter().enumerate() {
            let r = collider3d_bounding_radius(col) + 0.05;
            if dyn_pos.x + r < mesh.bounds_min.x
                || dyn_pos.x - r > mesh.bounds_max.x
                || dyn_pos.y + r < mesh.bounds_min.y
                || dyn_pos.y - r > mesh.bounds_max.y
                || dyn_pos.z + r < mesh.bounds_min.z
                || dyn_pos.z - r > mesh.bounds_max.z
            {
                continue;
            }
            for (t_idx, tri) in mesh.triangles.iter().enumerate() {
                if let Some((normal, depth)) = intersect_collider_triangle(col, dyn_pos, *tri) {
                    if contact_count < contacts.len() {
                        contacts[contact_count] = Contact3D {
                            other_idx: None,
                            tri_idx: Some((m_idx, t_idx)),
                            normal,
                            depth,
                        };
                        contact_count += 1;
                    }
                }
            }
        }

        // Dynamic vs dynamic
        for &other_idx in &self.dynamic_indices {
            if other_idx <= dyn_idx {
                continue;
            }
            let Some(other_col) = world.colliders_3d[other_idx] else {
                continue;
            };
            if let Some((normal, depth)) =
                intersect_3d(col, dyn_pos, other_col, world.curr_pos[other_idx])
            {
                if contact_count < contacts.len() {
                    contacts[contact_count] = Contact3D {
                        other_idx: Some(other_idx),
                        tri_idx: None,
                        normal,
                        depth,
                    };
                    contact_count += 1;
                }
            }
        }

        if contact_count == 0 {
            return;
        }

        // Sort floor contacts (higher normal.y) first, then deeper penetrations.
        contacts[..contact_count].sort_by(|a, b| {
            let a_floor = a.normal.y > 0.5;
            let b_floor = b.normal.y > 0.5;
            b_floor
                .cmp(&a_floor)
                .then_with(|| b.depth.total_cmp(&a.depth))
        });

        let restitution = world.rigid_bodies[dyn_idx].map(|r| r.restitution).unwrap_or(0.0);

        for c in &contacts[..contact_count] {
            let cur_pos = world.curr_pos[dyn_idx];
            if let Some(other_idx) = c.other_idx {
                let is_other_dynamic = world.rigid_bodies[other_idx].map_or(false, |r| r.dynamic);
                let Some(other_col) = world.colliders_3d[other_idx] else {
                    continue;
                };
                let Some((normal, depth)) =
                    intersect_3d(col, cur_pos, other_col, world.curr_pos[other_idx])
                else {
                    continue;
                };
                if is_other_dynamic {
                    let half = normal * (depth * 0.5);
                    world.curr_pos[dyn_idx] += half;
                    world.curr_pos[other_idx] -= half;
                    let rel_v = world.velocities[dyn_idx] - world.velocities[other_idx];
                    let vn = rel_v.dot(normal);
                    if vn < 0.0 {
                        let j = -(1.0 + restitution) * vn * 0.5;
                        world.velocities[dyn_idx] += normal * j;
                        world.velocities[other_idx] -= normal * j;
                    }
                    continue;
                }
                world.curr_pos[dyn_idx] += normal * depth;
                if normal.y > 0.5 {
                    if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                        rb.grounded = true;
                    }
                }
                let vn = world.velocities[dyn_idx].dot(normal);
                if vn < 0.0 {
                    let bounce = if vn.abs() < 0.5 { 0.0 } else { restitution };
                    world.velocities[dyn_idx] -= normal * ((1.0 + bounce) * vn);
                }
                continue;
            }

            if let Some((m_idx, t_idx)) = c.tri_idx {
                let tri = self.static_meshes[m_idx].triangles[t_idx];
                let Some((normal, depth)) = intersect_collider_triangle(col, cur_pos, tri) else {
                    continue;
                };
                world.curr_pos[dyn_idx] += normal * depth;
                if normal.y > 0.5 {
                    if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                        rb.grounded = true;
                    }
                }
                let vn = world.velocities[dyn_idx].dot(normal);
                if vn < 0.0 {
                    let bounce = if vn.abs() < 0.5 { 0.0 } else { restitution };
                    world.velocities[dyn_idx] -= normal * ((1.0 + bounce) * vn);
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

        // TileGrid2D solid cells
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
                        + Vec2::new((tx as f32 + 0.5) * grid.tile_size, (ty as f32 + 0.5) * grid.tile_size);
                    if let Some((normal, depth)) = intersect_2d(
                        col,
                        p2,
                        Collider2D::Aabb2D {
                            half_extents: half_tile,
                        },
                        tile_center,
                    ) {
                        // Skip internal seam faces when neighbor tile in normal direction is also solid.
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
            let hit = match col {
                Collider3D::Aabb { half_extents } => {
                    ray_aabb(origin, d, pos - half_extents, pos + half_extents)
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
                    let handle =
                        ((world.generations[i] as u32) << 20) | ((i as u32) & 0xFFFFF);
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

fn intersect_3d(
    a: Collider3D,
    pa: Vec3,
    b: Collider3D,
    pb: Vec3,
) -> Option<(Vec3, f32)> {
    match (a, b) {
        (Collider3D::Sphere { radius: r }, Collider3D::Aabb { half_extents }) => {
            sphere_vs_aabb(pa, r, pb, half_extents)
        }
        (Collider3D::Aabb { half_extents }, Collider3D::Sphere { radius: r }) => {
            sphere_vs_aabb(pb, r, pa, half_extents).map(|(n, d)| (-n, d))
        }
        (
            Collider3D::Capsule {
                radius,
                half_height,
            },
            Collider3D::Aabb { half_extents },
        ) => capsule_vs_aabb(pa, radius, half_height, pb, half_extents),
        (
            Collider3D::Aabb { half_extents },
            Collider3D::Capsule {
                radius,
                half_height,
            },
        ) => capsule_vs_aabb(pb, radius, half_height, pa, half_extents).map(|(n, d)| (-n, d)),
        (Collider3D::Sphere { radius: r1 }, Collider3D::Sphere { radius: r2 }) => {
            sphere_vs_sphere(pa, r1, pb, r2)
        }
        (
            Collider3D::Capsule {
                radius: r1,
                half_height: h1,
            },
            Collider3D::Sphere { radius: r2 },
        ) => {
            let cy = pa.y.clamp(pa.y - h1, pa.y + h1);
            let clamped_y = pb.y.clamp(pa.y - h1, pa.y + h1);
            let _ = cy;
            sphere_vs_sphere(Vec3::new(pa.x, clamped_y, pa.z), r1, pb, r2)
        }
        (
            Collider3D::Sphere { radius: r1 },
            Collider3D::Capsule {
                radius: r2,
                half_height: h2,
            },
        ) => {
            let clamped_y = pa.y.clamp(pb.y - h2, pb.y + h2);
            sphere_vs_sphere(pa, r1, Vec3::new(pb.x, clamped_y, pb.z), r2)
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
            sphere_vs_sphere(Vec3::new(pa.x, y1, pa.z), r1, Vec3::new(pb.x, y2, pb.z), r2)
        }
        (
            Collider3D::Aabb { half_extents: ha },
            Collider3D::Aabb { half_extents: hb },
        ) => aabb_vs_aabb(pa, ha, pb, hb),
    }
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
    let min = box_pos - half;
    let max = box_pos + half;
    let closest = center.clamp(min, max);
    let diff = center - closest;
    let dist_sq = diff.length_squared();
    if dist_sq >= radius * radius {
        return None;
    }
    if dist_sq > 1e-8 {
        let dist = dist_sq.sqrt();
        return Some((diff / dist, radius - dist));
    }
    // Sphere center is inside the AABB: pick axis with minimum penetration out.
    let dx_min = (center.x - min.x).abs();
    let dx_max = (max.x - center.x).abs();
    let dy_min = (center.y - min.y).abs();
    let dy_max = (max.y - center.y).abs();
    let dz_min = (center.z - min.z).abs();
    let dz_max = (max.z - center.z).abs();
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
    Some((best_normal, radius + best_dist))
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

    // Sample the closest point along the vertical capsule segment to the box's Y interval,
    // plus bottom/top caps to catch slope/ledge contacts cleanly.
    let sample_y = if seg_max_y < box_min_y {
        seg_max_y
    } else if seg_min_y > box_max_y {
        seg_min_y
    } else {
        box_pos.y.clamp(seg_min_y, seg_max_y)
    };

    let mut best: Option<(Vec3, f32)> = None;
    for &y in &[seg_min_y, sample_y, seg_max_y] {
        if let Some((n, d)) = sphere_vs_aabb(Vec3::new(cap_pos.x, y, cap_pos.z), radius, box_pos, half)
        {
            let replace = match best {
                None => true,
                Some((bn, bd)) => {
                    // Prefer floor normals slightly over edge-side normals to prevent seam snagging.
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

fn aabb_vs_aabb(pa: Vec3, ha: Vec3, pb: Vec3, hb: Vec3) -> Option<(Vec3, f32)> {
    let diff = pa - pb;
    let overlap = (ha + hb) - diff.abs();
    if overlap.x <= 0.0 || overlap.y <= 0.0 || overlap.z <= 0.0 {
        return None;
    }
    if overlap.y <= overlap.x && overlap.y <= overlap.z {
        let sign = if diff.y >= 0.0 { 1.0 } else { -1.0 };
        Some((Vec3::new(0.0, sign, 0.0), overlap.y))
    } else if overlap.x <= overlap.z {
        let sign = if diff.x >= 0.0 { 1.0 } else { -1.0 };
        Some((Vec3::new(sign, 0.0, 0.0), overlap.x))
    } else {
        let sign = if diff.z >= 0.0 { 1.0 } else { -1.0 };
        Some((Vec3::new(0.0, 0.0, sign), overlap.z))
    }
}

fn intersect_collider_triangle(
    col: Collider3D,
    pos: Vec3,
    tri: [Vec3; 3],
) -> Option<(Vec3, f32)> {
    match col {
        Collider3D::Sphere { radius } => sphere_vs_triangle(pos, radius, tri),
        Collider3D::Capsule {
            radius,
            half_height,
        } => {
            let mut best: Option<(Vec3, f32)> = None;
            let samples = [pos.y - half_height, pos.y, pos.y + half_height];
            for y in samples {
                if let Some((n, d)) = sphere_vs_triangle(Vec3::new(pos.x, y, pos.z), radius, tri) {
                    if best.map_or(true, |(_, bd)| d > bd) {
                        best = Some((n, d));
                    }
                }
            }
            best
        }
        Collider3D::Aabb { half_extents } => {
            sphere_vs_triangle(pos, half_extents.min_element(), tri)
        }
    }
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
        return Some((if tri_n.length_squared() > 0.0 { tri_n } else { Vec3::Y }, radius));
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
        (Collider2D::Aabb2D { half_extents }, Collider2D::Circle2D { radius }) => {
            intersect_2d(
                Collider2D::Circle2D { radius },
                pb,
                Collider2D::Aabb2D { half_extents },
                pa,
            )
            .map(|(n, d)| (-n, d))
        }
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
                Some((Vec2::new(0.0, if diff.y >= 0.0 { 1.0 } else { -1.0 }), overlap.y))
            } else {
                Some((Vec2::new(if diff.x >= 0.0 { 1.0 } else { -1.0 }, 0.0), overlap.x))
            }
        }
    }
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
            ..Default::default()
        });

        for _ in 0..90 {
            world.velocities[entity_index(player)] = Vec3::new(3.0, -1.0, 0.0);
            phys.step(&mut world, 1.0 / 60.0);
        }

        let pos = world.curr_pos[entity_index(player)];
        assert!(pos.x > 3.2, "snagged on floor seam at x=2.0! pos.x={}", pos.x);
        assert!((pos.y - 0.9).abs() < 0.01, "unexpected y shift: {}", pos.y);

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
}
