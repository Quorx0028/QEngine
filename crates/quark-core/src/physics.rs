use crate::collision_math::{
    capsule_vs_obb, closest_point_on_triangle, closest_segment_segment, closest_segment_triangle,
    gjk_epa, intersect_2d_rotated, ray_capsule, ray_cylinder, smooth_internal_triangle_normal,
    CompoundChild, CompoundShape, ConvexHullShape, SupportShape, WaterZone,
};
use crate::ecs::{
    entity_index, Collider2D, Collider3D, EntityHandle, RigidBody, World, INVALID_ENTITY,
};
use crate::joints::JointSolver;
use crate::terrain::TerrainHeightmap;
use glam::{Mat3, Quat, Vec2, Vec3};

pub const EVENT_COLLISION_ENTER: u32 = 1;
pub const EVENT_TRIGGER_ENTER: u32 = 2;
pub const EVENT_TRIGGER_EXIT: u32 = 3;
pub const EVENT_COLLISION_STAY: u32 = 4;
pub const EVENT_COLLISION_EXIT: u32 = 5;
pub const EVENT_TRIGGER_STAY: u32 = 6;
pub const EVENT_STRIDE_U32: usize = 6;
pub const RICH_EVENT_STRIDE_U32: usize = 10;

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
            solver_iterations: 16,
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
    pub contact_point: Vec3,
    pub impulse: f32,
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
    pub internal_edges: Vec<u8>,
    tri_indices: Vec<usize>,
    tri_centroids: Vec<Vec3>,
    tri_bounds: Vec<(Vec3, Vec3)>,
    nodes: Vec<BvhNode>,
}

#[inline]
fn quantize_vert(v: Vec3) -> [i32; 3] {
    [
        (v.x * 1000.0).round() as i32,
        (v.y * 1000.0).round() as i32,
        (v.z * 1000.0).round() as i32,
    ]
}

fn compute_internal_edge_masks(triangles: &[[Vec3; 3]]) -> Vec<u8> {
    use std::collections::HashMap;
    let mut edge_map: HashMap<([i32; 3], [i32; 3]), Vec<(usize, Vec3)>> =
        HashMap::with_capacity(triangles.len() * 2);
    let mut normals = Vec::with_capacity(triangles.len());
    for (ti, tri) in triangles.iter().enumerate() {
        let n = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
        normals.push(n);
        let q = [
            quantize_vert(tri[0]),
            quantize_vert(tri[1]),
            quantize_vert(tri[2]),
        ];
        for e in 0..3 {
            let a = q[e];
            let b = q[(e + 1) % 3];
            let key = if a <= b { (a, b) } else { (b, a) };
            edge_map.entry(key).or_default().push((ti, n));
        }
    }
    let mut masks = vec![0u8; triangles.len()];
    for (ti, tri) in triangles.iter().enumerate() {
        let n = normals[ti];
        if n.length_squared() < 0.5 {
            continue;
        }
        let q = [
            quantize_vert(tri[0]),
            quantize_vert(tri[1]),
            quantize_vert(tri[2]),
        ];
        for e in 0..3 {
            let a = q[e];
            let b = q[(e + 1) % 3];
            let key = if a <= b { (a, b) } else { (b, a) };
            if let Some(shared) = edge_map.get(&key) {
                for &(oti, onrm) in shared {
                    if oti == ti || onrm.length_squared() < 0.5 {
                        continue;
                    }
                    // Coplanar or gently angled/concave internal seam
                    if n.dot(onrm) > 0.72 {
                        masks[ti] |= 1 << e;
                        break;
                    }
                }
            }
        }
    }
    masks
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
        let internal_edges = compute_internal_edge_masks(&triangles);

        let mut mesh = Self {
            entity,
            bounds_min,
            bounds_max,
            triangles,
            internal_edges,
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

#[derive(Clone, Copy, Debug, Default)]
struct ContactPoint {
    point: Vec3,
    normal: Vec3,
    depth: f32,
    other_idx: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
struct ManifoldContact {
    a: usize,
    b: usize,
    is_dynamic_b: bool,
    normal: Vec3,
    t1: Vec3,
    t2: Vec3,
    point: Vec3,
    depth: f32,
    init_pos_a: Vec3,
    init_pos_b: Vec3,
    ra: Vec3,
    rb: Vec3,
    inv_m_a: f32,
    inv_m_b: f32,
    inv_i_a: Mat3,
    inv_i_b: Mat3,
    eff_mass_n: f32,
    eff_mass_t1: f32,
    eff_mass_t2: f32,
    vel_bias: f32,
    friction: f32,
    static_friction: f32,
    allow_friction: bool,
    lock_rot_a: bool,
    lock_rot_b: bool,
    steep_for_a: bool,
    acc_n: f32,
    acc_t1: f32,
    acc_t2: f32,
    local_a: Vec3,
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
struct CachedImpulse {
    a: usize,
    b: usize,
    gen_a: u16,
    local_a: Vec3,
    normal: Vec3,
    acc_n: f32,
    tang_imp: Vec3,
}

#[derive(Clone, Copy, Debug)]
pub struct CharacterController {
    pub step_height: f32,
    pub max_slope_cos: f32,
    pub push_strength: f32,
    pub max_push_mass: f32,
    pub ground_snap: f32,
    pub anti_tip_push: bool,
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
    pub convex_hulls: Vec<ConvexHullShape>,
    pub compound_shapes: Vec<CompoundShape>,
    pub water_zones: Vec<WaterZone>,
    next_water_id: u32,

    was_grounded: Vec<bool>,
    ground_support: Vec<Option<(usize, Vec3, Quat)>>,
    pre_step_pos: Vec<Vec3>,
    dynamic_indices: Vec<usize>,
    awake_indices: Vec<usize>,
    static_indices_3d: Vec<usize>,
    static_indices_2d: Vec<usize>,

    sweep_boxes: Vec<(f32, f32, f32, f32, f32, f32, usize)>,
    pair_scratch: Vec<(usize, usize)>,
    bvh_scratch: Vec<usize>,
    manifolds: Vec<ManifoldContact>,
    prev_impulses: Vec<CachedImpulse>,

    island_parent: Vec<usize>,
    island_all_calm: Vec<bool>,
    island_has_contact: Vec<bool>,

    prev_overlaps: Vec<OverlapPair>,
    curr_overlaps: Vec<OverlapPair>,
    pair_impulses: Vec<(EntityHandle, EntityHandle, Vec3, Vec3, f32)>,
    events: Vec<PhysicsEvent>,
    pub event_words: Vec<u32>,
    pub rich_event_words: Vec<u32>,
    pub overlap_results: Vec<EntityHandle>,
    pub debug_lines: Vec<f32>,
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
            convex_hulls: Vec::new(),
            compound_shapes: Vec::new(),
            water_zones: Vec::new(),
            next_water_id: 1,
            was_grounded: Vec::new(),
            ground_support: Vec::new(),
            pre_step_pos: Vec::new(),
            dynamic_indices: Vec::new(),
            awake_indices: Vec::new(),
            static_indices_3d: Vec::new(),
            static_indices_2d: Vec::new(),
            sweep_boxes: Vec::new(),
            pair_scratch: Vec::new(),
            bvh_scratch: Vec::new(),
            manifolds: Vec::new(),
            prev_impulses: Vec::new(),
            island_parent: Vec::new(),
            island_all_calm: Vec::new(),
            island_has_contact: Vec::new(),
            prev_overlaps: Vec::new(),
            curr_overlaps: Vec::new(),
            pair_impulses: Vec::new(),
            events: Vec::new(),
            event_words: Vec::new(),
            rich_event_words: Vec::new(),
            overlap_results: Vec::new(),
            debug_lines: Vec::new(),
        }
    }

    pub fn set_character_controller(
        &mut self,
        entity: EntityHandle,
        step_height: f32,
        max_slope_deg: f32,
    ) {
        self.set_character_controller_ex(entity, step_height, max_slope_deg, 0.75, 35.0, 0.12, true);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_character_controller_ex(
        &mut self,
        entity: EntityHandle,
        step_height: f32,
        max_slope_deg: f32,
        push_strength: f32,
        max_push_mass: f32,
        ground_snap: f32,
        anti_tip_push: bool,
    ) {
        let idx = entity_index(entity);
        if idx >= self.character_controllers.len() {
            self.character_controllers.resize(idx + 1, None);
        }
        let cos = max_slope_deg.clamp(1.0, 89.0).to_radians().cos();
        self.character_controllers[idx] = Some(CharacterController {
            step_height: step_height.max(0.0),
            max_slope_cos: cos,
            push_strength: push_strength.max(0.0),
            max_push_mass: max_push_mass.max(0.1),
            ground_snap: ground_snap.clamp(0.0, 0.5),
            anti_tip_push,
        });
    }

    pub fn register_convex_hull(&mut self, points: &[Vec3]) -> (u32, f32) {
        let shape = ConvexHullShape::from_points(points);
        let r = shape.bounding_radius;
        let id = self.convex_hulls.len() as u32;
        self.convex_hulls.push(shape);
        (id, r)
    }

    pub fn register_compound(&mut self, children: Vec<CompoundChild>) -> (u32, f32) {
        let mut max_r = 0.05f32;
        let mut total_vol = 0.0f32;
        for ch in &children {
            let child_r = collider3d_bounding_radius(ch.collider);
            max_r = max_r.max(ch.local_pos.length() + child_r);
            total_vol += primitive_volume(ch.collider, &self.convex_hulls);
        }
        let id = self.compound_shapes.len() as u32;
        self.compound_shapes.push(CompoundShape {
            children,
            bounding_radius: max_r,
            volume: total_vol.max(0.001),
        });
        (id, max_r)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_water_zone(
        &mut self,
        center: Vec3,
        half_extents: Vec3,
        rot: Quat,
        density: f32,
        linear_drag: f32,
        angular_drag: f32,
        flow: Vec3,
    ) -> u32 {
        let id = self.next_water_id;
        self.next_water_id += 1;
        self.water_zones.push(WaterZone {
            id,
            center,
            half_extents: half_extents.max(Vec3::splat(0.05)),
            rot: rot.normalize(),
            density: density.max(0.01),
            linear_drag: linear_drag.max(0.0),
            angular_drag: angular_drag.max(0.0),
            flow,
        });
        id
    }

    pub fn clear_water_zones(&mut self) {
        self.water_zones.clear();
        self.next_water_id = 1;
    }

    pub fn clear_static_geometry(&mut self) {
        self.tile_grids_2d.clear();
        self.static_meshes.clear();
        self.terrain = None;
        self.terrain_entity = INVALID_ENTITY;
        self.joints.clear();
        self.character_controllers.clear();
        self.convex_hulls.clear();
        self.compound_shapes.clear();
        self.water_zones.clear();
        self.next_water_id = 1;
        self.was_grounded.clear();
        self.ground_support.clear();
        self.prev_overlaps.clear();
        self.curr_overlaps.clear();
        self.pair_impulses.clear();
        self.prev_impulses.clear();
        self.manifolds.clear();
        self.clear_events();
        self.accumulator = 0.0;
    }

    pub fn clear_events(&mut self) {
        self.events.clear();
        self.event_words.clear();
        self.rich_event_words.clear();
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

    #[inline]
    pub fn effective_mass(&self, world: &World, idx: usize) -> f32 {
        let Some(rb) = world.rigid_bodies[idx] else {
            return 1.0;
        };
        if rb.density > 0.0 {
            if let Some(col) = world.colliders_3d[idx] {
                return (self.collider_volume(col) * rb.density).max(0.01);
            }
        }
        rb.mass.max(0.01)
    }

    #[inline]
    fn collider_volume(&self, col: Collider3D) -> f32 {
        match col {
            Collider3D::Compound { compound_id, .. } => self
                .compound_shapes
                .get(compound_id as usize)
                .map_or(1.0, |c| c.volume),
            _ => primitive_volume(col, &self.convex_hulls),
        }
    }

    fn body_inv_inertia_world(
        &self,
        col: Option<Collider3D>,
        rot: Quat,
        mass: f32,
        center_of_mass: Vec3,
    ) -> Mat3 {
        let m = mass.max(0.01);
        let base_diag = match col {
            Some(Collider3D::Compound { compound_id, .. }) => {
                if let Some(comp) = self.compound_shapes.get(compound_id as usize) {
                    let count = comp.children.len().max(1) as f32;
                    let part_m = (m / count).max(0.01);
                    let mut acc = Vec3::ZERO;
                    for ch in &comp.children {
                        let d = primitive_local_inertia_diag(Some(ch.collider), part_m);
                        let off = ch.local_pos - center_of_mass;
                        acc += d + Vec3::new(
                            part_m * (off.y * off.y + off.z * off.z),
                            part_m * (off.x * off.x + off.z * off.z),
                            part_m * (off.x * off.x + off.y * off.y),
                        );
                    }
                    Vec3::new(1.0 / acc.x.max(0.005), 1.0 / acc.y.max(0.005), 1.0 / acc.z.max(0.005))
                } else {
                    Vec3::splat(1.0 / (0.5 * m).max(0.01))
                }
            }
            _ => {
                let mut i_local = primitive_local_inertia_diag(col, m);
                if center_of_mass.length_squared() > 1e-8 {
                    let c = center_of_mass;
                    i_local += Vec3::new(
                        m * (c.y * c.y + c.z * c.z),
                        m * (c.x * c.x + c.z * c.z),
                        m * (c.x * c.x + c.y * c.y),
                    );
                }
                Vec3::new(
                    1.0 / i_local.x.max(0.005),
                    1.0 / i_local.y.max(0.005),
                    1.0 / i_local.z.max(0.005),
                )
            }
        };
        let r = Mat3::from_quat(rot);
        r * Mat3::from_diagonal(base_diag) * r.transpose()
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
        let Some(rb_copy) = world.rigid_bodies[idx] else {
            return false;
        };
        if !rb_copy.dynamic {
            return false;
        }
        let mass = self.effective_mass(world, idx);
        if let Some(rb) = &mut world.rigid_bodies[idx] {
            rb.sleeping = false;
            rb.sleep_timer = 0.0;
        }
        let inv_m = 1.0 / mass;
        world.velocities[idx] += impulse * inv_m;
        if !rb_copy.lock_rotation {
            if let Some(pt) = world_point {
                let com_world = world.curr_pos[idx] + world.curr_rot[idx] * rb_copy.center_of_mass;
                let r = pt - com_world;
                let inv_i = self.body_inv_inertia_world(
                    world.colliders_3d[idx],
                    world.curr_rot[idx],
                    mass,
                    rb_copy.center_of_mass,
                );
                world.angular_velocities[idx] += inv_i * r.cross(impulse);
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

    fn apply_water_buoyancy(&mut self, world: &mut World, dt: f32) {
        if self.water_zones.is_empty() {
            return;
        }
        for pos_i in 0..self.awake_indices.len() {
            let i = self.awake_indices[pos_i];
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let Some(rb) = world.rigid_bodies[i] else {
                continue;
            };
            if rb.is_trigger {
                continue;
            }
            let pos = world.curr_pos[i];
            let rot = world.curr_rot[i];
            let (bmin, bmax) = collider_world_aabb(col, pos, rot, &self.convex_hulls, &self.compound_shapes);
            let vol = self.collider_volume(col).max(0.001);
            let mass = self.effective_mass(world, i);
            let body_density = (mass / vol).max(0.05);

            for wz in 0..self.water_zones.len() {
                let water = self.water_zones[wz];
                let local_p = water.rot.conjugate() * (pos - water.center);
                let top_y = water.center.y + water.half_extents.y;
                if local_p.x.abs() > water.half_extents.x + 0.5
                    || local_p.z.abs() > water.half_extents.z + 0.5
                    || bmin.y >= top_y
                    || bmax.y <= water.center.y - water.half_extents.y
                {
                    continue;
                }
                let height = (bmax.y - bmin.y).max(0.05);
                let submerged = ((top_y - bmin.y) / height).clamp(0.0, 1.0);
                if submerged <= 0.0 {
                    continue;
                }
                let handle_a = make_handle(world, i);
                self.record_overlap(handle_a, 0x7FFF_0000 | water.id, true);

                // Archimedes upward buoyancy: (water_density / body_density) * (-g) * submerged_fraction
                let ratio = (water.density / body_density).min(6.0);
                world.velocities[i] += -self.config.gravity * (rb.gravity_scale * ratio * submerged * dt);

                // Hydrodynamic linear & angular drag + subtle righting torque near surface
                let rel_v = world.velocities[i] - water.flow;
                let drag = (1.0 - water.linear_drag * submerged * dt).clamp(0.0, 1.0);
                world.velocities[i] = water.flow + rel_v * drag;
                let ang_drag = (1.0 - water.angular_drag * submerged * dt).clamp(0.0, 1.0);
                world.angular_velocities[i] *= ang_drag;
            }
        }
    }

    fn run_ccd_pass(&self, world: &mut World) {
        let mut tmp = [ContactPoint::default(); 8];
        for &i in &self.awake_indices {
            let Some(rb_a) = world.rigid_bodies[i] else {
                continue;
            };
            if rb_a.is_trigger {
                continue;
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let start = self.pre_step_pos[i];
            let end = world.curr_pos[i];
            let disp = end - start;
            let dist = disp.length();
            let minor = collider_minor_extent(col).max(0.05);
            if !rb_a.ccd && dist <= minor * 0.45 {
                continue;
            }
            if dist < minor * 0.25 {
                continue;
            }
            let substeps = ((dist / (minor * 0.25)).ceil() as usize).clamp(2, 24);
            let rot_a = world.curr_rot[i];
            let handle_a = make_handle(world, i);
            let mut hit_pos: Option<(Vec3, Vec3)> = None;

            for s in 1..=substeps {
                let t = s as f32 / substeps as f32;
                let probe_pos = start + disp * t;
                let mut hit_n = Vec3::ZERO;
                let mut max_d = 0.0f32;

                // Static geometry check
                for &stat_idx in &self.static_indices_3d {
                    let Some(stat_col) = world.colliders_3d[stat_idx] else {
                        continue;
                    };
                    let rb_b = world.rigid_bodies[stat_idx];
                    if rb_b.map_or(false, |r| r.is_trigger) || !layers_match(Some(rb_a), rb_b) {
                        continue;
                    }
                    let mut cnt = 0usize;
                    collect_3d_contacts_with_shapes(
                        col,
                        probe_pos,
                        rot_a,
                        stat_col,
                        world.curr_pos[stat_idx],
                        world.curr_rot[stat_idx],
                        Some(stat_idx),
                        false,
                        &self.convex_hulls,
                        &self.compound_shapes,
                        &mut tmp,
                        &mut cnt,
                    );
                    for c in &tmp[..cnt] {
                        if c.depth > max_d {
                            max_d = c.depth;
                            hit_n = c.normal;
                        }
                    }
                }

                // Dynamic bodies check (for fast bullets hitting stacked crates!)
                for &other in &self.dynamic_indices {
                    if other == i {
                        continue;
                    }
                    let Some(col_b) = world.colliders_3d[other] else {
                        continue;
                    };
                    let rb_b = world.rigid_bodies[other];
                    if rb_b.map_or(false, |r| r.is_trigger) || !layers_match(Some(rb_a), rb_b) {
                        continue;
                    }
                    if self.joints.has_pair(handle_a, make_handle(world, other)) {
                        continue;
                    }
                    let mut cnt = 0usize;
                    collect_3d_contacts_with_shapes(
                        col,
                        probe_pos,
                        rot_a,
                        col_b,
                        world.curr_pos[other],
                        world.curr_rot[other],
                        Some(other),
                        true,
                        &self.convex_hulls,
                        &self.compound_shapes,
                        &mut tmp,
                        &mut cnt,
                    );
                    for c in &tmp[..cnt] {
                        if c.depth > max_d {
                            max_d = c.depth;
                            hit_n = c.normal;
                        }
                    }
                }

                // Static triangle meshes check
                let r_bound = collider3d_bounding_radius(col) + 0.05;
                let mut local_bvh = [0usize; 0];
                let _ = &mut local_bvh;
                for m_idx in 0..self.static_meshes.len() {
                    let m = &self.static_meshes[m_idx];
                    if probe_pos.x + r_bound < m.bounds_min.x
                        || probe_pos.x - r_bound > m.bounds_max.x
                        || probe_pos.y + r_bound < m.bounds_min.y
                        || probe_pos.y - r_bound > m.bounds_max.y
                        || probe_pos.z + r_bound < m.bounds_min.z
                        || probe_pos.z - r_bound > m.bounds_max.z
                    {
                        continue;
                    }
                    for (tri_i, &tri) in m.triangles.iter().enumerate() {
                        let mut cnt = 0usize;
                        collect_triangle_contacts_ex(
                            col,
                            probe_pos,
                            rot_a,
                            tri,
                            m.internal_edges[tri_i],
                            &self.convex_hulls,
                            &self.compound_shapes,
                            &mut tmp,
                            &mut cnt,
                        );
                        for c in &tmp[..cnt] {
                            if c.depth > max_d {
                                max_d = c.depth;
                                hit_n = c.normal;
                            }
                        }
                    }
                }

                if max_d > 1e-4 {
                    // Place body cleanly overlapping slightly at TOI so solver handles bounce & friction accurately
                    let prev_t = ((s - 1) as f32 / substeps as f32).max(0.0);
                    let toi_pos = start + disp * prev_t + disp.normalize() * (minor * 0.05).min(0.02);
                    hit_pos = Some((toi_pos, hit_n));
                    break;
                }
            }

            if let Some((toi_pos, _hit_n)) = hit_pos {
                world.curr_pos[i] = toi_pos;
            }
        }
    }

    fn step_fixed(&mut self, world: &mut World, dt: f32) {
        self.dynamic_indices.clear();
        self.awake_indices.clear();
        self.static_indices_3d.clear();
        self.static_indices_2d.clear();
        self.curr_overlaps.clear();
        self.pair_impulses.clear();

        let count = world.alive.len();
        if self.ground_support.len() < count {
            self.ground_support.resize(count, None);
        }
        if self.was_grounded.len() < count {
            self.was_grounded.resize(count, false);
        }
        if self.pre_step_pos.len() < count {
            self.pre_step_pos.resize(count, Vec3::ZERO);
        }

        // Apply spring joint impulses & reset substep break counters
        self.joints.retain_alive(world);
        self.joints.begin_substep();
        self.joints.apply_springs(world, dt);

        // Wake riders whose supporting platform moved/rotated or disappeared
        for i in 0..count {
            if !world.alive[i] {
                self.ground_support[i] = None;
                self.was_grounded[i] = false;
                continue;
            }
            self.was_grounded[i] = world.rigid_bodies[i].map_or(false, |r| r.grounded);
            if let Some((plat_idx, last_pos, last_rot)) = self.ground_support[i] {
                if plat_idx < count && world.alive[plat_idx] {
                    let moved = world.curr_pos[plat_idx].distance_squared(last_pos) > 1e-8
                        || last_rot.dot(world.curr_rot[plat_idx]).abs() < 0.999999;
                    if moved {
                        if let Some(rb) = &mut world.rigid_bodies[i] {
                            rb.sleeping = false;
                            rb.sleep_timer = 0.0;
                        }
                    }
                } else {
                    self.ground_support[i] = None;
                    if let Some(rb) = &mut world.rigid_bodies[i] {
                        rb.sleeping = false;
                        rb.sleep_timer = 0.0;
                    }
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
                    if rb.sleeping && rb.can_sleep {
                        continue;
                    }
                    rb.sleeping = false;
                    rb.grounded = false;
                    self.pre_step_pos[i] = world.curr_pos[i];
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

        // Apply water Archimedes buoyancy & drag before velocity integration
        self.apply_water_buoyancy(world, dt);

        // Integrate velocities & positions for awake bodies
        for &i in &self.awake_indices {
            if let Some(rb) = world.rigid_bodies[i] {
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
                        let com_local = rb.center_of_mass;
                        if com_local.length_squared() > 1e-8 {
                            let com_world = world.curr_pos[i] + world.curr_rot[i] * com_local;
                            let next_rot = (dq * world.curr_rot[i]).normalize();
                            world.curr_rot[i] = next_rot;
                            world.curr_pos[i] = com_world - next_rot * com_local;
                        } else {
                            world.curr_rot[i] = (dq * world.curr_rot[i]).normalize();
                        }
                    }
                } else {
                    world.angular_velocities[i] = Vec3::ZERO;
                }
            }
        }

        // Carry grounded riders along moving + rotating platforms
        for &i in &self.awake_indices {
            if let Some((plat_idx, last_pos, last_rot)) = self.ground_support[i] {
                if plat_idx < count && world.alive[plat_idx] {
                    let dq = (world.curr_rot[plat_idx] * last_rot.conjugate()).normalize();
                    let rel_offset = world.curr_pos[i] - last_pos;
                    let rotated_pos = world.curr_pos[plat_idx] + dq * rel_offset;
                    if rotated_pos.distance_squared(world.curr_pos[i]) > 1e-10 {
                        world.curr_pos[i] = rotated_pos;
                    }
                    let yaw_rot = dq;
                    if yaw_rot.w < 0.999999 && self.character_controllers.get(i).copied().flatten().is_none() {
                        world.curr_rot[i] = (yaw_rot * world.curr_rot[i]).normalize();
                    }
                }
                self.ground_support[i] = None;
            }
        }

        self.static_meshes
            .retain(|m| m.entity == INVALID_ENTITY || world.is_alive(m.entity));

        // 1. Continuous Collision Detection pass for fast or ccd-enabled bodies
        self.run_ccd_pass(world);

        // 2. Rotated-AABB Sweep-and-Prune Broadphase + 3D contact manifold generation + warm start
        self.build_dynamic_pairs(world);
        self.gather_3d_manifolds(world);
        self.warm_start_manifolds(world);

        // 3. Sequential Impulse (Symmetric PGS) velocity solver + circular Coulomb static/dynamic cone + joints
        for iter in 0..self.config.solver_iterations {
            self.solve_3d_velocity_constraints(world, iter);
            for idx_pos in 0..self.awake_indices.len() {
                let dyn_idx = self.awake_indices[idx_pos];
                if world.colliders_2d[dyn_idx].is_some() {
                    self.resolve_2d_entity(world, dyn_idx);
                }
            }
            self.joints.solve_constraints(world, dt);
        }
        self.joints.break_overloaded(dt);
        self.save_warm_impulses(world);

        // Record accumulated normal collision impulses for rich event callbacks
        self.record_collision_impulses(world);

        // 4. Split-impulse position stabilization
        self.solve_3d_position_constraints(world);

        // 5. Optional ground snap for CharacterController stepping cleanly down ramps/stairs
        self.ground_snap_controllers(world);

        // Snapshot updated platform transforms for next tick's rider carry
        for i in 0..self.ground_support.len() {
            if let Some((plat_idx, _, _)) = self.ground_support[i] {
                if plat_idx < count && world.alive[plat_idx] {
                    self.ground_support[i] =
                        Some((plat_idx, world.curr_pos[plat_idx], world.curr_rot[plat_idx]));
                } else {
                    self.ground_support[i] = None;
                }
            }
        }

        // 6. Connected-island sleeping so stacked piles rest quietly together
        self.update_sleeping_islands(world, dt);

        self.emit_overlap_events();
    }

    fn build_dynamic_pairs(&mut self, world: &World) {
        self.sweep_boxes.clear();
        self.pair_scratch.clear();
        for &idx in &self.dynamic_indices {
            let Some(col) = world.colliders_3d[idx] else {
                continue;
            };
            let pos = world.curr_pos[idx];
            let rot = world.curr_rot[idx];
            let (bmin, bmax) =
                collider_world_aabb(col, pos, rot, &self.convex_hulls, &self.compound_shapes);
            self.sweep_boxes
                .push((bmin.x, bmax.x, bmin.y, bmax.y, bmin.z, bmax.z, idx));
        }

        self.sweep_boxes
            .sort_unstable_by(|a, b| a.0.total_cmp(&b.0));

        let n = self.sweep_boxes.len();
        for i in 0..n {
            let (_min_xa, max_xa, min_ya, max_ya, min_za, max_za, a) = self.sweep_boxes[i];
            let a_sleep = world.rigid_bodies[a].map_or(false, |r| r.sleeping);
            for j in (i + 1)..n {
                let (min_xb, _max_xb, min_yb, max_yb, min_zb, max_zb, b) = self.sweep_boxes[j];
                if min_xb > max_xa {
                    break;
                }
                if min_ya > max_yb || max_ya < min_yb || min_za > max_zb || max_za < min_zb {
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
        slope_cos: f32,
        record_overlaps: bool,
        handle_a: EntityHandle,
        contacts: &mut [ContactPoint],
    ) -> usize {
        let mut contact_count = 0usize;
        let mut ground_stat_idx: Option<usize> = None;

        // 1. Static 3D colliders (including triggers)
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
                let mut tmp = [ContactPoint::default(); 4];
                let mut tmp_count = 0usize;
                collect_3d_contacts_with_shapes(
                    col,
                    pos_a,
                    rot_a,
                    stat_col,
                    world.curr_pos[stat_idx],
                    world.curr_rot[stat_idx],
                    Some(stat_idx),
                    false,
                    &self.convex_hulls,
                    &self.compound_shapes,
                    &mut tmp,
                    &mut tmp_count,
                );
                if tmp_count > 0 && record_overlaps {
                    self.record_overlap(handle_a, make_handle(world, stat_idx), true);
                }
                continue;
            }
            let before = contact_count;
            collect_3d_contacts_with_shapes(
                col,
                pos_a,
                rot_a,
                stat_col,
                world.curr_pos[stat_idx],
                world.curr_rot[stat_idx],
                Some(stat_idx),
                false,
                &self.convex_hulls,
                &self.compound_shapes,
                contacts,
                &mut contact_count,
            );
            if contact_count > before {
                if record_overlaps {
                    self.record_overlap(handle_a, make_handle(world, stat_idx), false);
                }
                if contacts[before..contact_count]
                    .iter()
                    .any(|c| c.normal.y >= slope_cos && is_bottom_support(col, pos_a, rot_a, c.point))
                {
                    ground_stat_idx = Some(stat_idx);
                }
            }
        }
        if record_overlaps {
            if let Some(p_idx) = ground_stat_idx {
                if dyn_idx < self.ground_support.len() {
                    self.ground_support[dyn_idx] =
                        Some((p_idx, world.curr_pos[p_idx], world.curr_rot[p_idx]));
                }
            }
        }

        // 2. Static triangle meshes via BVH + Terrain heightmap (skipped for triggers)
        if !rb_a.is_trigger {
            if let Some(hm) = &self.terrain {
                let (rx, bottom_off, rz) = match col {
                    Collider3D::Sphere { radius } => (radius * 0.6, radius, radius * 0.6),
                    Collider3D::Capsule { radius, half_height } => {
                        (radius * 0.65, radius + half_height, radius * 0.65)
                    }
                    Collider3D::Cylinder { radius, half_height } => {
                        (radius * 0.7, half_height, radius * 0.7)
                    }
                    Collider3D::Aabb { half_extents } => {
                        (half_extents.x * 0.75, half_extents.y, half_extents.z * 0.75)
                    }
                    Collider3D::ConvexHull { bounding_radius, .. }
                    | Collider3D::Compound { bounding_radius, .. } => {
                        (bounding_radius * 0.6, bounding_radius, bounding_radius * 0.6)
                    }
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
                let mut best_n = Vec3::Y;
                let mut best_pt = Vec3::ZERO;
                for (sx, sz) in samples {
                    if let Some((th, tn)) = hm.sample_height_and_normal(sx, sz) {
                        let pen = (th - bottom_y) * tn.y.max(0.35);
                        if pen > best_depth {
                            best_depth = pen;
                            best_n = tn;
                            best_pt = Vec3::new(sx, th, sz);
                        }
                    }
                }
                if best_depth > 0.0 && contact_count < contacts.len() {
                    let terr_idx = if self.terrain_entity != INVALID_ENTITY {
                        Some(entity_index(self.terrain_entity))
                    } else {
                        None
                    };
                    contacts[contact_count] = ContactPoint {
                        point: best_pt,
                        normal: best_n,
                        depth: best_depth,
                        other_idx: terr_idx,
                    };
                    contact_count += 1;
                }
            }

            let r_bound = collider3d_bounding_radius(col) + 0.1;
            let qmin = pos_a - Vec3::splat(r_bound);
            let qmax = pos_a + Vec3::splat(r_bound);
            for m_idx in 0..self.static_meshes.len() {
                let mesh_stat = if self.static_meshes[m_idx].entity != INVALID_ENTITY {
                    Some(entity_index(self.static_meshes[m_idx].entity))
                } else {
                    None
                };
                self.static_meshes[m_idx].query_aabb(qmin, qmax, &mut self.bvh_scratch);
                for &t_idx in &self.bvh_scratch {
                    let tri = self.static_meshes[m_idx].triangles[t_idx];
                    let edge_mask = self.static_meshes[m_idx].internal_edges[t_idx];
                    let before = contact_count;
                    collect_triangle_contacts_ex(
                        col,
                        pos_a,
                        rot_a,
                        tri,
                        edge_mask,
                        &self.convex_hulls,
                        &self.compound_shapes,
                        contacts,
                        &mut contact_count,
                    );
                    for c in &mut contacts[before..contact_count] {
                        c.other_idx = mesh_stat;
                    }
                }
            }
        }
        contact_count
    }

    #[allow(clippy::too_many_arguments)]
    fn probe_step_candidate(
        &mut self,
        world: &World,
        dyn_idx: usize,
        col: Collider3D,
        rot_a: Quat,
        rb_a: RigidBody,
        test_pos: Vec3,
        slope_cos: f32,
        step_h: f32,
    ) -> bool {
        // 1. Ensure lifting up doesn't clip into a ceiling
        let mut head_probe = [ContactPoint::default(); 16];
        let head_count = self.gather_static_contacts(
            world,
            dyn_idx,
            col,
            test_pos,
            rot_a,
            rb_a,
            slope_cos,
            false,
            INVALID_ENTITY,
            &mut head_probe,
        );
        let blocked = head_probe[..head_count].iter().any(|c| {
            (c.normal.y < 0.88 && c.depth > 0.008)
                || (c.normal.y < -0.35 && c.depth > 0.008)
        });
        if blocked {
            return false;
        }

        // 2. Verify there is actually a walkable landing surface right beneath the stepped position
        let mut foot_probe = [ContactPoint::default(); 16];
        for down in [0.06f32, 0.16, (step_h * 0.75).max(0.22)] {
            let settle_pos = test_pos - Vec3::Y * down;
            let foot_count = self.gather_static_contacts(
                world,
                dyn_idx,
                col,
                settle_pos,
                rot_a,
                rb_a,
                slope_cos,
                false,
                INVALID_ENTITY,
                &mut foot_probe,
            );
            if foot_probe[..foot_count]
                .iter()
                .any(|c| c.normal.y >= slope_cos && is_bottom_support(col, settle_pos, rot_a, c.point))
            {
                return true;
            }
        }
        false
    }

    fn gather_static_manifolds_for_entity(&mut self, world: &mut World, dyn_idx: usize) {
        let Some(col) = world.colliders_3d[dyn_idx] else {
            return;
        };
        let Some(rb_a) = world.rigid_bodies[dyn_idx] else {
            return;
        };

        let cc = self.character_controllers.get(dyn_idx).copied().flatten();
        let slope_cos = cc.map_or(0.45, |c| c.max_slope_cos);

        let mut contacts = [ContactPoint::default(); 32];
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
            slope_cos,
            true,
            handle_a,
            &mut contacts,
        );
        if contact_count == 0 {
            return;
        }

        // Stair auto-step-up for CharacterController: only when grounded/level and meeting a low curb <= step_height
        if !rb_a.is_trigger {
            if let Some(ctrl) = cc {
                let is_jumping_up = world.velocities[dyn_idx].y > 2.5;
                if ctrl.step_height > 0.01 && !is_jumping_up {
                    let has_wall = contacts[..contact_count]
                        .iter()
                        .any(|c| c.normal.y.abs() < ctrl.max_slope_cos && c.depth > 0.005);
                    let has_floor = contacts[..contact_count]
                        .iter()
                        .any(|c| c.normal.y >= ctrl.max_slope_cos && is_bottom_support(col, pos_a, rot_a, c.point))
                        || self.was_grounded.get(dyn_idx).copied().unwrap_or(false);
                    let hv = Vec3::new(world.velocities[dyn_idx].x, 0.0, world.velocities[dyn_idx].z);
                    if has_wall && has_floor && hv.length_squared() > 0.01 {
                        let dir_xz = hv.normalize();
                        let nudge = dir_xz * 0.22;
                        for frac in [0.2f32, 0.4, 0.6, 0.8, 1.0] {
                            let h = ctrl.step_height * frac;
                            let test_pos = pos_a + Vec3::Y * h + nudge;
                            if self.probe_step_candidate(
                                world,
                                dyn_idx,
                                col,
                                rot_a,
                                rb_a,
                                test_pos,
                                ctrl.max_slope_cos,
                                h,
                            ) {
                                let stepped_pos = pos_a + Vec3::Y * (h + 0.004) + nudge;
                                world.curr_pos[dyn_idx] = stepped_pos;
                                world.velocities[dyn_idx].y = world.velocities[dyn_idx].y.max(0.0);
                                contact_count = self.gather_static_contacts(
                                    world,
                                    dyn_idx,
                                    col,
                                    stepped_pos,
                                    rot_a,
                                    rb_a,
                                    ctrl.max_slope_cos,
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

        if contact_count == 0 || rb_a.is_trigger {
            return;
        }

        let pos_now = world.curr_pos[dyn_idx];
        for c in &contacts[..contact_count] {
            let on_bottom = is_bottom_support(col, pos_now, rot_a, c.point);
            if c.normal.y >= slope_cos && on_bottom {
                if let Some(rb) = &mut world.rigid_bodies[dyn_idx] {
                    rb.grounded = true;
                }
            }
            let steep_for_cc = cc.is_some() && c.normal.y > 0.05 && c.normal.y < slope_cos;
            let (stat_fric, stat_sfric, stat_rest, rest_thresh) = c
                .other_idx
                .and_then(|s_idx| world.rigid_bodies.get(s_idx).copied().flatten())
                .map_or(
                    (
                        rb_a.friction.max(0.0),
                        effective_static_friction(rb_a),
                        rb_a.restitution,
                        rb_a.restitution_threshold,
                    ),
                    |rb_s| combine_materials(rb_a, rb_s),
                );
            let allow_fric = if cc.is_some() {
                c.normal.y >= slope_cos && on_bottom && stat_fric > 0.0
            } else {
                stat_fric > 0.0
            };
            self.push_manifold_contact(
                world,
                dyn_idx,
                usize::MAX,
                false,
                *c,
                stat_fric,
                stat_sfric,
                stat_rest,
                rest_thresh,
                allow_fric,
                steep_for_cc,
                1.0,
                false,
                1.0,
                false,
            );
        }
    }

    fn gather_3d_manifolds(&mut self, world: &mut World) {
        self.manifolds.clear();

        let initial_awake = self.awake_indices.len();
        for idx_pos in 0..initial_awake {
            let dyn_idx = self.awake_indices[idx_pos];
            if world.colliders_3d[dyn_idx].is_some() {
                self.gather_static_manifolds_for_entity(world, dyn_idx);
            }
        }

        let mut contacts = [ContactPoint::default(); 16];
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
            let rot_a = world.curr_rot[a];
            let rot_b = world.curr_rot[b];
            let r_sum = collider3d_bounding_radius(col_a) + collider3d_bounding_radius(col_b);
            if pos_a.distance_squared(pos_b) > r_sum * r_sum {
                continue;
            }

            let mut count = 0usize;
            collect_3d_contacts_with_shapes(
                col_a,
                pos_a,
                rot_a,
                col_b,
                pos_b,
                rot_b,
                Some(b),
                true,
                &self.convex_hulls,
                &self.compound_shapes,
                &mut contacts,
                &mut count,
            );
            if count == 0 {
                continue;
            }

            let is_trigger_pair = rb_a.is_trigger || rb_b.is_trigger;
            self.record_overlap(make_handle(world, a), make_handle(world, b), is_trigger_pair);
            if is_trigger_pair {
                continue;
            }

            let mut max_depth = 0.0f32;
            for c in &contacts[..count] {
                max_depth = max_depth.max(c.depth);
            }

            // Wake sleeping partner on genuine dynamic impact or intrusion > 8 mm
            let rel_speed_sq = (world.velocities[a] - world.velocities[b]).length_squared();
            if rel_speed_sq > 0.008 || max_depth > 0.008 {
                for &target in &[a, b] {
                    let mut woke_idx = None;
                    if let Some(rb) = &mut world.rigid_bodies[target] {
                        if rb.sleeping {
                            woke_idx = Some(target);
                        }
                        rb.sleeping = false;
                        rb.sleep_timer = 0.0;
                    }
                    if let Some(w_idx) = woke_idx {
                        self.awake_indices.push(w_idx);
                        self.gather_static_manifolds_for_entity(world, w_idx);
                    }
                }
            }

            let cc_a = self.character_controllers.get(a).copied().flatten();
            let cc_b = self.character_controllers.get(b).copied().flatten();
            let slope_a = cc_a.map_or(0.45, |c| c.max_slope_cos);
            let slope_b = cc_b.map_or(0.45, |c| c.max_slope_cos);

            let mut a_on_b = false;
            let mut b_on_a = false;
            for c in &contacts[..count] {
                if c.normal.y >= slope_a && is_bottom_support(col_a, pos_a, rot_a, c.point) {
                    a_on_b = true;
                }
                if (-c.normal.y) >= slope_b && is_bottom_support(col_b, pos_b, rot_b, c.point) {
                    b_on_a = true;
                }
            }

            if a_on_b {
                if let Some(rb) = &mut world.rigid_bodies[a] {
                    rb.grounded = true;
                }
                if a < self.ground_support.len() && (cc_a.is_some() || !rb_b.dynamic) {
                    self.ground_support[a] = Some((b, world.curr_pos[b], world.curr_rot[b]));
                }
            }
            if b_on_a {
                if let Some(rb) = &mut world.rigid_bodies[b] {
                    rb.grounded = true;
                }
                if b < self.ground_support.len() && (cc_b.is_some() || !rb_a.dynamic) {
                    self.ground_support[b] = Some((a, world.curr_pos[a], world.curr_rot[a]));
                }
            }

            let (friction, static_friction, restitution, rest_thresh) = combine_materials(rb_a, rb_b);
            let mass_a = self.effective_mass(world, a);
            let mass_b = self.effective_mass(world, b);

            for c in &contacts[..count] {
                let standing_top = (cc_a.is_some() && c.normal.y >= slope_a)
                    || (cc_b.is_some() && (-c.normal.y) >= slope_b);
                let is_cc_pair = cc_a.is_some() || cc_b.is_some();
                // CharacterController rides supports via ground_support carry without shooting crates out from underfoot
                let allow_friction = friction > 0.0 && !is_cc_pair;

                let steep_for_a = cc_a.is_some() && c.normal.y > 0.05 && c.normal.y < slope_a;

                // Controlled CharacterController <-> Dynamic crate push (symmetric regardless of entity order)
                let anti_tip_contact_y = |pos_y: f32, com_y: f32, contact_y: f32| -> f32 {
                    if !pos_y.is_finite() || !com_y.is_finite() || !contact_y.is_finite() {
                        return pos_y;
                    }
                    let lo = (pos_y - 0.15).min(contact_y);
                    let hi = contact_y.max(lo);
                    (pos_y + com_y).clamp(lo, hi)
                };
                let mut push_scale_a = 1.0f32;
                let mut push_scale_b = 1.0f32;
                let mut anti_tip_a = false;
                let mut anti_tip_b = false;
                let mut contact_override = *c;
                if let (Some(ctrl), None) = (cc_a, cc_b) {
                    if !standing_top && c.normal.y.abs() < slope_a {
                        let ratio = (ctrl.max_push_mass / mass_b.max(0.01)).min(1.0);
                        push_scale_b = ctrl.push_strength * ratio;
                        anti_tip_b = ctrl.anti_tip_push && rb_b.grounded;
                        if anti_tip_b {
                            contact_override.point.y =
                                anti_tip_contact_y(pos_b.y, rb_b.center_of_mass.y, c.point.y);
                        }
                    }
                } else if let (None, Some(ctrl)) = (cc_a, cc_b) {
                    if !standing_top && c.normal.y.abs() < slope_b {
                        let ratio = (ctrl.max_push_mass / mass_a.max(0.01)).min(1.0);
                        push_scale_a = ctrl.push_strength * ratio;
                        anti_tip_a = ctrl.anti_tip_push && rb_a.grounded;
                        if anti_tip_a {
                            contact_override.point.y =
                                anti_tip_contact_y(pos_a.y, rb_a.center_of_mass.y, c.point.y);
                        }
                    }
                }

                self.push_manifold_contact(
                    world,
                    a,
                    b,
                    true,
                    contact_override,
                    friction,
                    static_friction,
                    restitution,
                    rest_thresh,
                    allow_friction,
                    steep_for_a,
                    push_scale_a,
                    anti_tip_a,
                    push_scale_b,
                    anti_tip_b,
                );
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn push_manifold_contact(
        &mut self,
        world: &World,
        a: usize,
        b: usize,
        is_dynamic_b: bool,
        c: ContactPoint,
        friction: f32,
        static_friction: f32,
        restitution: f32,
        rest_thresh: f32,
        allow_friction: bool,
        steep_for_a: bool,
        push_scale_a: f32,
        anti_tip_a: bool,
        push_scale_b: f32,
        anti_tip_b: bool,
    ) {
        let Some(rb_a) = world.rigid_bodies[a] else {
            return;
        };
        let mass_a = self.effective_mass(world, a);
        let inv_m_a = (1.0 / mass_a) * push_scale_a;
        let lock_rot_a = rb_a.lock_rotation || anti_tip_a;
        let inv_i_a = if lock_rot_a {
            Mat3::ZERO
        } else {
            self.body_inv_inertia_world(
                world.colliders_3d[a],
                world.curr_rot[a],
                mass_a,
                rb_a.center_of_mass,
            )
        };
        let (inv_m_b, inv_i_b, lock_rot_b, pos_b, vel_b, ang_b, com_b) = if is_dynamic_b {
            let Some(rb_b) = world.rigid_bodies[b] else {
                return;
            };
            let mass_b = self.effective_mass(world, b);
            let ib = if rb_b.lock_rotation || anti_tip_b {
                Mat3::ZERO
            } else {
                self.body_inv_inertia_world(
                    world.colliders_3d[b],
                    world.curr_rot[b],
                    mass_b,
                    rb_b.center_of_mass,
                )
            };
            (
                (1.0 / mass_b) * push_scale_b,
                ib,
                rb_b.lock_rotation || anti_tip_b,
                world.curr_pos[b],
                world.velocities[b],
                world.angular_velocities[b],
                rb_b.center_of_mass,
            )
        } else {
            (0.0, Mat3::ZERO, true, Vec3::ZERO, Vec3::ZERO, Vec3::ZERO, Vec3::ZERO)
        };

        let n = c.normal.normalize_or_zero();
        if n.length_squared() < 0.5 {
            return;
        }
        let t1 = if n.x.abs() >= 0.57735 {
            Vec3::new(n.y, -n.x, 0.0).normalize()
        } else {
            Vec3::new(0.0, n.z, -n.y).normalize()
        };
        let t2 = n.cross(t1);

        let pos_a = world.curr_pos[a];
        let com_world_a = pos_a + world.curr_rot[a] * rb_a.center_of_mass;
        let com_world_b = if is_dynamic_b {
            pos_b + world.curr_rot[b] * com_b
        } else {
            Vec3::ZERO
        };
        let ra = c.point - com_world_a;
        let rb_vec = if is_dynamic_b { c.point - com_world_b } else { Vec3::ZERO };

        let eff_mass = |dir: Vec3| -> f32 {
            let r_xa = ra.cross(dir);
            let r_xb = rb_vec.cross(dir);
            let ang_a = if lock_rot_a {
                0.0
            } else {
                r_xa.dot(inv_i_a * r_xa)
            };
            let ang_b = if lock_rot_b {
                0.0
            } else {
                r_xb.dot(inv_i_b * r_xb)
            };
            let denom = inv_m_a + inv_m_b + ang_a + ang_b;
            if denom > 1e-8 { 1.0 / denom } else { 0.0 }
        };

        let eff_mass_n = eff_mass(n);
        if eff_mass_n <= 0.0 {
            return;
        }
        let eff_mass_t1 = eff_mass(t1);
        let eff_mass_t2 = eff_mass(t2);

        let va = world.velocities[a] + world.angular_velocities[a].cross(ra);
        let vb = vel_b + ang_b.cross(rb_vec);
        let vn_init = (va - vb).dot(n);
        let vel_bias = if vn_init < -rest_thresh.max(0.2) {
            -restitution * vn_init
        } else {
            0.0
        };

        let local_a = world.curr_rot[a].conjugate() * ra;

        self.manifolds.push(ManifoldContact {
            a,
            b,
            is_dynamic_b,
            normal: n,
            t1,
            t2,
            point: c.point,
            depth: c.depth,
            init_pos_a: pos_a,
            init_pos_b: pos_b,
            ra,
            rb: rb_vec,
            inv_m_a,
            inv_m_b,
            inv_i_a,
            inv_i_b,
            eff_mass_n,
            eff_mass_t1,
            eff_mass_t2,
            vel_bias,
            friction,
            static_friction,
            allow_friction,
            lock_rot_a,
            lock_rot_b,
            steep_for_a,
            acc_n: 0.0,
            acc_t1: 0.0,
            acc_t2: 0.0,
            local_a,
        });
    }

    fn warm_start_manifolds(&mut self, world: &mut World) {
        if self.prev_impulses.is_empty() || self.manifolds.is_empty() {
            return;
        }
        for c in &mut self.manifolds {
            if c.vel_bias > 0.0 {
                continue;
            }
            let a = c.a;
            let b = c.b;
            let gen_a = world.generations[a];
            let start = self.prev_impulses.partition_point(|p| (p.a, p.b) < (a, b));
            for p in &self.prev_impulses[start..] {
                if p.a != a || p.b != b {
                    break;
                }
                if p.gen_a != gen_a {
                    continue;
                }
                if p.normal.dot(c.normal) > 0.92 && p.local_a.distance_squared(c.local_a) < 0.0025 {
                    c.acc_n = p.acc_n * 0.96;
                    if c.allow_friction {
                        c.acc_t1 = p.tang_imp.dot(c.t1) * 0.90;
                        c.acc_t2 = p.tang_imp.dot(c.t2) * 0.90;
                    }
                    let imp = c.normal * c.acc_n + c.t1 * c.acc_t1 + c.t2 * c.acc_t2;
                    world.velocities[a] += imp * c.inv_m_a;
                    if !c.lock_rot_a {
                        world.angular_velocities[a] += c.inv_i_a * c.ra.cross(imp);
                    }
                    if c.is_dynamic_b {
                        world.velocities[b] -= imp * c.inv_m_b;
                        if !c.lock_rot_b {
                            world.angular_velocities[b] -= c.inv_i_b * c.rb.cross(imp);
                        }
                    }
                    break;
                }
            }
        }
    }

    fn save_warm_impulses(&mut self, world: &World) {
        self.prev_impulses.clear();
        for c in &self.manifolds {
            if c.acc_n <= 1e-6 {
                continue;
            }
            self.prev_impulses.push(CachedImpulse {
                a: c.a,
                b: c.b,
                gen_a: world.generations[c.a],
                local_a: c.local_a,
                normal: c.normal,
                acc_n: c.acc_n,
                tang_imp: c.t1 * c.acc_t1 + c.t2 * c.acc_t2,
            });
        }
        self.prev_impulses.sort_unstable_by_key(|p| (p.a, p.b));
    }

    fn record_collision_impulses(&mut self, world: &World) {
        for c in &self.manifolds {
            if !c.is_dynamic_b || c.acc_n <= 0.05 {
                continue;
            }
            let ea = make_handle(world, c.a);
            let eb = make_handle(world, c.b);
            let (lo, hi) = if ea <= eb { (ea, eb) } else { (eb, ea) };
            self.pair_impulses.push((lo, hi, c.normal, c.point, c.acc_n));
        }
        self.pair_impulses.sort_unstable_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    }

    fn solve_3d_velocity_constraints(&mut self, world: &mut World, iter: u32) {
        let len = self.manifolds.len();
        if len == 0 {
            return;
        }
        let reverse = (iter & 1) == 1;

        for step_i in 0..len {
            let i = if reverse { len - 1 - step_i } else { step_i };
            let c = &mut self.manifolds[i];
            let a = c.a;
            let b = c.b;

            let va = world.velocities[a] + world.angular_velocities[a].cross(c.ra);
            let vb = if c.is_dynamic_b {
                world.velocities[b] + world.angular_velocities[b].cross(c.rb)
            } else {
                Vec3::ZERO
            };
            let vn = (va - vb).dot(c.normal);
            let omega = if iter + 2 < self.config.solver_iterations { 0.72 } else { 1.0 };
            let djn_raw = -(vn - c.vel_bias) * c.eff_mass_n * omega;
            let old_n = c.acc_n;
            c.acc_n = (old_n + djn_raw).max(0.0);
            let djn = c.acc_n - old_n;
            if djn.abs() > 1e-8 {
                let imp_n = c.normal * djn;
                world.velocities[a] += imp_n * c.inv_m_a;
                if !c.lock_rot_a {
                    world.angular_velocities[a] += c.inv_i_a * c.ra.cross(imp_n);
                }
                if c.is_dynamic_b {
                    world.velocities[b] -= imp_n * c.inv_m_b;
                    if !c.lock_rot_b {
                        world.angular_velocities[b] -= c.inv_i_b * c.rb.cross(imp_n);
                    }
                }
            }
        }

        if iter < 3 {
            return;
        }

        // Static-then-kinetic 3D Coulomb friction cone
        for step_i in 0..len {
            let i = if reverse { len - 1 - step_i } else { step_i };
            let c = &mut self.manifolds[i];
            if !c.allow_friction || c.acc_n <= 0.0 {
                continue;
            }
            let a = c.a;
            let b = c.b;
            let va = world.velocities[a] + world.angular_velocities[a].cross(c.ra);
            let vb = if c.is_dynamic_b {
                world.velocities[b] + world.angular_velocities[b].cross(c.rb)
            } else {
                Vec3::ZERO
            };
            let v_rel = va - vb;
            let mut new_t1 = c.acc_t1 - v_rel.dot(c.t1) * c.eff_mass_t1;
            let mut new_t2 = c.acc_t2 - v_rel.dot(c.t2) * c.eff_mass_t2;

            let max_static = c.static_friction * c.acc_n;
            let max_kinetic = c.friction * c.acc_n;
            let f_sq = new_t1 * new_t1 + new_t2 * new_t2;
            let tang_speed_sq = {
                let vt1 = v_rel.dot(c.t1);
                let vt2 = v_rel.dot(c.t2);
                vt1 * vt1 + vt2 * vt2
            };
            let limit = if tang_speed_sq < 0.04 && f_sq <= max_static * max_static {
                max_static
            } else {
                max_kinetic
            };
            if f_sq > limit * limit {
                let s = limit / f_sq.sqrt().max(1e-8);
                new_t1 *= s;
                new_t2 *= s;
            }
            let djt1 = new_t1 - c.acc_t1;
            let djt2 = new_t2 - c.acc_t2;
            c.acc_t1 = new_t1;
            c.acc_t2 = new_t2;

            if djt1.abs() > 1e-8 || djt2.abs() > 1e-8 {
                let imp_t = c.t1 * djt1 + c.t2 * djt2;
                world.velocities[a] += imp_t * c.inv_m_a;
                if !c.lock_rot_a {
                    world.angular_velocities[a] += c.inv_i_a * c.ra.cross(imp_t);
                }
                if c.is_dynamic_b {
                    world.velocities[b] -= imp_t * c.inv_m_b;
                    if !c.lock_rot_b {
                        world.angular_velocities[b] -= c.inv_i_b * c.rb.cross(imp_t);
                    }
                }
            }
        }

        if iter + 2 == self.config.solver_iterations {
            for c in &self.manifolds {
                if !c.allow_friction || c.acc_n <= 0.0 {
                    continue;
                }
                let a = c.a;
                let b = c.b;
                let w_a = if c.lock_rot_a { Vec3::ZERO } else { world.angular_velocities[a] };
                let w_b = if c.is_dynamic_b && !c.lock_rot_b {
                    world.angular_velocities[b]
                } else {
                    Vec3::ZERO
                };
                let w_rel = w_a - w_b;
                let w_len = w_rel.length();
                if w_len <= 1e-5 {
                    continue;
                }
                let is_curved = matches!(
                    world.colliders_3d[a],
                    Some(Collider3D::Sphere { .. } | Collider3D::Capsule { .. } | Collider3D::Cylinder { .. })
                ) || (c.is_dynamic_b
                    && matches!(
                        world.colliders_3d[b],
                        Some(Collider3D::Sphere { .. } | Collider3D::Capsule { .. } | Collider3D::Cylinder { .. })
                    ));
                let roll_coeff = if is_curved { 0.032 } else { 0.014 };
                let r_eff = c.ra.length().max(0.25);
                let max_tau_imp = roll_coeff * c.friction.max(0.15) * c.acc_n * r_eff;
                let max_inv_i = (c.inv_i_a.x_axis.x.abs()
                    .max(c.inv_i_a.y_axis.y.abs())
                    .max(c.inv_i_a.z_axis.z.abs()))
                    + (c.inv_i_b.x_axis.x.abs()
                        .max(c.inv_i_b.y_axis.y.abs())
                        .max(c.inv_i_b.z_axis.z.abs()));
                if max_inv_i <= 1e-8 {
                    continue;
                }
                let eff_ang_mass = 1.0 / max_inv_i;
                let imp_mag = max_tau_imp.min(w_len * eff_ang_mass);
                let ang_imp = (w_rel / w_len) * imp_mag;
                if !c.lock_rot_a {
                    world.angular_velocities[a] -= c.inv_i_a * ang_imp;
                }
                if c.is_dynamic_b && !c.lock_rot_b {
                    world.angular_velocities[b] += c.inv_i_b * ang_imp;
                }
            }
        }
    }

    fn solve_3d_position_constraints(&self, world: &mut World) {
        const POS_SLOP: f32 = 0.0015;
        const DYN_ERP: f32 = 0.58;
        const STAT_ERP: f32 = 0.88;
        const MAX_CORR: f32 = 0.16;

        for _ in 0..5 {
            for c in &self.manifolds {
                if c.is_dynamic_b {
                    continue;
                }
                let sep_a = world.curr_pos[c.a] - c.init_pos_a;
                let rem = c.depth - sep_a.dot(c.normal) - POS_SLOP;
                if rem <= 0.0 {
                    continue;
                }
                let corr = (rem * STAT_ERP).min(MAX_CORR);
                if c.steep_for_a {
                    // Push CharacterController horizontally away from steep edges instead of hoisting upward
                    let horiz = Vec3::new(c.normal.x, 0.0, c.normal.z).normalize_or_zero();
                    if horiz.length_squared() > 0.1 {
                        world.curr_pos[c.a] += horiz * corr;
                        continue;
                    }
                }
                let horiz_speed_sq =
                    Vec3::new(world.velocities[c.a].x, 0.0, world.velocities[c.a].z).length_squared();
                if c.allow_friction
                    && c.friction > 0.25
                    && c.normal.y > 0.85
                    && horiz_speed_sq < 0.04
                {
                    world.curr_pos[c.a].y += corr / c.normal.y;
                } else {
                    world.curr_pos[c.a] += c.normal * corr;
                }
            }
            for c in &self.manifolds {
                if !c.is_dynamic_b {
                    continue;
                }
                let sep_a = world.curr_pos[c.a] - c.init_pos_a;
                let sep_b = world.curr_pos[c.b] - c.init_pos_b;
                let rem = c.depth - (sep_a - sep_b).dot(c.normal) - POS_SLOP;
                if rem <= 0.0 {
                    continue;
                }
                let corr = (rem * DYN_ERP).min(MAX_CORR);
                if c.steep_for_a {
                    let horiz = Vec3::new(c.normal.x, 0.0, c.normal.z).normalize_or_zero();
                    let total_w = (c.inv_m_a + c.inv_m_b).max(1e-6);
                    if horiz.length_squared() > 0.1 {
                        world.curr_pos[c.a] += horiz * (corr * (c.inv_m_a / total_w));
                        world.curr_pos[c.b] -= horiz * (corr * (c.inv_m_b / total_w));
                        continue;
                    }
                }
                let (w_a, w_b) = if c.normal.y < -0.6 && world.rigid_bodies[c.a].map_or(false, |r| r.grounded) {
                    (0.12 * c.inv_m_a, c.inv_m_b)
                } else if c.normal.y > 0.6 && world.rigid_bodies[c.b].map_or(false, |r| r.grounded) {
                    (c.inv_m_a, 0.12 * c.inv_m_b)
                } else {
                    (c.inv_m_a, c.inv_m_b)
                };
                let total_w = (w_a + w_b).max(1e-6);
                let rel_v = world.velocities[c.a] - world.velocities[c.b];
                let horiz_rel_sq = rel_v.x * rel_v.x + rel_v.z * rel_v.z;
                if c.allow_friction
                    && c.friction > 0.25
                    && c.normal.y.abs() > 0.85
                    && horiz_rel_sq < 0.04
                {
                    let dy = (corr / c.normal.y.abs()) * c.normal.y.signum();
                    world.curr_pos[c.a].y += dy * (w_a / total_w);
                    world.curr_pos[c.b].y -= dy * (w_b / total_w);
                } else {
                    world.curr_pos[c.a] += c.normal * (corr * (w_a / total_w));
                    world.curr_pos[c.b] -= c.normal * (corr * (w_b / total_w));
                }
            }
        }
    }

    fn ground_snap_controllers(&mut self, world: &mut World) {
        let len = self.character_controllers.len().min(world.alive.len());
        for i in 0..len {
            let Some(ctrl) = self.character_controllers[i] else {
                continue;
            };
            if ctrl.ground_snap <= 1e-4 || !self.was_grounded.get(i).copied().unwrap_or(false) {
                continue;
            }
            if !world.alive[i] || world.velocities[i].y > 0.5 {
                continue;
            }
            let Some(rb) = world.rigid_bodies[i] else {
                continue;
            };
            if rb.grounded || rb.is_trigger {
                continue;
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let pos_a = world.curr_pos[i];
            let rot_a = world.curr_rot[i];
            let probe_pos = pos_a - Vec3::Y * ctrl.ground_snap;
            let mut probe = [ContactPoint::default(); 16];
            let count = self.gather_static_contacts(
                world,
                i,
                col,
                probe_pos,
                rot_a,
                rb,
                ctrl.max_slope_cos,
                false,
                INVALID_ENTITY,
                &mut probe,
            );
            let mut best_lift: Option<f32> = None;
            for c in &probe[..count] {
                if c.normal.y >= ctrl.max_slope_cos && is_bottom_support(col, probe_pos, rot_a, c.point) {
                    let lift = (c.depth - 0.002).max(0.0);
                    if lift <= ctrl.ground_snap {
                        best_lift = Some(best_lift.map_or(lift, |b| b.max(lift)));
                    }
                }
            }
            if let Some(lift) = best_lift {
                world.curr_pos[i].y = probe_pos.y + lift;
                world.velocities[i].y = world.velocities[i].y.max(-0.5);
                if let Some(r) = &mut world.rigid_bodies[i] {
                    r.grounded = true;
                }
            }
        }
    }

    fn update_sleeping_islands(&mut self, world: &mut World, dt: f32) {
        let count = world.alive.len();
        if self.island_parent.len() < count {
            self.island_parent.resize(count, 0);
            self.island_all_calm.resize(count, true);
            self.island_has_contact.resize(count, false);
        }
        for i in 0..count {
            self.island_parent[i] = i;
            self.island_all_calm[i] = true;
            self.island_has_contact[i] = false;
        }
        let find_root = |parent: &mut [usize], mut x: usize| -> usize {
            while parent[x] != x {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            x
        };
        let unite = |parent: &mut [usize], a: usize, b: usize| {
            let mut ra = a;
            while parent[ra] != ra {
                parent[ra] = parent[parent[ra]];
                ra = parent[ra];
            }
            let mut rb = b;
            while parent[rb] != rb {
                parent[rb] = parent[parent[rb]];
                rb = parent[rb];
            }
            if ra != rb {
                if ra < rb {
                    parent[rb] = ra;
                } else {
                    parent[ra] = rb;
                }
            }
        };

        for c in &self.manifolds {
            self.island_has_contact[c.a] = true;
            if c.is_dynamic_b {
                self.island_has_contact[c.b] = true;
                unite(&mut self.island_parent, c.a, c.b);
            }
        }
        for c in &self.manifolds {
            if c.depth > 0.008 {
                let root = find_root(&mut self.island_parent, c.a);
                self.island_all_calm[root] = false;
            }
        }

        // Mark calm status per awake body, and aggregate onto island roots
        for &i in &self.awake_indices {
            let mut v_sq = world.velocities[i].length_squared();
            let mut w_sq = world.angular_velocities[i].length_squared();
            let supported = self.island_has_contact[i]
                || world.rigid_bodies[i].map_or(false, |rb| rb.grounded);
            if supported && v_sq < 0.004 && w_sq < 0.006 {
                world.velocities[i] *= 0.72;
                world.angular_velocities[i] *= 0.68;
                v_sq = world.velocities[i].length_squared();
                w_sq = world.angular_velocities[i].length_squared();
            }
            let calm = world.rigid_bodies[i].map_or(false, |rb| {
                rb.can_sleep && !rb.is_trigger && supported && v_sq < 0.025 && w_sq < 0.035
            });
            if !calm {
                let root = find_root(&mut self.island_parent, i);
                self.island_all_calm[root] = false;
            }
        }

        for &i in &self.awake_indices {
            let root = find_root(&mut self.island_parent, i);
            let island_calm = self.island_all_calm[root];
            let supported = self.island_has_contact[i]
                || world.rigid_bodies[i].map_or(false, |rb| rb.grounded);
            if let Some(rb) = &mut world.rigid_bodies[i] {
                if island_calm && rb.can_sleep && !rb.is_trigger && supported {
                    rb.sleep_timer += dt;
                    if rb.sleep_timer >= 0.40 {
                        rb.sleeping = true;
                        world.velocities[i] = Vec3::ZERO;
                        world.angular_velocities[i] = Vec3::ZERO;
                    }
                } else {
                    rb.sleep_timer = 0.0;
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

    fn lookup_pair_details(&self, a: EntityHandle, b: EntityHandle) -> (Vec3, Vec3, f32) {
        let pos = self.pair_impulses.partition_point(|x| (x.0, x.1) < (a, b));
        let mut max_imp = 0.0f32;
        let mut best_n = Vec3::Y;
        let mut best_pt = Vec3::ZERO;
        for row in &self.pair_impulses[pos..] {
            if row.0 != a || row.1 != b {
                break;
            }
            if row.4 >= max_imp {
                max_imp = row.4;
                best_n = row.2;
                best_pt = row.3;
            }
        }
        (best_n, best_pt, max_imp)
    }

    fn emit_overlap_events(&mut self) {
        self.curr_overlaps.sort_unstable();
        self.curr_overlaps.dedup();

        // Enter & Stay events
        for idx in 0..self.curr_overlaps.len() {
            let cur = self.curr_overlaps[idx];
            let existed = self
                .prev_overlaps
                .binary_search_by(|p| (p.a, p.b).cmp(&(cur.a, cur.b)))
                .is_ok();
            let (normal, contact_point, impulse) = self.lookup_pair_details(cur.a, cur.b);
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
                    normal,
                    contact_point,
                    impulse,
                });
            } else {
                let kind = if cur.is_trigger {
                    EVENT_TRIGGER_STAY
                } else {
                    EVENT_COLLISION_STAY
                };
                self.push_rich_event(PhysicsEvent {
                    kind,
                    entity_a: cur.a,
                    entity_b: cur.b,
                    normal,
                    contact_point,
                    impulse,
                });
            }
        }

        // Exit events
        for idx in 0..self.prev_overlaps.len() {
            let prev = self.prev_overlaps[idx];
            let still_here = self
                .curr_overlaps
                .binary_search_by(|p| (p.a, p.b).cmp(&(prev.a, prev.b)))
                .is_ok();
            if !still_here {
                if prev.is_trigger {
                    self.push_event(PhysicsEvent {
                        kind: EVENT_TRIGGER_EXIT,
                        entity_a: prev.a,
                        entity_b: prev.b,
                        normal: Vec3::ZERO,
                        contact_point: Vec3::ZERO,
                        impulse: 0.0,
                    });
                } else {
                    self.push_rich_event(PhysicsEvent {
                        kind: EVENT_COLLISION_EXIT,
                        entity_a: prev.a,
                        entity_b: prev.b,
                        normal: Vec3::ZERO,
                        contact_point: Vec3::ZERO,
                        impulse: 0.0,
                    });
                }
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
        self.push_rich_event(ev);
    }

    fn push_rich_event(&mut self, ev: PhysicsEvent) {
        self.rich_event_words.extend_from_slice(&[
            ev.kind,
            ev.entity_a,
            ev.entity_b,
            ev.normal.x.to_bits(),
            ev.normal.y.to_bits(),
            ev.normal.z.to_bits(),
            ev.contact_point.x.to_bits(),
            ev.contact_point.y.to_bits(),
            ev.contact_point.z.to_bits(),
            ev.impulse.to_bits(),
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
        let (_, _, ang_a) = world.curr_rot[dyn_idx].to_euler(glam::EulerRot::XYZ);

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
            let (_, _, ang_b) = world.curr_rot[stat_idx].to_euler(glam::EulerRot::XYZ);
            if let Some((normal, depth)) = intersect_2d_rotated(col, p2, ang_a, stat_col, sp, ang_b) {
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
                    Collider2D::Aabb2D { half_extents } => half_extents.length(),
                    Collider2D::Capsule2D { radius, half_height } => radius + half_height,
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
                        if let Some((normal, depth)) = intersect_2d_rotated(
                            col,
                            p2,
                            ang_a,
                            Collider2D::Aabb2D {
                                half_extents: half_tile,
                            },
                            tile_center,
                            0.0,
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
        let restitution = rb_a.map_or(0.0, |r| r.restitution);
        let friction = rb_a.map_or(0.0, |r| r.friction);
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
                let bounce = if vn < -1.0 { restitution * (-vn) } else { 0.0 };
                vel.x -= c.normal.x * (vn - bounce);
                vel.y -= c.normal.y * (vn - bounce);
                // Simple 2D tangential friction
                let tx = -c.normal.y;
                let ty = c.normal.x;
                let vt = vel.x * tx + vel.y * ty;
                let dampen = (vt.abs().min(friction * (-vn) * 0.5)).copysign(vt);
                vel.x -= tx * dampen;
                vel.y -= ty * dampen;
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

    fn ray_single_collider(
        &self,
        col: Collider3D,
        pos: Vec3,
        rot: Quat,
        origin: Vec3,
        d: Vec3,
        r_pad: f32,
    ) -> Option<(f32, Vec3)> {
        match col {
            Collider3D::Aabb { half_extents } => {
                ray_obb(origin, d, pos, rot, half_extents + Vec3::splat(r_pad))
            }
            Collider3D::Sphere { radius } => ray_sphere(origin, d, pos, radius + r_pad),
            Collider3D::Capsule { radius, half_height } => {
                ray_capsule(origin, d, pos, rot, radius + r_pad, half_height)
            }
            Collider3D::Cylinder { radius, half_height } => {
                ray_cylinder(origin, d, pos, rot, radius + r_pad, half_height + r_pad)
            }
            Collider3D::ConvexHull { bounding_radius, .. } => {
                ray_sphere(origin, d, pos, bounding_radius + r_pad)
            }
            Collider3D::Compound { compound_id, .. } => {
                let comp = self.compound_shapes.get(compound_id as usize)?;
                let mut best: Option<(f32, Vec3)> = None;
                for ch in &comp.children {
                    let wp = pos + rot * ch.local_pos;
                    let wr = (rot * ch.local_rot).normalize();
                    if let Some((t, n)) = self.ray_single_collider(ch.collider, wp, wr, origin, d, r_pad) {
                        if best.map_or(true, |(bt, _)| t < bt) {
                            best = Some((t, n));
                        }
                    }
                }
                best
            }
        }
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
            let hit = self.ray_single_collider(col, pos, rot, origin, d, r_pad);
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

    pub fn overlap_shape(
        &mut self,
        world: &World,
        shape: Collider3D,
        pos: Vec3,
        rot: Quat,
        mask: u32,
        include_triggers: bool,
    ) -> &[EntityHandle] {
        self.overlap_results.clear();
        let mut tmp = [ContactPoint::default(); 2];
        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            if let Some(rb) = world.rigid_bodies[i] {
                if (!include_triggers && rb.is_trigger) || (rb.layer & mask) == 0 {
                    continue;
                }
            } else if (1 & mask) == 0 {
                continue;
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let mut cnt = 0usize;
            collect_3d_contacts_with_shapes(
                shape,
                pos,
                rot,
                col,
                world.curr_pos[i],
                world.curr_rot[i],
                Some(i),
                false,
                &self.convex_hulls,
                &self.compound_shapes,
                &mut tmp,
                &mut cnt,
            );
            if cnt > 0 {
                self.overlap_results.push(make_handle(world, i));
            }
        }
        &self.overlap_results
    }

    #[allow(clippy::too_many_arguments)]
    pub fn sweep_shape(
        &self,
        world: &World,
        shape: Collider3D,
        origin: Vec3,
        rot: Quat,
        dir: Vec3,
        max_dist: f32,
        mask: u32,
        ignore_entity: EntityHandle,
    ) -> Option<RayHit> {
        let len = dir.length();
        if len < 1e-6 {
            return None;
        }
        let d = dir / len;
        let minor = collider_minor_extent(shape).max(0.05);
        let step_size = (minor * 0.35).clamp(0.03, 0.25);
        let steps = ((max_dist / step_size).ceil() as usize).clamp(1, 256);
        let mut tmp = [ContactPoint::default(); 4];

        for s in 0..=steps {
            let t = (s as f32 / steps as f32) * max_dist;
            let p = origin + d * t;
            for (i, &alive) in world.alive.iter().enumerate() {
                if !alive {
                    continue;
                }
                let h = make_handle(world, i);
                if h == ignore_entity {
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
                let mut cnt = 0usize;
                collect_3d_contacts_with_shapes(
                    shape,
                    p,
                    rot,
                    col,
                    world.curr_pos[i],
                    world.curr_rot[i],
                    Some(i),
                    false,
                    &self.convex_hulls,
                    &self.compound_shapes,
                    &mut tmp,
                    &mut cnt,
                );
                if cnt > 0 {
                    return Some(RayHit {
                        entity: h,
                        distance: t,
                        point: tmp[0].point,
                        normal: tmp[0].normal,
                    });
                }
            }
        }
        None
    }

    /// Packs `[x0,y0,z0, x1,y1,z1, r,g,b,a]` wireframe segments for colliders, COMs, contacts & water zones.
    pub fn build_debug_lines(&mut self, world: &World) -> &[f32] {
        self.debug_lines.clear();
        let mut push_seg = |a: Vec3, b: Vec3, col: [f32; 4]| {
            self.debug_lines.extend_from_slice(&[
                a.x, a.y, a.z, b.x, b.y, b.z, col[0], col[1], col[2], col[3],
            ]);
        };

        let draw_box = |push: &mut dyn FnMut(Vec3, Vec3, [f32; 4]), pos: Vec3, rot: Quat, h: Vec3, col: [f32; 4]| {
            let c = obb_corners(pos, rot, h);
            let edges = [
                (0, 1), (1, 3), (3, 2), (2, 0),
                (4, 5), (5, 7), (7, 6), (6, 4),
                (0, 4), (1, 5), (2, 6), (3, 7),
            ];
            for &(i0, i1) in &edges {
                push(c[i0], c[i1], col);
            }
        };

        let draw_ring = |push: &mut dyn FnMut(Vec3, Vec3, [f32; 4]), center: Vec3, u: Vec3, v: Vec3, r: f32, col: [f32; 4]| {
            const SEGS: usize = 14;
            let step = std::f32::consts::TAU / SEGS as f32;
            for k in 0..SEGS {
                let a0 = k as f32 * step;
                let a1 = (k + 1) as f32 * step;
                let p0 = center + u * (a0.cos() * r) + v * (a0.sin() * r);
                let p1 = center + u * (a1.cos() * r) + v * (a1.sin() * r);
                push(p0, p1, col);
            }
        };

        let draw_shape = |push: &mut dyn FnMut(Vec3, Vec3, [f32; 4]), shape: Collider3D, pos: Vec3, rot: Quat, col: [f32; 4], hulls: &[ConvexHullShape], comps: &[CompoundShape]| {
            match shape {
                Collider3D::Aabb { half_extents } => draw_box(push, pos, rot, half_extents, col),
                Collider3D::Sphere { radius } => {
                    let ax = rot * Vec3::X;
                    let ay = rot * Vec3::Y;
                    let az = rot * Vec3::Z;
                    draw_ring(push, pos, ax, ay, radius, col);
                    draw_ring(push, pos, ax, az, radius, col);
                    draw_ring(push, pos, ay, az, radius, col);
                }
                Collider3D::Capsule { radius, half_height } => {
                    let ax = rot * Vec3::X;
                    let ay = rot * Vec3::Y;
                    let az = rot * Vec3::Z;
                    let top = pos + ay * half_height;
                    let bot = pos - ay * half_height;
                    draw_ring(push, top, ax, az, radius, col);
                    draw_ring(push, bot, ax, az, radius, col);
                    draw_ring(push, pos, ax, ay, radius, col);
                    draw_ring(push, pos, az, ay, radius, col);
                    push(bot + ax * radius, top + ax * radius, col);
                    push(bot - ax * radius, top - ax * radius, col);
                    push(bot + az * radius, top + az * radius, col);
                    push(bot - az * radius, top - az * radius, col);
                }
                Collider3D::Cylinder { radius, half_height } => {
                    let ax = rot * Vec3::X;
                    let ay = rot * Vec3::Y;
                    let az = rot * Vec3::Z;
                    let top = pos + ay * half_height;
                    let bot = pos - ay * half_height;
                    draw_ring(push, top, ax, az, radius, col);
                    draw_ring(push, bot, ax, az, radius, col);
                    push(bot + ax * radius, top + ax * radius, col);
                    push(bot - ax * radius, top - ax * radius, col);
                    push(bot + az * radius, top + az * radius, col);
                    push(bot - az * radius, top - az * radius, col);
                }
                Collider3D::ConvexHull { hull_id, bounding_radius } => {
                    if let Some(h) = hulls.get(hull_id as usize) {
                        for k in 0..h.vertices.len().min(32) {
                            let v0 = pos + rot * h.vertices[k];
                            let v1 = pos + rot * h.vertices[(k + 1) % h.vertices.len()];
                            push(v0, v1, col);
                        }
                    } else {
                        draw_ring(push, pos, Vec3::X, Vec3::Z, bounding_radius, col);
                    }
                }
                Collider3D::Compound { compound_id, .. } => {
                    if let Some(c) = comps.get(compound_id as usize) {
                        for ch in &c.children {
                            let cp = pos + rot * ch.local_pos;
                            let cr = (rot * ch.local_rot).normalize();
                            match ch.collider {
                                Collider3D::Aabb { half_extents } => draw_box(push, cp, cr, half_extents, col),
                                Collider3D::Sphere { radius } => {
                                    draw_ring(push, cp, cr * Vec3::X, cr * Vec3::Z, radius, col);
                                    draw_ring(push, cp, cr * Vec3::X, cr * Vec3::Y, radius, col);
                                }
                                _ => draw_ring(push, cp, Vec3::X, Vec3::Z, collider3d_bounding_radius(ch.collider), col),
                            }
                        }
                    }
                }
            }
        };

        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            let Some(col) = world.colliders_3d[i] else {
                continue;
            };
            let rb = world.rigid_bodies[i];
            let color = match rb {
                Some(r) if r.is_trigger => [1.0, 0.55, 0.1, 0.9],
                Some(r) if !r.dynamic => [0.22, 0.9, 0.4, 0.75],
                Some(r) if r.sleeping => [0.3, 0.62, 1.0, 0.85],
                Some(_) => [1.0, 0.92, 0.25, 0.95],
                None => [0.22, 0.9, 0.4, 0.75],
            };
            draw_shape(
                &mut push_seg,
                col,
                world.curr_pos[i],
                world.curr_rot[i],
                color,
                &self.convex_hulls,
                &self.compound_shapes,
            );
            if let Some(r) = rb {
                if r.dynamic && r.center_of_mass.length_squared() > 1e-4 {
                    let com = world.curr_pos[i] + world.curr_rot[i] * r.center_of_mass;
                    push_seg(com - Vec3::X * 0.18, com + Vec3::X * 0.18, [1.0, 0.2, 0.9, 1.0]);
                    push_seg(com - Vec3::Y * 0.18, com + Vec3::Y * 0.18, [1.0, 0.2, 0.9, 1.0]);
                    push_seg(com - Vec3::Z * 0.18, com + Vec3::Z * 0.18, [1.0, 0.2, 0.9, 1.0]);
                }
            }
        }

        // Water zones in cyan
        for wz in &self.water_zones {
            draw_box(&mut push_seg, wz.center, wz.rot, wz.half_extents, [0.15, 0.85, 1.0, 0.9]);
        }

        // Active contact points & normals in bright red/orange
        for m in &self.manifolds {
            push_seg(m.point, m.point + m.normal * (0.28 + m.acc_n * 0.02).min(0.8), [1.0, 0.22, 0.22, 1.0]);
        }

        &self.debug_lines
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
fn layers_match(a: Option<RigidBody>, b: Option<RigidBody>) -> bool {
    let (la, ma) = a.map_or((1, u32::MAX), |r| (r.layer, r.mask));
    let (lb, mb) = b.map_or((1, u32::MAX), |r| (r.layer, r.mask));
    (la & mb) != 0 && (lb & ma) != 0
}

#[inline]
fn effective_static_friction(rb: RigidBody) -> f32 {
    if rb.static_friction >= 0.0 {
        rb.static_friction
    } else {
        rb.friction.max(0.0) * 1.18
    }
}

#[inline]
fn combine_val(a: f32, b: f32, mode: u8, default_geom: bool) -> f32 {
    match mode {
        1 => 0.5 * (a + b),
        2 => a.min(b),
        3 => a.max(b),
        4 => a * b,
        _ => {
            if default_geom {
                (a.max(0.0) * b.max(0.0)).sqrt()
            } else {
                a.max(b)
            }
        }
    }
}

#[inline]
fn combine_materials(a: RigidBody, b: RigidBody) -> (f32, f32, f32, f32) {
    let f_mode = a.friction_combine.max(b.friction_combine);
    let r_mode = a.restitution_combine.max(b.restitution_combine);
    let fric = combine_val(a.friction.max(0.0), b.friction.max(0.0), f_mode, true);
    let sfric = combine_val(
        effective_static_friction(a),
        effective_static_friction(b),
        f_mode,
        true,
    )
    .max(fric);
    let rest = combine_val(a.restitution, b.restitution, r_mode, false);
    let thresh = a.restitution_threshold.min(b.restitution_threshold).max(0.15);
    (fric, sfric, rest, thresh)
}

#[inline]
fn is_bottom_support(col: Collider3D, pos: Vec3, rot: Quat, contact_pt: Vec3) -> bool {
    let up = rot * Vec3::Y;
    match col {
        Collider3D::Capsule { radius, half_height } => {
            let bot_center = pos - up * half_height;
            (contact_pt - bot_center).dot(up) <= radius * 0.45
        }
        Collider3D::Sphere { radius } => (contact_pt.y - pos.y) <= -radius * 0.25,
        Collider3D::Cylinder { half_height, .. } => {
            (contact_pt - pos).dot(up) <= -half_height * 0.45
        }
        Collider3D::Aabb { half_extents } => (contact_pt.y - pos.y) <= -half_extents.y * 0.3,
        Collider3D::ConvexHull { bounding_radius, .. }
        | Collider3D::Compound { bounding_radius, .. } => {
            (contact_pt.y - pos.y) <= -bounding_radius * 0.15
        }
    }
}

#[inline]
fn collider_minor_extent(col: Collider3D) -> f32 {
    match col {
        Collider3D::Sphere { radius } => radius,
        Collider3D::Capsule { radius, .. } => radius,
        Collider3D::Cylinder { radius, half_height } => radius.min(half_height),
        Collider3D::Aabb { half_extents } => half_extents.x.min(half_extents.y).min(half_extents.z),
        Collider3D::ConvexHull { bounding_radius, .. }
        | Collider3D::Compound { bounding_radius, .. } => bounding_radius * 0.5,
    }
}

#[inline]
fn primitive_volume(col: Collider3D, hulls: &[ConvexHullShape]) -> f32 {
    match col {
        Collider3D::Aabb { half_extents: h } => 8.0 * h.x.max(0.01) * h.y.max(0.01) * h.z.max(0.01),
        Collider3D::Sphere { radius: r } => (4.0 / 3.0) * std::f32::consts::PI * r * r * r,
        Collider3D::Capsule { radius: r, half_height: hh } => {
            std::f32::consts::PI * r * r * (2.0 * hh + (4.0 / 3.0) * r)
        }
        Collider3D::Cylinder { radius: r, half_height: hh } => {
            std::f32::consts::PI * r * r * (2.0 * hh)
        }
        Collider3D::ConvexHull { hull_id, .. } => {
            hulls.get(hull_id as usize).map_or(1.0, |h| h.volume)
        }
        Collider3D::Compound { bounding_radius, .. } => {
            (4.0 / 3.0) * std::f32::consts::PI * bounding_radius.powi(3) * 0.5
        }
    }
}

#[inline]
fn primitive_local_inertia_diag(col: Option<Collider3D>, mass: f32) -> Vec3 {
    let m = mass.max(0.01);
    match col {
        Some(Collider3D::Aabb { half_extents: h }) => Vec3::new(
            (m * (h.y * h.y + h.z * h.z) / 3.0).max(0.005),
            (m * (h.x * h.x + h.z * h.z) / 3.0).max(0.005),
            (m * (h.x * h.x + h.y * h.y) / 3.0).max(0.005),
        ),
        Some(Collider3D::Sphere { radius }) => Vec3::splat((0.4 * m * radius * radius).max(0.005)),
        Some(Collider3D::Capsule { radius: r, half_height: hh }) => {
            let cyl_h = (2.0 * hh).max(0.001);
            let total = cyl_h + (4.0 / 3.0) * r;
            let mc = m * (cyl_h / total);
            let ms = m - mc;
            let iy = (0.5 * mc * r * r + 0.4 * ms * r * r).max(0.005);
            let ix = (mc * (cyl_h * cyl_h / 12.0 + 0.25 * r * r)
                + ms * (0.4 * r * r + (hh + 0.375 * r).powi(2)))
            .max(0.005);
            Vec3::new(ix, iy, ix)
        }
        Some(Collider3D::Cylinder { radius: r, half_height: hh }) => {
            let iy = (0.5 * m * r * r).max(0.005);
            let ix = (m * (3.0 * r * r + 4.0 * hh * hh) / 12.0).max(0.005);
            Vec3::new(ix, iy, ix)
        }
        Some(Collider3D::ConvexHull { bounding_radius: r, .. }) => {
            Vec3::splat((0.35 * m * r * r).max(0.005))
        }
        _ => Vec3::splat((0.5 * m).max(0.01)),
    }
}

#[inline]
fn collider_world_aabb(
    col: Collider3D,
    pos: Vec3,
    rot: Quat,
    hulls: &[ConvexHullShape],
    _compounds: &[CompoundShape],
) -> (Vec3, Vec3) {
    match col {
        Collider3D::Aabb { half_extents: h } => {
            let m = Mat3::from_quat(rot);
            let ext = Vec3::new(
                m.x_axis.x.abs() * h.x + m.y_axis.x.abs() * h.y + m.z_axis.x.abs() * h.z,
                m.x_axis.y.abs() * h.x + m.y_axis.y.abs() * h.y + m.z_axis.y.abs() * h.z,
                m.x_axis.z.abs() * h.x + m.y_axis.z.abs() * h.y + m.z_axis.z.abs() * h.z,
            );
            (pos - ext, pos + ext)
        }
        Collider3D::Sphere { radius } => (pos - Vec3::splat(radius), pos + Vec3::splat(radius)),
        Collider3D::Capsule { radius, half_height } => {
            let axis = (rot * Vec3::Y).abs() * half_height + Vec3::splat(radius);
            (pos - axis, pos + axis)
        }
        Collider3D::Cylinder { radius, half_height } => {
            let axis = (rot * Vec3::Y).abs();
            let sq = (Vec3::ONE - axis * axis).max(Vec3::ZERO);
            let rad_proj = Vec3::new(sq.x.sqrt(), sq.y.sqrt(), sq.z.sqrt()) * radius;
            let ext = axis * half_height + rad_proj;
            (pos - ext, pos + ext)
        }
        Collider3D::ConvexHull { hull_id, bounding_radius } => {
            if let Some(h) = hulls.get(hull_id as usize) {
                let mut bmin = Vec3::splat(f32::INFINITY);
                let mut bmax = Vec3::splat(f32::NEG_INFINITY);
                for &v in &h.vertices {
                    let wv = pos + rot * v;
                    bmin = bmin.min(wv);
                    bmax = bmax.max(wv);
                }
                (bmin, bmax)
            } else {
                (pos - Vec3::splat(bounding_radius), pos + Vec3::splat(bounding_radius))
            }
        }
        Collider3D::Compound { bounding_radius, .. } => (
            pos - Vec3::splat(bounding_radius),
            pos + Vec3::splat(bounding_radius),
        ),
    }
}

#[inline]
fn collider3d_bounding_radius(col: Collider3D) -> f32 {
    match col {
        Collider3D::Sphere { radius } => radius,
        Collider3D::Capsule { radius, half_height } => radius + half_height,
        Collider3D::Cylinder { radius, half_height } => (radius * radius + half_height * half_height).sqrt(),
        Collider3D::Aabb { half_extents } => half_extents.length(),
        Collider3D::ConvexHull { bounding_radius, .. }
        | Collider3D::Compound { bounding_radius, .. } => bounding_radius,
    }
}

#[inline]
fn push_contact(
    contacts: &mut [ContactPoint],
    count: &mut usize,
    other_idx: Option<usize>,
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
            other_idx,
        };
        *count += 1;
    }
}

#[inline]
fn push_manifold_point_dedup(
    contacts: &mut [ContactPoint],
    count: &mut usize,
    start_count: usize,
    other_idx: Option<usize>,
    point: Vec3,
    normal: Vec3,
    depth: f32,
) {
    if depth <= 0.0 {
        return;
    }
    for existing in &mut contacts[start_count..*count] {
        if existing.point.distance_squared(point) < 0.0004 {
            if depth > existing.depth {
                existing.depth = depth;
                existing.point = point;
            }
            return;
        }
    }
    if *count < contacts.len() {
        contacts[*count] = ContactPoint {
            point,
            normal,
            depth,
            other_idx,
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
fn to_support<'a>(
    col: Collider3D,
    pos: Vec3,
    rot: Quat,
    hulls: &'a [ConvexHullShape],
) -> Option<SupportShape<'a>> {
    match col {
        Collider3D::Aabb { half_extents } => Some(SupportShape::Obb { pos, rot, half: half_extents }),
        Collider3D::Sphere { radius } => Some(SupportShape::Sphere { pos, radius }),
        Collider3D::Capsule { radius, half_height } => Some(SupportShape::Capsule { pos, rot, radius, half_height }),
        Collider3D::Cylinder { radius, half_height } => Some(SupportShape::Cylinder { pos, rot, radius, half_height }),
        Collider3D::ConvexHull { hull_id, .. } => {
            hulls.get(hull_id as usize).map(|hull| SupportShape::ConvexHull { pos, rot, hull })
        }
        Collider3D::Compound { .. } => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_3d_contacts_with_shapes(
    a: Collider3D,
    pa: Vec3,
    ra: Quat,
    b: Collider3D,
    pb: Vec3,
    rb: Quat,
    other_idx: Option<usize>,
    other_is_dynamic: bool,
    hulls: &[ConvexHullShape],
    compounds: &[CompoundShape],
    contacts: &mut [ContactPoint],
    count: &mut usize,
) {
    if let Collider3D::Compound { compound_id, .. } = a {
        if let Some(comp) = compounds.get(compound_id as usize) {
            for ch in &comp.children {
                let cp = pa + ra * ch.local_pos;
                let cr = (ra * ch.local_rot).normalize();
                collect_3d_contacts_with_shapes(
                    ch.collider, cp, cr, b, pb, rb, other_idx, other_is_dynamic, hulls, compounds, contacts, count,
                );
            }
        }
        return;
    }
    if let Collider3D::Compound { compound_id, .. } = b {
        if let Some(comp) = compounds.get(compound_id as usize) {
            for ch in &comp.children {
                let cp = pb + rb * ch.local_pos;
                let cr = (rb * ch.local_rot).normalize();
                collect_3d_contacts_with_shapes(
                    a, pa, ra, ch.collider, cp, cr, other_idx, other_is_dynamic, hulls, compounds, contacts, count,
                );
            }
        }
        return;
    }

    match (a, b) {
        (Collider3D::Aabb { half_extents: ha }, Collider3D::Aabb { half_extents: hb }) => {
            obb_vs_obb_sat(pa, ra, ha, pb, rb, hb, other_idx, other_is_dynamic, contacts, count);
        }
        (Collider3D::Sphere { radius }, Collider3D::Aabb { half_extents }) => {
            let local_center = rb.conjugate() * (pa - pb);
            if let Some((ln, depth, local_closest)) = sphere_vs_local_box(local_center, radius, half_extents) {
                push_contact(contacts, count, other_idx, other_is_dynamic, pb + rb * local_closest, rb * ln, depth);
            }
        }
        (Collider3D::Aabb { half_extents }, Collider3D::Sphere { radius }) => {
            let local_center = ra.conjugate() * (pb - pa);
            if let Some((ln, depth, local_closest)) = sphere_vs_local_box(local_center, radius, half_extents) {
                push_contact(contacts, count, other_idx, other_is_dynamic, pa + ra * local_closest, -(ra * ln), depth);
            }
        }
        (Collider3D::Sphere { radius: r1 }, Collider3D::Sphere { radius: r2 }) => {
            if let Some((n, d)) = sphere_vs_sphere(pa, r1, pb, r2) {
                push_contact(contacts, count, other_idx, other_is_dynamic, pb + n * r2, n, d);
            }
        }
        (Collider3D::Capsule { radius, half_height }, Collider3D::Aabb { half_extents }) => {
            if let Some((n, d, pt, _)) = capsule_vs_obb(pa, ra, radius, half_height, pb, rb, half_extents) {
                push_contact(contacts, count, other_idx, other_is_dynamic, pt, n, d);
            }
        }
        (Collider3D::Capsule { radius: r1, half_height: h1 }, Collider3D::Sphere { radius: r2 }) => {
            let axis = ra * Vec3::Y;
            let s0 = pa - axis * h1;
            let s1 = pa + axis * h1;
            let (seg_pt, _) = crate::collision_math::closest_point_on_segment(pb, s0, s1);
            if let Some((n, d)) = sphere_vs_sphere(seg_pt, r1, pb, r2) {
                push_contact(contacts, count, other_idx, other_is_dynamic, pb + n * r2, n, d);
            }
        }
        (Collider3D::Capsule { radius: r1, half_height: h1 }, Collider3D::Capsule { radius: r2, half_height: h2 }) => {
            let a_ax = ra * Vec3::Y;
            let b_ax = rb * Vec3::Y;
            let (c1, c2, _) = closest_segment_segment(
                pa - a_ax * h1,
                pa + a_ax * h1,
                pb - b_ax * h2,
                pb + b_ax * h2,
            );
            if let Some((n, d)) = sphere_vs_sphere(c1, r1, c2, r2) {
                push_contact(contacts, count, other_idx, other_is_dynamic, c2 + n * r2, n, d);
            }
        }
        (Collider3D::Aabb { .. }, Collider3D::Capsule { .. })
        | (Collider3D::Sphere { .. }, Collider3D::Capsule { .. }) => {
            let before = *count;
            collect_3d_contacts_with_shapes(b, pb, rb, a, pa, ra, other_idx, other_is_dynamic, hulls, compounds, contacts, count);
            for c in &mut contacts[before..*count] {
                c.normal = -c.normal;
            }
        }
        _ => {
            // General Cylinder / ConvexHull / mixed pair via GJK + EPA
            if let (Some(sa), Some(sb)) = (to_support(a, pa, ra, hulls), to_support(b, pb, rb, hulls)) {
                if let Some((n, d, pt)) = gjk_epa(&sa, &sb) {
                    push_contact(contacts, count, other_idx, other_is_dynamic, pt, n, d);
                    // Multi-point rim stabilization when a flat cylinder end cap rests against a box/plane
                    if let (Collider3D::Cylinder { radius, half_height }, Collider3D::Aabb { .. }) = (a, b) {
                        let cyl_up = ra * Vec3::Y;
                        if cyl_up.dot(n).abs() > 0.94 {
                            let sign = if cyl_up.dot(n) < 0.0 { 1.0 } else { -1.0 };
                            let cap_c = pa + cyl_up * (half_height * sign);
                            let rx = ra * Vec3::X * (radius * 0.85);
                            let rz = ra * Vec3::Z * (radius * 0.85);
                            for off in [rx, -rx, rz, -rz] {
                                push_contact(contacts, count, other_idx, other_is_dynamic, cap_c + off, n, d);
                            }
                        }
                    } else if let (Collider3D::Aabb { .. }, Collider3D::Cylinder { radius, half_height }) = (a, b) {
                        let cyl_up = rb * Vec3::Y;
                        if cyl_up.dot(n).abs() > 0.94 {
                            let sign = if cyl_up.dot(n) > 0.0 { 1.0 } else { -1.0 };
                            let cap_c = pb + cyl_up * (half_height * sign);
                            let rx = rb * Vec3::X * (radius * 0.85);
                            let rz = rb * Vec3::Z * (radius * 0.85);
                            for off in [rx, -rx, rz, -rz] {
                                push_contact(contacts, count, other_idx, other_is_dynamic, cap_c + off, n, d);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn clip_poly_plane(
    pts: &[Vec3; 16],
    len: usize,
    plane_pt: Vec3,
    plane_n: Vec3,
    out: &mut [Vec3; 16],
) -> usize {
    if len == 0 {
        return 0;
    }
    let mut out_len = 0usize;
    let mut a = pts[len - 1];
    let mut da = (a - plane_pt).dot(plane_n);
    for &b in &pts[..len] {
        let db = (b - plane_pt).dot(plane_n);
        if (da <= 0.0 && db > 0.0) || (da > 0.0 && db <= 0.0) {
            let denom = da - db;
            let t = if denom.abs() > 1e-8 { (da / denom).clamp(0.0, 1.0) } else { 0.5 };
            if out_len < 16 {
                out[out_len] = a + (b - a) * t;
                out_len += 1;
            }
        }
        if db <= 0.0 && out_len < 16 {
            out[out_len] = b;
            out_len += 1;
        }
        a = b;
        da = db;
    }
    out_len
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
    let mut best_is_edge = false;

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
        let score = if is_edge { overlap * 1.05 + 0.001 } else { overlap };
        if score < best_score {
            best_score = score;
            best_depth = overlap;
            best_axis = l;
            best_is_edge = is_edge;
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
    let start_count = *count;

    if !best_is_edge {
        // Choose most aligned face axis among A (facing -normal) and B (facing +normal)
        let ha_arr = [ha.x, ha.y, ha.z];
        let hb_arr = [hb.x, hb.y, hb.z];
        let mut best_align = -1.0f32;
        let mut ref_is_a = false;
        let mut ref_idx = 0usize;
        for i in 0..3 {
            let da = ax[i].dot(normal).abs();
            if da > best_align {
                best_align = da;
                ref_is_a = true;
                ref_idx = i;
            }
            let db = bx[i].dot(normal).abs();
            if db > best_align {
                best_align = db;
                ref_is_a = false;
                ref_idx = i;
            }
        }

        let (ref_pos, ref_axes, ref_h, inc_pos, inc_axes, inc_h, ref_n) = if ref_is_a {
            let dir = if ax[ref_idx].dot(normal) <= 0.0 { ax[ref_idx] } else { -ax[ref_idx] };
            (pa, ax, ha_arr, pb, bx, hb_arr, dir)
        } else {
            let dir = if bx[ref_idx].dot(normal) >= 0.0 { bx[ref_idx] } else { -bx[ref_idx] };
            (pb, bx, hb_arr, pa, ax, ha_arr, dir)
        };

        let ref_center = ref_pos + ref_n * ref_h[ref_idx];
        let u_idx = (ref_idx + 1) % 3;
        let v_idx = (ref_idx + 2) % 3;
        let u = ref_axes[u_idx];
        let v = ref_axes[v_idx];
        let hu = ref_h[u_idx];
        let hv = ref_h[v_idx];

        // Incident face most opposite to ref_n
        let mut inc_idx = 0usize;
        let mut min_dot = f32::INFINITY;
        let mut inc_dir = Vec3::Y;
        for i in 0..3 {
            let d = inc_axes[i].dot(ref_n);
            if d < min_dot {
                min_dot = d;
                inc_idx = i;
                inc_dir = inc_axes[i];
            }
            if -d < min_dot {
                min_dot = -d;
                inc_idx = i;
                inc_dir = -inc_axes[i];
            }
        }
        let iu_idx = (inc_idx + 1) % 3;
        let iv_idx = (inc_idx + 2) % 3;
        let inc_center = inc_pos + inc_dir * inc_h[inc_idx];
        let iu = inc_axes[iu_idx] * inc_h[iu_idx];
        let iv = inc_axes[iv_idx] * inc_h[iv_idx];

        let mut poly_a = [Vec3::ZERO; 16];
        let mut poly_b = [Vec3::ZERO; 16];
        poly_a[0] = inc_center - iu - iv;
        poly_a[1] = inc_center + iu - iv;
        poly_a[2] = inc_center + iu + iv;
        poly_a[3] = inc_center - iu + iv;
        let mut plen = 4usize;

        let margin = 1e-4;
        plen = clip_poly_plane(&poly_a, plen, ref_center + u * (hu + margin), u, &mut poly_b);
        plen = clip_poly_plane(&poly_b, plen, ref_center - u * (hu + margin), -u, &mut poly_a);
        plen = clip_poly_plane(&poly_a, plen, ref_center + v * (hv + margin), v, &mut poly_b);
        plen = clip_poly_plane(&poly_b, plen, ref_center - v * (hv + margin), -v, &mut poly_a);

        for &pt in &poly_a[..plen] {
            let c_depth = (ref_center - pt).dot(ref_n);
            if c_depth > -1e-4 {
                push_manifold_point_dedup(
                    contacts,
                    count,
                    start_count,
                    other_idx,
                    pt,
                    normal,
                    c_depth.max(1e-5),
                );
            }
        }
    }

    // Edge-edge or fallback contact: emit midpoint between A's and B's support faces along `normal`.
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

#[allow(clippy::too_many_arguments)]
fn collect_triangle_contacts_ex(
    col: Collider3D,
    pos: Vec3,
    rot: Quat,
    tri: [Vec3; 3],
    internal_edges: u8,
    hulls: &[ConvexHullShape],
    compounds: &[CompoundShape],
    contacts: &mut [ContactPoint],
    count: &mut usize,
) {
    if let Collider3D::Compound { compound_id, .. } = col {
        if let Some(comp) = compounds.get(compound_id as usize) {
            for ch in &comp.children {
                collect_triangle_contacts_ex(
                    ch.collider,
                    pos + rot * ch.local_pos,
                    (rot * ch.local_rot).normalize(),
                    tri,
                    internal_edges,
                    hulls,
                    compounds,
                    contacts,
                    count,
                );
            }
        }
        return;
    }

    match col {
        Collider3D::Sphere { radius } => {
            if let Some((raw_n, d, tri_pt)) = sphere_vs_triangle_ex(pos, radius, tri) {
                let n = smooth_internal_triangle_normal(raw_n, tri, tri_pt, internal_edges);
                push_contact(contacts, count, None, false, tri_pt, n, d);
            }
        }
        Collider3D::Capsule { radius, half_height } => {
            let axis = rot * Vec3::Y;
            let (seg_pt, tri_pt, d2, _) = closest_segment_triangle(
                pos - axis * half_height,
                pos + axis * half_height,
                tri[0],
                tri[1],
                tri[2],
            );
            if d2 < radius * radius {
                let dist = d2.sqrt();
                let raw_n = if dist > 1e-6 {
                    (seg_pt - tri_pt) / dist
                } else {
                    let tn = (tri[1] - tri[0]).cross(tri[2] - tri[0]).normalize_or_zero();
                    if tn.length_squared() > 0.5 { tn } else { Vec3::Y }
                };
                let n = smooth_internal_triangle_normal(raw_n, tri, tri_pt, internal_edges);
                push_contact(contacts, count, None, false, tri_pt, n, radius - dist);
            }
        }
        Collider3D::Cylinder { .. } | Collider3D::ConvexHull { .. } => {
            if let Some(sa) = to_support(col, pos, rot, hulls) {
                let sb = SupportShape::Triangle { verts: tri };
                if let Some((raw_n, d, pt)) = gjk_epa(&sa, &sb) {
                    let n = smooth_internal_triangle_normal(raw_n, tri, pt, internal_edges);
                    push_contact(contacts, count, None, false, pt, n, d);
                }
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
        Collider3D::Compound { .. } => {}
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

fn sphere_vs_triangle_ex(center: Vec3, radius: f32, tri: [Vec3; 3]) -> Option<(Vec3, f32, Vec3)> {
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
            closest,
        ));
    }
    Some((diff / dist, radius - dist, closest))
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

    #[test]
    fn test_cube_tower_and_pyramid_rest_without_bouncing_or_toppling() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(30.0, 0.5, 30.0),
        });

        // 4-cube vertical tower with full rotation enabled
        let mut tower = Vec::new();
        for i in 0..4 {
            let e = world.spawn();
            world.set_transform_immediate(e, Vec3::new(0.0, 0.5 + (i as f32) * 1.01, 0.0), Quat::IDENTITY, Vec3::ONE);
            world.colliders_3d[entity_index(e)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
            world.rigid_bodies[entity_index(e)] = Some(RigidBody {
                friction: 0.78,
                restitution: 0.12,
                ..Default::default()
            });
            tower.push(e);
        }

        // 3-2-1 pyramid offset to the side
        let mut pyramid = Vec::new();
        for (row, count) in [3usize, 2, 1].iter().enumerate() {
            for col in 0..*count {
                let x = 6.0 + (col as f32 - ((*count - 1) as f32) * 0.5) * 1.08;
                let y = 0.5 + (row as f32) * 1.01;
                let e = world.spawn();
                world.set_transform_immediate(e, Vec3::new(x, y, 0.0), Quat::IDENTITY, Vec3::ONE);
                world.colliders_3d[entity_index(e)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
                world.rigid_bodies[entity_index(e)] = Some(RigidBody {
                    friction: 0.78,
                    restitution: 0.12,
                    ..Default::default()
                });
                pyramid.push((e, x, y));
            }
        }

        for _ in 0..240 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        // Tower must stand upright without bouncing or falling over
        for (i, &e) in tower.iter().enumerate() {
            let idx = entity_index(e);
            let p = world.curr_pos[idx];
            let v = world.velocities[idx];
            let expected_y = 0.5 + i as f32;
            assert!(
                (p.y - expected_y).abs() < 0.03 && p.x.abs() < 0.04 && p.z.abs() < 0.04,
                "tower cube {i} toppled or bounced! pos={p:?}, vel={v:?}"
            );
            assert!(v.length() < 0.05, "tower cube {i} still jittering! vel={v:?}");
        }

        // Pyramid apex must stay centered on top (~2.5m) and settle to sleep
        let (apex, _, _) = pyramid.last().copied().unwrap();
        let apex_p = world.curr_pos[entity_index(apex)];
        assert!(
            apex_p.y > 2.4 && (apex_p.x - 6.0).abs() < 0.12,
            "pyramid collapsed! apex pos={apex_p:?}"
        );
        let settled_count = pyramid
            .iter()
            .filter(|&&(e, _, _)| world.rigid_bodies[entity_index(e)].unwrap().sleeping)
            .count();
        assert_eq!(settled_count, 6, "pyramid should settle to sleep, settled={settled_count}/6");
    }

    #[test]
    fn test_mass_ratio_and_coulomb_friction() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig {
            gravity: Vec3::ZERO,
            ..Default::default()
        });

        let heavy = world.spawn();
        world.set_transform_immediate(heavy, Vec3::new(0.0, 1.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(heavy)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
        world.rigid_bodies[entity_index(heavy)] = Some(RigidBody {
            mass: 50.0,
            restitution: 1.0,
            friction: 0.0,
            linear_damping: 0.0,
            ..Default::default()
        });
        world.velocities[entity_index(heavy)] = Vec3::new(4.0, 0.0, 0.0);

        let light = world.spawn();
        world.set_transform_immediate(light, Vec3::new(1.5, 1.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(light)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
        world.rigid_bodies[entity_index(light)] = Some(RigidBody {
            mass: 1.0,
            restitution: 1.0,
            friction: 0.0,
            linear_damping: 0.0,
            ..Default::default()
        });

        for _ in 0..30 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        let vh = world.velocities[entity_index(heavy)].x;
        let vl = world.velocities[entity_index(light)].x;
        // Elastic collision: m1=50, m2=1 -> v2 ≈ 2*50/51 * 4 ≈ 7.84, v1 ≈ 49/51 * 4 ≈ 3.84
        assert!(vl > 6.8, "light mass should bounce fast when struck by heavy! vl={vl}");
        assert!(vh > 3.2, "heavy mass should barely slow down! vh={vh}");

        // Part 2: Static Coulomb friction (0.85 holds 20 deg slope, 0.02 ice slides smoothly)
        let mut slope_w = World::new();
        let mut slope_p = PhysicsWorld::new(PhysicsConfig::default());
        let tilt = Quat::from_rotation_z(-20.0f32.to_radians());

        let ramp = slope_w.spawn();
        slope_w.set_transform_immediate(ramp, Vec3::new(0.0, -0.5, 0.0), tilt, Vec3::ONE);
        slope_w.colliders_3d[entity_index(ramp)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(15.0, 0.5, 10.0),
        });
        slope_w.rigid_bodies[entity_index(ramp)] = Some(RigidBody {
            dynamic: false,
            friction: 0.9,
            restitution: 0.0,
            ..Default::default()
        });

        let grippy = slope_w.spawn();
        slope_w.set_transform_immediate(grippy, tilt * Vec3::new(0.0, 0.501, -3.0) + Vec3::new(0.0, -0.5, 0.0), tilt, Vec3::ONE);
        slope_w.colliders_3d[entity_index(grippy)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
        slope_w.rigid_bodies[entity_index(grippy)] = Some(RigidBody {
            friction: 0.9,
            restitution: 0.0,
            ..Default::default()
        });

        let icy = slope_w.spawn();
        slope_w.set_transform_immediate(icy, tilt * Vec3::new(0.0, 0.501, 3.0) + Vec3::new(0.0, -0.5, 0.0), tilt, Vec3::ONE);
        slope_w.colliders_3d[entity_index(icy)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
        slope_w.rigid_bodies[entity_index(icy)] = Some(RigidBody {
            friction: 0.01,
            restitution: 0.0,
            linear_damping: 0.0,
            ..Default::default()
        });

        for _ in 0..90 {
            slope_p.step(&mut slope_w, 1.0 / 60.0);
        }
        let g_pos = slope_w.curr_pos[entity_index(grippy)];
        let i_pos = slope_w.curr_pos[entity_index(icy)];
        assert!(g_pos.x < 0.25, "high-friction block should hold on 20 deg slope, x={}", g_pos.x);
        assert!(i_pos.x > 2.5, "icy low-friction block should slide fast down slope, x={}", i_pos.x);
    }

    #[test]
    fn test_capsule_push_crate_slides_without_tumbling() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(40.0, 0.5, 40.0),
        });
        world.rigid_bodies[entity_index(floor)] = Some(RigidBody {
            dynamic: false,
            friction: 0.75,
            ..Default::default()
        });

        let crate_e = world.spawn();
        world.set_transform_immediate(crate_e, Vec3::new(1.5, 0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(crate_e)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(crate_e)] = Some(RigidBody {
            dynamic: true,
            mass: 1.0,
            friction: 0.75,
            lock_rotation: false,
            ..Default::default()
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(0.0, 0.97, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.42,
            half_height: 0.55,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            mass: 1.0,
            lock_rotation: true,
            ..Default::default()
        });
        phys.set_character_controller(player, 0.5, 50.0);

        for _ in 0..90 {
            world.velocities[entity_index(player)].x = 6.5;
            phys.step(&mut world, 1.0 / 60.0);
        }

        let crate_pos = world.curr_pos[entity_index(crate_e)];
        let crate_up = world.curr_rot[entity_index(crate_e)] * Vec3::Y;
        assert!(crate_pos.x > 3.0, "crate did not slide forward cleanly: {:?}", crate_pos);
        assert!(
            crate_up.y > 0.985,
            "crate tumbled/rolled instead of sliding when pushed! up={:?}",
            crate_up
        );
    }

    #[test]
    fn test_capsule_cannot_climb_tall_wall_or_stacked_crates() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(40.0, 0.5, 40.0),
        });

        // 1.4m static block (way higher than step_height=0.5m)
        let tall = world.spawn();
        world.set_transform_immediate(tall, Vec3::new(2.0, 0.7, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(tall)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(0.6, 0.7, 2.0),
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(0.0, 0.97, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.42,
            half_height: 0.55,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            lock_rotation: true,
            ..Default::default()
        });
        phys.set_character_controller(player, 0.5, 50.0);

        // Part A: push continuously without jumping
        let mut max_y_walk = 0.0f32;
        for _ in 0..90 {
            world.velocities[entity_index(player)].x = 6.5;
            phys.step(&mut world, 1.0 / 60.0);
            max_y_walk = max_y_walk.max(world.curr_pos[entity_index(player)].y);
        }
        assert!(max_y_walk < 1.15, "character climbed tall block without jumping! max_y={max_y_walk}");
        assert!(world.curr_pos[entity_index(player)].x < 1.45, "character clipped into tall block");

        // Part B: 2.6m tall wall, spam jump whenever grounded is true - must never wall-climb!
        let wall = world.spawn();
        world.set_transform_immediate(wall, Vec3::new(0.0, 1.3, 4.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(wall)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(2.0, 1.3, 0.6),
        });
        world.set_transform_immediate(player, Vec3::new(0.0, 0.97, 2.0), Quat::IDENTITY, Vec3::ONE);
        world.velocities[entity_index(player)] = Vec3::ZERO;

        let mut max_y_jump = 0.0f32;
        let mut was_g = false;
        for _ in 0..180 {
            let grounded = world.rigid_bodies[entity_index(player)].unwrap().grounded;
            if grounded && was_g {
                world.velocities[entity_index(player)].y = 9.0;
            }
            was_g = grounded;
            world.velocities[entity_index(player)].z = 6.5;
            world.velocities[entity_index(player)].x = 0.0;
            phys.step(&mut world, 1.0 / 60.0);
            max_y_jump = max_y_jump.max(world.curr_pos[entity_index(player)].y);
        }
        // Single jump from floor reaches max center ~2.995m (foot 2.025m < wall top 2.6m), so player must never get on top (3.57m)
        assert!(max_y_jump < 3.25, "character wall-climbed onto 2.6m wall! max_y={max_y_jump}");
        assert!(world.curr_pos[entity_index(player)].z < 3.45);
    }

    #[test]
    fn test_rotated_obb_ramp_and_trimesh_internal_edge_smoothing() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        // Gentle 20 deg OBB ramp leading from floor at y=0 upward along +X
        let ramp_rot = Quat::from_rotation_z(20.0f32.to_radians());
        let ramp = world.spawn();
        world.set_transform_immediate(ramp, Vec3::new(4.0, 1.2, 0.0), ramp_rot, Vec3::ONE);
        world.colliders_3d[entity_index(ramp)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(5.0, 0.25, 2.5),
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(-0.2, 0.9, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.4,
            half_height: 0.5,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            lock_rotation: true,
            ..Default::default()
        });
        phys.set_character_controller(player, 0.45, 45.0);

        for _ in 0..90 {
            world.velocities[entity_index(player)].x = 5.0;
            phys.step(&mut world, 1.0 / 60.0);
        }
        let pos = world.curr_pos[entity_index(player)];
        assert!(pos.x > 3.0 && pos.y > 1.5, "capsule failed to walk up rotated 20 deg OBB ramp: {pos:?}");

        // Part 2: Smooth rolling across coplanar StaticTriMesh internal seam
        let mut mw = World::new();
        let mut mp = PhysicsWorld::new(PhysicsConfig::default());
        let tris = vec![
            [Vec3::new(-10.0, 0.0, -5.0), Vec3::new(-10.0, 0.0, 5.0), Vec3::new(0.0, 0.0, 5.0)],
            [Vec3::new(-10.0, 0.0, -5.0), Vec3::new(0.0, 0.0, 5.0), Vec3::new(0.0, 0.0, -5.0)],
            [Vec3::new(0.0, 0.0, -5.0), Vec3::new(0.0, 0.0, 5.0), Vec3::new(10.0, 0.0, 5.0)],
            [Vec3::new(0.0, 0.0, -5.0), Vec3::new(10.0, 0.0, 5.0), Vec3::new(10.0, 0.0, -5.0)],
        ];
        mp.add_static_mesh(INVALID_ENTITY, tris);
        let ball = mw.spawn();
        mw.set_transform_immediate(ball, Vec3::new(-2.0, 0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        mw.colliders_3d[entity_index(ball)] = Some(Collider3D::Sphere { radius: 0.5 });
        mw.rigid_bodies[entity_index(ball)] = Some(RigidBody {
            dynamic: true,
            friction: 0.0,
            restitution: 0.0,
            ..Default::default()
        });
        mw.velocities[entity_index(ball)] = Vec3::new(6.0, 0.0, 0.0);

        let mut max_vy = 0.0f32;
        for _ in 0..60 {
            mp.step(&mut mw, 1.0 / 60.0);
            max_vy = max_vy.max(mw.velocities[entity_index(ball)].y.abs());
        }
        assert!(max_vy < 0.08, "ball hopped across coplanar triangle seam! max_vy={max_vy}");
    }

    #[test]
    fn test_density_auto_mass_and_center_of_mass_roly_poly() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(30.0, 0.5, 30.0),
        });

        let wood = world.spawn();
        world.colliders_3d[entity_index(wood)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
        world.rigid_bodies[entity_index(wood)] = Some(RigidBody { density: 0.5, ..Default::default() });

        let stone = world.spawn();
        world.colliders_3d[entity_index(stone)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(1.0) });
        world.rigid_bodies[entity_index(stone)] = Some(RigidBody { density: 2.5, ..Default::default() });

        assert!((phys.effective_mass(&world, entity_index(wood)) - 0.5).abs() < 1e-4);
        assert!((phys.effective_mass(&world, entity_index(stone)) - 20.0).abs() < 1e-4);

        // Weighted roly-poly tilted sphere/capsule with low center_of_mass stabilizes upright
        let roly = world.spawn();
        world.set_transform_immediate(
            roly,
            Vec3::new(0.0, 0.85, 0.0),
            Quat::from_rotation_z(35.0f32.to_radians()),
            Vec3::ONE,
        );
        world.colliders_3d[entity_index(roly)] = Some(Collider3D::Sphere { radius: 0.8 });
        world.rigid_bodies[entity_index(roly)] = Some(RigidBody {
            dynamic: true,
            mass: 4.0,
            center_of_mass: Vec3::new(0.0, -0.55, 0.0),
            angular_damping: 0.9,
            ..Default::default()
        });
        for _ in 0..180 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        let up = world.curr_rot[entity_index(roly)] * Vec3::Y;
        assert!(up.y > 0.9, "low center_of_mass did not right tilted body! up={up:?}");
    }

    #[test]
    fn test_ccd_fast_projectile_does_not_tunnel_thin_wall() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig {
            gravity: Vec3::ZERO,
            ..Default::default()
        });

        let wall = world.spawn();
        world.set_transform_immediate(wall, Vec3::new(10.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(wall)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(0.04, 10.0, 10.0),
        });

        let bullet = world.spawn();
        world.set_transform_immediate(bullet, Vec3::new(0.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(bullet)] = Some(Collider3D::Sphere { radius: 0.15 });
        world.rigid_bodies[entity_index(bullet)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            linear_damping: 0.0,
            restitution: 0.5,
            ccd: true,
            ..Default::default()
        });
        world.velocities[entity_index(bullet)] = Vec3::new(150.0, 0.0, 0.0);

        for _ in 0..15 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        let bx = world.curr_pos[entity_index(bullet)].x;
        assert!(bx < 10.0, "CCD projectile tunneled through 0.08m wall! x={bx}");
    }

    #[test]
    fn test_water_zone_buoyancy_wood_floats_steel_sinks() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(20.0, 0.5, 20.0),
        });
        phys.add_water_zone(
            Vec3::new(0.0, 2.0, 0.0),
            Vec3::new(15.0, 2.0, 15.0),
            Quat::IDENTITY,
            1.0,
            2.2,
            2.0,
            Vec3::ZERO,
        );

        let wood = world.spawn();
        world.set_transform_immediate(wood, Vec3::new(-2.0, 4.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(wood)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.5) });
        world.rigid_bodies[entity_index(wood)] = Some(RigidBody {
            dynamic: true,
            density: 0.45,
            ..Default::default()
        });

        let steel = world.spawn();
        world.set_transform_immediate(steel, Vec3::new(2.0, 4.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(steel)] = Some(Collider3D::Sphere { radius: 0.5 });
        world.rigid_bodies[entity_index(steel)] = Some(RigidBody {
            dynamic: true,
            density: 7.8,
            ..Default::default()
        });

        for _ in 0..240 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let wy = world.curr_pos[entity_index(wood)].y;
        let sy = world.curr_pos[entity_index(steel)].y;
        assert!(wy > 3.2 && wy < 4.4, "wood box did not float near y=4.0 surface: y={wy}");
        assert!(sy < 0.7, "steel ball did not sink to pool floor: y={sy}");
    }

    #[test]
    fn test_cylinder_compound_queries_and_breakable_prismatic_joint() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(30.0, 0.5, 30.0),
        });

        // Barrel cylinder standing upright
        let barrel = world.spawn();
        world.set_transform_immediate(barrel, Vec3::new(0.0, 0.65, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(barrel)] = Some(Collider3D::Cylinder {
            radius: 0.45,
            half_height: 0.6,
        });
        world.rigid_bodies[entity_index(barrel)] = Some(RigidBody::default());

        // Compound L-bracket
        let (comp_id, comp_r) = phys.register_compound(vec![
            CompoundChild {
                local_pos: Vec3::new(-0.5, 0.0, 0.0),
                local_rot: Quat::IDENTITY,
                collider: Collider3D::Aabb { half_extents: Vec3::splat(0.5) },
            },
            CompoundChild {
                local_pos: Vec3::new(0.5, 0.0, 0.0),
                local_rot: Quat::IDENTITY,
                collider: Collider3D::Aabb { half_extents: Vec3::splat(0.5) },
            },
        ]);
        let comp = world.spawn();
        world.set_transform_immediate(comp, Vec3::new(5.0, 0.6, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(comp)] = Some(Collider3D::Compound {
            compound_id: comp_id,
            bounding_radius: comp_r,
        });
        world.rigid_bodies[entity_index(comp)] = Some(RigidBody::default());

        // Breakable fixed joint holding hanging block
        let hang = world.spawn();
        world.set_transform_immediate(hang, Vec3::new(-5.0, 4.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(hang)] = Some(Collider3D::Aabb { half_extents: Vec3::splat(0.4) });
        world.rigid_bodies[entity_index(hang)] = Some(RigidBody { dynamic: true, mass: 1.0, ..Default::default() });
        let jid = phys.joints.add_fixed(&world, INVALID_ENTITY, hang, Vec3::new(-5.0, 4.0, 0.0), Vec3::ZERO);
        phys.joints.set_break_force(jid, Some(120.0));

        for _ in 0..40 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        assert!(world.curr_pos[entity_index(barrel)].y > 0.55);
        assert!(world.curr_pos[entity_index(comp)].y > 0.45);
        assert!((world.curr_pos[entity_index(hang)].y - 4.0).abs() < 0.2, "fixed joint sagged before break");

        // Overlap & Sweep queries
        let ov_count = phys
            .overlap_shape(&world, Collider3D::Sphere { radius: 1.2 }, Vec3::new(0.0, 0.6, 0.0), Quat::IDENTITY, u32::MAX, false)
            .len();
        assert!(ov_count >= 2, "overlap_shape should find barrel & floor: {ov_count}");

        let sw = phys.sweep_shape(
            &world,
            Collider3D::Sphere { radius: 0.3 },
            Vec3::new(0.0, 0.6, -4.0),
            Quat::IDENTITY,
            Vec3::Z,
            8.0,
            u32::MAX,
            INVALID_ENTITY,
        );
        assert_eq!(sw.map(|h| h.entity), Some(barrel));

        // Break fixed joint via large downward impulse
        phys.apply_impulse(&mut world, hang, Vec3::new(0.0, -40.0, 0.0), None);
        for _ in 0..45 {
            phys.step(&mut world, 1.0 / 60.0);
        }
        assert!(phys.joints.joints.is_empty(), "breakable fixed joint did not snap under heavy impulse");
        assert!(world.curr_pos[entity_index(hang)].y < 2.5, "broken hanging block did not fall");
    }

    #[test]
    fn test_character_push_elevated_and_tall_crates_never_panics() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(20.0, 0.5, 20.0),
        });

        // Elevated table + overhanging crate spawned BEFORE player (so a = crate < b = player)
        let table = world.spawn();
        world.set_transform_immediate(table, Vec3::new(0.0, 0.45, -3.4), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(table)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(1.5, 0.45, 1.4),
        });
        let high_crate = world.spawn();
        world.set_transform_immediate(high_crate, Vec3::new(0.0, 1.4, -2.05), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(high_crate)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.5),
        });
        world.rigid_bodies[entity_index(high_crate)] = Some(RigidBody {
            dynamic: true,
            mass: 3.0,
            friction: 0.6,
            ..Default::default()
        });

        let player = world.spawn();
        world.set_transform_immediate(player, Vec3::new(0.0, 0.97, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(player)] = Some(Collider3D::Capsule {
            radius: 0.42,
            half_height: 0.55,
        });
        world.rigid_bodies[entity_index(player)] = Some(RigidBody {
            dynamic: true,
            mass: 70.0,
            lock_rotation: true,
            ..Default::default()
        });
        phys.set_character_controller_ex(player, 0.5, 50.0, 0.9, 35.0, 0.14, true);

        // Second tall crate spawned AFTER player (a = player < b = crate)
        let tall_crate = world.spawn();
        world.set_transform_immediate(tall_crate, Vec3::new(4.0, 0.85, -3.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(tall_crate)] = Some(Collider3D::Aabb {
            half_extents: Vec3::splat(0.85),
        });
        world.rigid_bodies[entity_index(tall_crate)] = Some(RigidBody {
            dynamic: true,
            mass: 10.0,
            friction: 0.65,
            ..Default::default()
        });

        for _ in 0..80 {
            world.velocities[entity_index(player)].x = 0.0;
            world.velocities[entity_index(player)].z = -6.0;
            phys.step(&mut world, 1.0 / 60.0);
        }
        assert!(world.curr_pos[entity_index(high_crate)].z < -2.2, "player should push elevated crate without panic");

        world.set_transform_immediate(player, Vec3::new(4.0, 0.97, 0.0), Quat::IDENTITY, Vec3::ONE);
        for _ in 0..100 {
            world.velocities[entity_index(player)].x = 0.0;
            world.velocities[entity_index(player)].z = -6.0;
            phys.step(&mut world, 1.0 / 60.0);
        }
        assert!(world.curr_pos[entity_index(tall_crate)].z < -3.2, "player should push tall crate smoothly");
    }

    #[test]
    fn test_mixed_sphere_and_cube_pile_settles_to_sleep() {
        let mut world = World::new();
        let mut phys = PhysicsWorld::new(PhysicsConfig::default());

        let floor = world.spawn();
        world.set_transform_immediate(floor, Vec3::new(0.0, -0.5, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.colliders_3d[entity_index(floor)] = Some(Collider3D::Aabb {
            half_extents: Vec3::new(15.0, 0.5, 15.0),
        });

        let mut bodies = Vec::new();
        for i in 0..30 {
            let e = world.spawn();
            let row = i / 6;
            let col = i % 6;
            let x = (col as f32 - 2.5) * 1.15 + if i % 2 == 0 { 0.1 } else { -0.1 };
            let y = 0.6 + row as f32 * 1.15;
            let z = ((i * 7 % 5) as f32 - 2.0) * 0.45;
            world.set_transform_immediate(e, Vec3::new(x, y, z), Quat::IDENTITY, Vec3::ONE);
            if i % 3 == 0 {
                world.colliders_3d[entity_index(e)] = Some(Collider3D::Sphere { radius: 0.52 });
                world.rigid_bodies[entity_index(e)] = Some(RigidBody {
                    dynamic: true,
                    mass: 1.0,
                    friction: 0.78,
                    restitution: 0.42,
                    ..Default::default()
                });
            } else {
                world.colliders_3d[entity_index(e)] = Some(Collider3D::Aabb {
                    half_extents: Vec3::splat(0.5),
                });
                world.rigid_bodies[entity_index(e)] = Some(RigidBody {
                    dynamic: true,
                    mass: 1.0,
                    friction: 0.78,
                    restitution: 0.12,
                    ..Default::default()
                });
            }
            bodies.push(e);
        }

        for _ in 0..360 {
            phys.step(&mut world, 1.0 / 60.0);
        }

        let sleeping = bodies
            .iter()
            .filter(|&&e| world.rigid_bodies[entity_index(e)].map_or(false, |r| r.sleeping))
            .count();
        assert!(
            sleeping >= 28,
            "mixed cube+sphere pile should settle to sleep cleanly, got {sleeping}/30 sleeping"
        );
    }
}
