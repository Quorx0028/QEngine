pub mod animation;
pub mod cloth;
pub mod collision_math;
pub mod ecs;
pub mod gltf_loader;
pub mod joints;
pub mod nav;
pub mod particles;
pub mod physics;
pub mod render;
pub mod terrain;

use animation::AnimationSystem;
use cloth::{ClothGrid, ClothWorld};
use ecs::{
    entity_index, Collider2D, Collider3D, EntityHandle, MeshInstance3D, RigidBody, Sprite2D, World,
};
use gltf_loader::{parse_glb, ParsedGlb};
use nav::NavGrid;
use particles::ParticleSystem;
use physics::{PhysicsConfig, PhysicsWorld, TileGrid2D};
use render::RenderQueue;
use terrain::TerrainHeightmap;

use glam::{Mat4, Quat, Vec2, Vec3};
use std::alloc::{alloc, dealloc, Layout};

pub const ABI_VERSION: u32 = 1;
const ALLOC_ALIGN: usize = 16;

pub struct EngineCore {
    pub world: World,
    pub physics: PhysicsWorld,
    pub render_queue: RenderQueue,
    pub animations: AnimationSystem,
    pub particles: ParticleSystem,
    pub cloth: ClothWorld,
    pub nav: NavGrid,
    pub last_glb: Option<ParsedGlb>,
    pub glb_bounds: [f32; 6],
}

impl EngineCore {
    pub fn new() -> Self {
        Self {
            world: World::new(),
            physics: PhysicsWorld::new(PhysicsConfig::default()),
            render_queue: RenderQueue::new(),
            animations: AnimationSystem::new(),
            particles: ParticleSystem::new(),
            cloth: ClothWorld::new(),
            nav: NavGrid::new(),
            last_glb: None,
            glb_bounds: [0.0; 6],
        }
    }
}

impl Default for EngineCore {
    fn default() -> Self {
        Self::new()
    }
}

#[no_mangle]
pub extern "C" fn core_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn quark_alloc(len: usize) -> *mut u8 {
    let size = len.max(1);
    let Ok(layout) = Layout::from_size_align(size, ALLOC_ALIGN) else {
        return std::ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

/// # Safety
/// `ptr` must have been returned by `quark_alloc(len)` and not yet freed.
#[no_mangle]
pub unsafe extern "C" fn quark_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let size = len.max(1);
    if let Ok(layout) = Layout::from_size_align(size, ALLOC_ALIGN) {
        dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn core_create() -> *mut EngineCore {
    Box::into_raw(Box::new(EngineCore::new()))
}

/// # Safety
/// `ptr` must be valid or null.
#[no_mangle]
pub unsafe extern "C" fn core_destroy(ptr: *mut EngineCore) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

/// # Safety
/// `ptr` must be a valid `EngineCore` pointer.
#[no_mangle]
pub unsafe extern "C" fn core_clear(ptr: *mut EngineCore) {
    let core = &mut *ptr;
    core.world.clear();
    core.physics.clear_static_geometry();
    core.animations.clear();
    core.particles.clear();
    core.cloth.clear();
    core.nav.resize(0.0, 0.0, 1.0, 0, 0);
    core.render_queue.items_2d.clear();
    core.render_queue.tex_ids_2d.clear();
    core.render_queue.items_3d.clear();
}

#[no_mangle]
pub unsafe extern "C" fn core_set_gravity(ptr: *mut EngineCore, gx: f32, gy: f32, gz: f32) {
    (*ptr).physics.config.gravity = Vec3::new(gx, gy, gz);
}

#[no_mangle]
pub unsafe extern "C" fn core_set_fixed_dt(ptr: *mut EngineCore, fixed_dt: f32) {
    (*ptr).physics.config.fixed_dt = fixed_dt.max(1e-4);
}

#[no_mangle]
pub unsafe extern "C" fn core_spawn(ptr: *mut EngineCore) -> EntityHandle {
    (*ptr).world.spawn()
}

#[no_mangle]
pub unsafe extern "C" fn core_despawn(ptr: *mut EngineCore, entity: EntityHandle) -> u32 {
    u32::from((*ptr).world.despawn(entity))
}

#[no_mangle]
pub unsafe extern "C" fn core_is_alive(ptr: *mut EngineCore, entity: EntityHandle) -> u32 {
    u32::from((*ptr).world.is_alive(entity))
}

#[no_mangle]
pub unsafe extern "C" fn core_alive_count(ptr: *mut EngineCore) -> u32 {
    (*ptr).world.alive_count() as u32
}

#[no_mangle]
pub unsafe extern "C" fn core_set_parent(
    ptr: *mut EngineCore,
    child: EntityHandle,
    parent: EntityHandle,
) -> u32 {
    u32::from((*ptr).world.set_parent(child, parent))
}

#[no_mangle]
pub unsafe extern "C" fn core_set_transform(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    px: f32,
    py: f32,
    pz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
    rw: f32,
    sx: f32,
    sy: f32,
    sz: f32,
    immediate: u32,
) {
    let pos = Vec3::new(px, py, pz);
    let rot = Quat::from_xyzw(rx, ry, rz, rw);
    let scale = Vec3::new(sx, sy, sz);
    if immediate != 0 {
        (*ptr).world.set_transform_immediate(entity, pos, rot, scale);
    } else {
        (*ptr).world.set_curr_transform(entity, pos, rot, scale);
    }
    (*ptr).world.wake_body(entity);
}

#[no_mangle]
pub unsafe extern "C" fn core_get_position(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    out_xyz: *mut f32,
) -> u32 {
    let core = &*ptr;
    if !core.world.is_alive(entity) || out_xyz.is_null() {
        return 0;
    }
    let p = core.world.curr_pos[entity_index(entity)];
    let out = std::slice::from_raw_parts_mut(out_xyz, 3);
    out[0] = p.x;
    out[1] = p.y;
    out[2] = p.z;
    1
}

#[no_mangle]
pub unsafe extern "C" fn core_get_transform(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    out_buf: *mut f32,
) -> u32 {
    let core = &*ptr;
    if !core.world.is_alive(entity) || out_buf.is_null() {
        return 0;
    }
    let idx = entity_index(entity);
    let p = core.world.curr_pos[idx];
    let r = core.world.curr_rot[idx];
    let s = core.world.scale[idx];
    let out = std::slice::from_raw_parts_mut(out_buf, 10);
    out[0] = p.x;
    out[1] = p.y;
    out[2] = p.z;
    out[3] = r.x;
    out[4] = r.y;
    out[5] = r.z;
    out[6] = r.w;
    out[7] = s.x;
    out[8] = s.y;
    out[9] = s.z;
    1
}

#[no_mangle]
pub unsafe extern "C" fn core_set_velocity(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    vx: f32,
    vy: f32,
    vz: f32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        core.world.velocities[entity_index(entity)] = Vec3::new(vx, vy, vz);
        if vx * vx + vy * vy + vz * vz > 1e-6 {
            core.world.wake_body(entity);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_get_velocity(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    out_xyz: *mut f32,
) -> u32 {
    let core = &*ptr;
    if !core.world.is_alive(entity) || out_xyz.is_null() {
        return 0;
    }
    let v = core.world.velocities[entity_index(entity)];
    let out = std::slice::from_raw_parts_mut(out_xyz, 3);
    out[0] = v.x;
    out[1] = v.y;
    out[2] = v.z;
    1
}

#[no_mangle]
pub unsafe extern "C" fn core_set_rigid_body(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    dynamic: u32,
    gravity_scale: f32,
    restitution: f32,
    friction: f32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        core.world.rigid_bodies[entity_index(entity)] = Some(RigidBody {
            dynamic: dynamic != 0,
            gravity_scale,
            restitution,
            friction,
            ..Default::default()
        });
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_rigid_body_ex(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    dynamic: u32,
    gravity_scale: f32,
    restitution: f32,
    friction: f32,
    linear_damping: f32,
    angular_damping: f32,
    mass: f32,
    lock_rotation: u32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        core.world.rigid_bodies[entity_index(entity)] = Some(RigidBody {
            dynamic: dynamic != 0,
            gravity_scale,
            restitution,
            friction,
            linear_damping,
            angular_damping,
            mass: mass.max(0.01),
            lock_rotation: lock_rotation != 0,
            ..Default::default()
        });
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_angular_velocity(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    wx: f32,
    wy: f32,
    wz: f32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        core.world.angular_velocities[entity_index(entity)] = Vec3::new(wx, wy, wz);
        if wx * wx + wy * wy + wz * wz > 1e-6 {
            core.world.wake_body(entity);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_collision_filter(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    layer: u32,
    mask: u32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        let idx = entity_index(entity);
        let rb = core.world.rigid_bodies[idx].get_or_insert(RigidBody {
            dynamic: false,
            ..Default::default()
        });
        rb.layer = layer;
        rb.mask = mask;
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_trigger(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    is_trigger: u32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        let idx = entity_index(entity);
        let rb = core.world.rigid_bodies[idx].get_or_insert(RigidBody {
            dynamic: false,
            ..Default::default()
        });
        rb.is_trigger = is_trigger != 0;
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_physics_material(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    density: f32,
    com_x: f32,
    com_y: f32,
    com_z: f32,
    static_friction: f32,
    restitution_threshold: f32,
    friction_combine: u32,
    restitution_combine: u32,
    ccd: u32,
    can_sleep: u32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        let idx = entity_index(entity);
        let rb = core.world.rigid_bodies[idx].get_or_insert(RigidBody::default());
        rb.density = density.max(0.0);
        rb.center_of_mass = Vec3::new(com_x, com_y, com_z);
        rb.static_friction = static_friction;
        rb.restitution_threshold = restitution_threshold.max(0.0);
        rb.friction_combine = (friction_combine & 0xFF) as u8;
        rb.restitution_combine = (restitution_combine & 0xFF) as u8;
        rb.ccd = ccd != 0;
        rb.can_sleep = can_sleep != 0;
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_character_controller(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    step_height: f32,
    max_slope_deg: f32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        core.physics
            .set_character_controller(entity, step_height, max_slope_deg);
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_set_character_controller_ex(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    step_height: f32,
    max_slope_deg: f32,
    push_strength: f32,
    max_push_mass: f32,
    ground_snap: f32,
    anti_tip_push: u32,
) {
    let core = &mut *ptr;
    if core.world.is_alive(entity) {
        core.physics.set_character_controller_ex(
            entity,
            step_height,
            max_slope_deg,
            push_strength,
            max_push_mass,
            ground_snap,
            anti_tip_push != 0,
        );
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_add_ball_socket_joint(
    ptr: *mut EngineCore,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
) -> u32 {
    (*ptr).physics.joints.add_ball_socket(
        entity_a,
        entity_b,
        Vec3::new(ax, ay, az),
        Vec3::new(bx, by, bz),
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_add_fixed_joint(
    ptr: *mut EngineCore,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
) -> u32 {
    let core = &mut *ptr;
    core.physics.joints.add_fixed(
        &core.world,
        entity_a,
        entity_b,
        Vec3::new(ax, ay, az),
        Vec3::new(bx, by, bz),
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_add_prismatic_joint(
    ptr: *mut EngineCore,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
    axis_x: f32,
    axis_y: f32,
    axis_z: f32,
    has_limits: i32,
    min_dist: f32,
    max_dist: f32,
) -> u32 {
    let core = &mut *ptr;
    core.physics.joints.add_prismatic(
        &core.world,
        entity_a,
        entity_b,
        Vec3::new(ax, ay, az),
        Vec3::new(bx, by, bz),
        Vec3::new(axis_x, axis_y, axis_z),
        if has_limits != 0 { Some(min_dist) } else { None },
        if has_limits != 0 { Some(max_dist) } else { None },
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_set_hinge_motor(
    ptr: *mut EngineCore,
    joint_id: u32,
    speed: f32,
    max_torque: f32,
) -> i32 {
    i32::from((*ptr).physics.joints.set_hinge_motor(joint_id, speed, max_torque))
}

#[no_mangle]
pub unsafe extern "C" fn core_set_joint_break_force(
    ptr: *mut EngineCore,
    joint_id: u32,
    break_force: f32,
) -> i32 {
    let val = if break_force >= 0.0 && break_force.is_finite() {
        Some(break_force)
    } else {
        None
    };
    i32::from((*ptr).physics.joints.set_break_force(joint_id, val))
}

#[no_mangle]
pub unsafe extern "C" fn core_add_distance_joint(
    ptr: *mut EngineCore,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
    rest_length: f32,
    stiffness: f32,
) -> u32 {
    (*ptr).physics.joints.add_distance(
        entity_a,
        entity_b,
        Vec3::new(ax, ay, az),
        Vec3::new(bx, by, bz),
        rest_length,
        stiffness,
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_add_spring_joint(
    ptr: *mut EngineCore,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
    rest_length: f32,
    stiffness: f32,
    damping: f32,
) -> u32 {
    (*ptr).physics.joints.add_spring(
        entity_a,
        entity_b,
        Vec3::new(ax, ay, az),
        Vec3::new(bx, by, bz),
        rest_length,
        stiffness,
        damping,
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_add_hinge_joint(
    ptr: *mut EngineCore,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    ax: f32,
    ay: f32,
    az: f32,
    bx: f32,
    by: f32,
    bz: f32,
    axis_x: f32,
    axis_y: f32,
    axis_z: f32,
    has_limits: i32,
    min_angle: f32,
    max_angle: f32,
) -> u32 {
    let core = &mut *ptr;
    core.physics.joints.add_hinge(
        &core.world,
        entity_a,
        entity_b,
        Vec3::new(ax, ay, az),
        Vec3::new(bx, by, bz),
        Vec3::new(axis_x, axis_y, axis_z),
        if has_limits != 0 { Some(min_angle) } else { None },
        if has_limits != 0 { Some(max_angle) } else { None },
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_remove_joint(ptr: *mut EngineCore, joint_id: u32) -> i32 {
    if (*ptr).physics.joints.remove(joint_id) {
        1
    } else {
        0
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_is_sleeping(ptr: *mut EngineCore, entity: EntityHandle) -> u32 {
    let core = &*ptr;
    if !core.world.is_alive(entity) {
        return 0;
    }
    u32::from(
        core.world.rigid_bodies[entity_index(entity)]
            .map(|r| r.sleeping)
            .unwrap_or(false),
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_apply_impulse(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    ix: f32,
    iy: f32,
    iz: f32,
    px: f32,
    py: f32,
    pz: f32,
    has_point: u32,
) {
    let core = &mut *ptr;
    let pt = if has_point != 0 {
        Some(Vec3::new(px, py, pz))
    } else {
        None
    };
    core.physics
        .apply_impulse(&mut core.world, entity, Vec3::new(ix, iy, iz), pt);
}

#[no_mangle]
pub unsafe extern "C" fn core_is_grounded(ptr: *mut EngineCore, entity: EntityHandle) -> u32 {
    let core = &*ptr;
    if !core.world.is_alive(entity) {
        return 0;
    }
    u32::from(
        core.world.rigid_bodies[entity_index(entity)]
            .map(|r| r.grounded)
            .unwrap_or(false),
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_set_collider_3d(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    kind: u32,
    a: f32,
    b: f32,
    c: f32,
) {
    let core = &mut *ptr;
    if !core.world.is_alive(entity) {
        return;
    }
    let col = match kind {
        0 => Collider3D::Aabb {
            half_extents: Vec3::new(a, b, c),
        },
        1 => Collider3D::Sphere { radius: a },
        3 => Collider3D::Cylinder {
            radius: a,
            half_height: b,
        },
        _ => Collider3D::Capsule {
            radius: a,
            half_height: b,
        },
    };
    core.world.colliders_3d[entity_index(entity)] = Some(col);
}

#[no_mangle]
pub unsafe extern "C" fn core_scale_collider_3d(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    rx: f32,
    ry: f32,
    rz: f32,
) {
    let core = &mut *ptr;
    core.physics.scale_collider_3d(&mut core.world, entity, rx, ry, rz);
}

#[no_mangle]
pub unsafe extern "C" fn core_set_collider_convex_hull(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    verts_ptr: *const f32,
    float_len: usize,
) {
    let core = &mut *ptr;
    if !core.world.is_alive(entity) || verts_ptr.is_null() || float_len < 12 {
        return;
    }
    let floats = std::slice::from_raw_parts(verts_ptr, float_len);
    let mut pts = Vec::with_capacity(float_len / 3);
    for ch in floats.chunks_exact(3) {
        pts.push(Vec3::new(ch[0], ch[1], ch[2]));
    }
    let (hull_id, bounding_radius) = core.physics.register_convex_hull(&pts);
    core.world.colliders_3d[entity_index(entity)] = Some(Collider3D::ConvexHull {
        hull_id,
        bounding_radius,
    });
}

#[no_mangle]
pub unsafe extern "C" fn core_set_collider_compound(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    parts_ptr: *const f32,
    part_count: usize,
) {
    let core = &mut *ptr;
    if !core.world.is_alive(entity) || parts_ptr.is_null() || part_count == 0 {
        return;
    }
    let floats = std::slice::from_raw_parts(parts_ptr, part_count * 11);
    let mut children = Vec::with_capacity(part_count);
    for ch in floats.chunks_exact(11) {
        let kind = ch[0].round() as u32;
        let local_pos = Vec3::new(ch[1], ch[2], ch[3]);
        let local_rot = Quat::from_xyzw(ch[4], ch[5], ch[6], ch[7]).normalize();
        let collider = match kind {
            0 => Collider3D::Aabb {
                half_extents: Vec3::new(ch[8], ch[9], ch[10]),
            },
            1 => Collider3D::Sphere { radius: ch[8] },
            3 => Collider3D::Cylinder {
                radius: ch[8],
                half_height: ch[9],
            },
            _ => Collider3D::Capsule {
                radius: ch[8],
                half_height: ch[9],
            },
        };
        children.push(crate::collision_math::CompoundChild {
            local_pos,
            local_rot,
            collider,
        });
    }
    let (compound_id, bounding_radius) = core.physics.register_compound(children);
    core.world.colliders_3d[entity_index(entity)] = Some(Collider3D::Compound {
        compound_id,
        bounding_radius,
    });
}

#[no_mangle]
pub unsafe extern "C" fn core_set_collider_2d(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    kind: u32,
    a: f32,
    b: f32,
) {
    let core = &mut *ptr;
    if !core.world.is_alive(entity) {
        return;
    }
    let col = match kind {
        0 => Collider2D::Aabb2D {
            half_extents: Vec2::new(a, b),
        },
        2 => Collider2D::Capsule2D {
            radius: a,
            half_height: b,
        },
        _ => Collider2D::Circle2D { radius: a },
    };
    core.world.colliders_2d[entity_index(entity)] = Some(col);
}

#[no_mangle]
pub unsafe extern "C" fn core_add_water_zone(
    ptr: *mut EngineCore,
    cx: f32,
    cy: f32,
    cz: f32,
    hx: f32,
    hy: f32,
    hz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
    rw: f32,
    density: f32,
    linear_drag: f32,
    angular_drag: f32,
    fx: f32,
    fy: f32,
    fz: f32,
) -> u32 {
    (*ptr).physics.add_water_zone(
        Vec3::new(cx, cy, cz),
        Vec3::new(hx, hy, hz),
        Quat::from_xyzw(rx, ry, rz, rw),
        density,
        linear_drag,
        angular_drag,
        Vec3::new(fx, fy, fz),
    )
}

#[no_mangle]
pub unsafe extern "C" fn core_clear_water_zones(ptr: *mut EngineCore) {
    (*ptr).physics.clear_water_zones();
}

#[no_mangle]
pub unsafe extern "C" fn core_add_tile_grid_2d(
    ptr: *mut EngineCore,
    ox: f32,
    oy: f32,
    tile_size: f32,
    width: u32,
    height: u32,
    solid_ptr: *const u8,
    solid_len: usize,
) {
    let core = &mut *ptr;
    if solid_ptr.is_null() {
        return;
    }
    let solid = std::slice::from_raw_parts(solid_ptr, solid_len).to_vec();
    core.physics.tile_grids_2d.push(TileGrid2D::new(
        Vec2::new(ox, oy),
        tile_size,
        width as usize,
        height as usize,
        solid,
    ));
}

#[no_mangle]
pub unsafe extern "C" fn core_add_static_mesh_triangles(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    verts_ptr: *const f32,
    float_len: usize,
) {
    let core = &mut *ptr;
    if verts_ptr.is_null() || float_len < 9 {
        return;
    }
    let floats = std::slice::from_raw_parts(verts_ptr, float_len);
    let mut tris = Vec::with_capacity(float_len / 9);
    for chunk in floats.chunks_exact(9) {
        tris.push([
            Vec3::new(chunk[0], chunk[1], chunk[2]),
            Vec3::new(chunk[3], chunk[4], chunk[5]),
            Vec3::new(chunk[6], chunk[7], chunk[8]),
        ]);
    }
    core.physics.add_static_mesh(entity, tris);
}

#[no_mangle]
pub unsafe extern "C" fn core_set_sprite_2d(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    w: f32,
    h: f32,
    u0: f32,
    v0: f32,
    u1: f32,
    v1: f32,
    r: f32,
    g: f32,
    b: f32,
    a: f32,
    tex_id: u32,
    layer: i32,
) {
    let core = &mut *ptr;
    if !core.world.is_alive(entity) {
        return;
    }
    core.world.sprites_2d[entity_index(entity)] = Some(Sprite2D {
        size: Vec2::new(w, h),
        uv_min: Vec2::new(u0, v0),
        uv_max: Vec2::new(u1, v1),
        color: [r, g, b, a],
        tex_id,
        layer,
    });
}

#[no_mangle]
pub unsafe extern "C" fn core_set_mesh_3d(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    mesh_id: u32,
    material_id: u32,
    flags: u32,
    bounds_radius: f32,
) {
    let core = &mut *ptr;
    if !core.world.is_alive(entity) {
        return;
    }
    core.world.meshes_3d[entity_index(entity)] = Some(MeshInstance3D {
        mesh_id,
        material_id,
        flags,
        bounds_radius,
    });
}

#[no_mangle]
pub unsafe extern "C" fn core_step(
    ptr: *mut EngineCore,
    frame_dt: f32,
    view_proj_ptr: *const f32,
) -> f32 {
    let core = &mut *ptr;
    core.physics.clear_events();
    let res = core.physics.step(&mut core.world, frame_dt);
    let anim_dt = if frame_dt.is_finite() {
        frame_dt.clamp(0.0, 0.1)
    } else {
        0.0
    };
    core.animations.step(&core.world, anim_dt);
    core.particles.step_and_pack(anim_dt);
    core.cloth.step(anim_dt);
    core.render_queue.build_2d(&core.world);
    let vp = if view_proj_ptr.is_null() {
        Mat4::IDENTITY
    } else {
        Mat4::from_cols_slice(std::slice::from_raw_parts(view_proj_ptr, 16))
    };
    core.render_queue.build_3d(&core.world, &vp);
    res.alpha
}

#[no_mangle]
pub unsafe extern "C" fn core_raycast_3d(
    ptr: *mut EngineCore,
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_dist: f32,
    out_buf: *mut f32,
) -> EntityHandle {
    core_raycast_3d_ex(ptr, ox, oy, oz, dx, dy, dz, max_dist, u32::MAX, 0.0, out_buf)
}

#[no_mangle]
pub unsafe extern "C" fn core_raycast_3d_ex(
    ptr: *mut EngineCore,
    ox: f32,
    oy: f32,
    oz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_dist: f32,
    mask: u32,
    sphere_radius: f32,
    out_buf: *mut f32,
) -> EntityHandle {
    let core = &*ptr;
    let Some(hit) = core.physics.raycast_3d_ex(
        &core.world,
        Vec3::new(ox, oy, oz),
        Vec3::new(dx, dy, dz),
        max_dist,
        mask,
        sphere_radius,
    ) else {
        return 0;
    };
    if !out_buf.is_null() {
        let out = std::slice::from_raw_parts_mut(out_buf, 7);
        out[0] = hit.distance;
        out[1] = hit.point.x;
        out[2] = hit.point.y;
        out[3] = hit.point.z;
        out[4] = hit.normal.x;
        out[5] = hit.normal.y;
        out[6] = hit.normal.z;
    }
    hit.entity
}

#[no_mangle]
pub unsafe extern "C" fn core_set_terrain_heightmap(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    origin_x: f32,
    origin_z: f32,
    cell_size: f32,
    width: usize,
    height: usize,
    heights_ptr: *const f32,
    heights_len: usize,
) {
    if heights_ptr.is_null() || heights_len == 0 {
        return;
    }
    let slice = std::slice::from_raw_parts(heights_ptr, heights_len);
    let core = &mut *ptr;
    core.physics.terrain =
        TerrainHeightmap::new(origin_x, origin_z, cell_size, width, height, slice.to_vec());
    core.physics.terrain_entity = entity;
}

#[no_mangle]
pub unsafe extern "C" fn core_sample_terrain_height(
    ptr: *const EngineCore,
    x: f32,
    z: f32,
    out_normal_ptr: *mut f32,
) -> f32 {
    let Some(hm) = &(*ptr).physics.terrain else {
        return f32::NAN;
    };
    let Some((h, n)) = hm.sample_height_and_normal(x, z) else {
        return f32::NAN;
    };
    if !out_normal_ptr.is_null() {
        let out = std::slice::from_raw_parts_mut(out_normal_ptr, 3);
        out[0] = n.x;
        out[1] = n.y;
        out[2] = n.z;
    }
    h
}

#[no_mangle]
pub unsafe extern "C" fn core_nav_build_3d(
    ptr: *mut EngineCore,
    origin_x: f32,
    origin_z: f32,
    cell_size: f32,
    width: usize,
    height: usize,
    min_y: f32,
    max_y: f32,
    agent_radius: f32,
) {
    let core = &mut *ptr;
    core.nav.build_from_world_3d(
        &core.world,
        origin_x,
        origin_z,
        cell_size,
        width,
        height,
        min_y,
        max_y,
        agent_radius,
    );
}

#[no_mangle]
pub unsafe extern "C" fn core_nav_build_2d(ptr: *mut EngineCore) {
    let core = &mut *ptr;
    if let Some(grid) = core.physics.tile_grids_2d.first() {
        core.nav.build_from_tile_grid_2d(grid);
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_nav_set_blocked(
    ptr: *mut EngineCore,
    cx: i32,
    cz: i32,
    blocked: i32,
) {
    (*ptr).nav.set_blocked(cx as isize, cz as isize, blocked != 0);
}

#[no_mangle]
pub unsafe extern "C" fn core_nav_find_path(
    ptr: *mut EngineCore,
    sx: f32,
    sz: f32,
    gx: f32,
    gz: f32,
    smooth: i32,
) -> usize {
    (*ptr).nav.find_path(sx, sz, gx, gz, smooth != 0)
}

#[no_mangle]
pub unsafe extern "C" fn core_nav_path_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).nav.path_points.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_nav_path_len(ptr: *const EngineCore) -> usize {
    (*ptr).nav.path_points.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_get_bone_transform(
    ptr: *const EngineCore,
    entity: EntityHandle,
    joint_idx: usize,
    out_pos_rot_ptr: *mut f32,
) -> i32 {
    let core = &*ptr;
    let Some(m) = core.animations.get_bone_world_matrix(&core.world, entity, joint_idx) else {
        return 0;
    };
    if !out_pos_rot_ptr.is_null() {
        let (_s, rot, pos) = m.to_scale_rotation_translation();
        let out = std::slice::from_raw_parts_mut(out_pos_rot_ptr, 7);
        out[0] = pos.x;
        out[1] = pos.y;
        out[2] = pos.z;
        out[3] = rot.x;
        out[4] = rot.y;
        out[5] = rot.z;
        out[6] = rot.w;
    }
    1
}

#[no_mangle]
pub unsafe extern "C" fn core_matrices_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).world.world_matrices.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_matrices_len(ptr: *const EngineCore) -> usize {
    (*ptr).world.world_matrices.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_render_2d_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).render_queue.items_2d.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_render_2d_len(ptr: *const EngineCore) -> usize {
    (*ptr).render_queue.items_2d.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_render_2d_tex_ptr(ptr: *const EngineCore) -> *const u32 {
    (*ptr).render_queue.tex_ids_2d.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_render_2d_tex_len(ptr: *const EngineCore) -> usize {
    (*ptr).render_queue.tex_ids_2d.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_render_3d_ptr(ptr: *const EngineCore) -> *const u32 {
    (*ptr).render_queue.items_3d.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_render_3d_len(ptr: *const EngineCore) -> usize {
    (*ptr).render_queue.items_3d.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_events_ptr(ptr: *const EngineCore) -> *const u32 {
    (*ptr).physics.event_words.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_events_len(ptr: *const EngineCore) -> usize {
    (*ptr).physics.event_words.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_rich_events_ptr(ptr: *const EngineCore) -> *const u32 {
    (*ptr).physics.rich_event_words.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_rich_events_len(ptr: *const EngineCore) -> usize {
    (*ptr).physics.rich_event_words.len()
}

fn decode_query_shape(kind: u32, a: f32, b: f32, c: f32) -> Collider3D {
    match kind {
        0 => Collider3D::Aabb { half_extents: Vec3::new(a, b, c) },
        1 => Collider3D::Sphere { radius: a },
        3 => Collider3D::Cylinder { radius: a, half_height: b },
        _ => Collider3D::Capsule { radius: a, half_height: b },
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_overlap_shape(
    ptr: *mut EngineCore,
    kind: u32,
    px: f32,
    py: f32,
    pz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
    rw: f32,
    a: f32,
    b: f32,
    c: f32,
    mask: u32,
    include_triggers: u32,
) -> usize {
    let core = &mut *ptr;
    let shape = decode_query_shape(kind, a, b, c);
    core.physics
        .overlap_shape(
            &core.world,
            shape,
            Vec3::new(px, py, pz),
            Quat::from_xyzw(rx, ry, rz, rw).normalize(),
            mask,
            include_triggers != 0,
        )
        .len()
}

#[no_mangle]
pub unsafe extern "C" fn core_overlap_results_ptr(ptr: *const EngineCore) -> *const EntityHandle {
    (*ptr).physics.overlap_results.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_sweep_shape(
    ptr: *const EngineCore,
    kind: u32,
    ox: f32,
    oy: f32,
    oz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
    rw: f32,
    a: f32,
    b: f32,
    c: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    max_dist: f32,
    mask: u32,
    ignore_entity: EntityHandle,
    out_buf: *mut f32,
) -> EntityHandle {
    let core = &*ptr;
    let shape = decode_query_shape(kind, a, b, c);
    let Some(hit) = core.physics.sweep_shape(
        &core.world,
        shape,
        Vec3::new(ox, oy, oz),
        Quat::from_xyzw(rx, ry, rz, rw).normalize(),
        Vec3::new(dx, dy, dz),
        max_dist,
        mask,
        ignore_entity,
    ) else {
        return 0;
    };
    if !out_buf.is_null() {
        let out = std::slice::from_raw_parts_mut(out_buf, 7);
        out[0] = hit.distance;
        out[1] = hit.point.x;
        out[2] = hit.point.y;
        out[3] = hit.point.z;
        out[4] = hit.normal.x;
        out[5] = hit.normal.y;
        out[6] = hit.normal.z;
    }
    hit.entity
}

#[no_mangle]
pub unsafe extern "C" fn core_build_physics_debug_lines(ptr: *mut EngineCore) -> usize {
    let core = &mut *ptr;
    core.physics.build_debug_lines(&core.world).len()
}

#[no_mangle]
pub unsafe extern "C" fn core_physics_debug_lines_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).physics.debug_lines.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_parse_glb(
    ptr: *mut EngineCore,
    bytes_ptr: *const u8,
    bytes_len: usize,
) -> i32 {
    let core = &mut *ptr;
    if bytes_ptr.is_null() || bytes_len == 0 {
        return -1;
    }
    let slice = std::slice::from_raw_parts(bytes_ptr, bytes_len);
    match parse_glb(slice) {
        Ok(parsed) => {
            core.glb_bounds[0..3].copy_from_slice(&parsed.bounds_min);
            core.glb_bounds[3..6].copy_from_slice(&parsed.bounds_max);
            core.last_glb = Some(parsed);
            0
        }
        Err(_) => -2,
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_vertices_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.vertices.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_vertices_len(ptr: *const EngineCore) -> usize {
    (*ptr).last_glb.as_ref().map_or(0, |g| g.vertices.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_indices_ptr(ptr: *const EngineCore) -> *const u32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.indices.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_indices_len(ptr: *const EngineCore) -> usize {
    (*ptr).last_glb.as_ref().map_or(0, |g| g.indices.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_submeshes_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.submesh_floats.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_submeshes_len(ptr: *const EngineCore) -> usize {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(0, |g| g.submesh_floats.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_bounds_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).glb_bounds.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_joints_ptr(ptr: *const EngineCore) -> *const u16 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.joints.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_joints_len(ptr: *const EngineCore) -> usize {
    (*ptr).last_glb.as_ref().map_or(0, |g| g.joints.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_weights_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.weights.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_weights_len(ptr: *const EngineCore) -> usize {
    (*ptr).last_glb.as_ref().map_or(0, |g| g.weights.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_image_count(ptr: *const EngineCore) -> usize {
    (*ptr).last_glb.as_ref().map_or(0, |g| g.images.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_image_ptr(ptr: *const EngineCore, idx: usize) -> *const u8 {
    (*ptr)
        .last_glb
        .as_ref()
        .and_then(|g| g.images.get(idx))
        .map_or(std::ptr::null(), |img| img.bytes.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_image_len(ptr: *const EngineCore, idx: usize) -> usize {
    (*ptr)
        .last_glb
        .as_ref()
        .and_then(|g| g.images.get(idx))
        .map_or(0, |img| img.bytes.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_image_mime_ptr(ptr: *const EngineCore, idx: usize) -> *const u8 {
    (*ptr)
        .last_glb
        .as_ref()
        .and_then(|g| g.images.get(idx))
        .map_or(std::ptr::null(), |img| img.mime_type.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_image_mime_len(ptr: *const EngineCore, idx: usize) -> usize {
    (*ptr)
        .last_glb
        .as_ref()
        .and_then(|g| g.images.get(idx))
        .map_or(0, |img| img.mime_type.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_triggers_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.trigger_floats.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_triggers_len(ptr: *const EngineCore) -> usize {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(0, |g| g.trigger_floats.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_collider_tris_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(std::ptr::null(), |g| g.collider_triangles.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_collider_tris_len(ptr: *const EngineCore) -> usize {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(0, |g| g.collider_triangles.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_has_skeleton(ptr: *const EngineCore) -> i32 {
    (*ptr)
        .last_glb
        .as_ref()
        .map_or(0, |g| if g.skeleton.is_some() { 1 } else { 0 })
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_clip_count(ptr: *const EngineCore) -> usize {
    (*ptr).last_glb.as_ref().map_or(0, |g| g.clips.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_clip_name_ptr(ptr: *const EngineCore, idx: usize) -> *const u8 {
    (*ptr)
        .last_glb
        .as_ref()
        .and_then(|g| g.clips.get(idx))
        .map_or(std::ptr::null(), |c| c.name.as_ptr())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_clip_name_len(ptr: *const EngineCore, idx: usize) -> usize {
    (*ptr)
        .last_glb
        .as_ref()
        .and_then(|g| g.clips.get(idx))
        .map_or(0, |c| c.name.len())
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_register_animations(
    ptr: *mut EngineCore,
    out_first_clip_id: *mut u32,
) -> i32 {
    let core = &mut *ptr;
    let Some(glb) = core.last_glb.as_ref() else {
        return -1;
    };
    let Some(skel) = glb.skeleton.clone() else {
        return -1;
    };
    let skel_id = core.animations.register_skeleton(skel);
    let mut first_clip = 0u32;
    for (i, clip) in glb.clips.iter().cloned().enumerate() {
        let cid = core.animations.register_clip(skel_id, clip);
        if i == 0 {
            first_clip = cid;
        }
    }
    if !out_first_clip_id.is_null() {
        *out_first_clip_id = first_clip;
    }
    skel_id as i32
}

#[no_mangle]
pub unsafe extern "C" fn core_play_animation(
    ptr: *mut EngineCore,
    entity: EntityHandle,
    skeleton_id: u32,
    clip_id: u32,
    speed: f32,
    looping: i32,
    fade_sec: f32,
) {
    (*ptr).animations.play_on_entity(
        entity,
        skeleton_id,
        clip_id,
        speed,
        looping != 0,
        fade_sec,
    );
}

#[no_mangle]
pub unsafe extern "C" fn core_bone_palettes_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).animations.bone_palettes.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_bone_palettes_len(ptr: *const EngineCore) -> usize {
    (*ptr).animations.bone_palettes.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_palette_offsets_ptr(ptr: *const EngineCore) -> *const i32 {
    (*ptr).animations.entity_palette_offsets.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_palette_offsets_len(ptr: *const EngineCore) -> usize {
    (*ptr).animations.entity_palette_offsets.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_glb_clear(ptr: *mut EngineCore) {
    (*ptr).last_glb = None;
}

// ---------- GPU Particle System 2.0 ----------

#[no_mangle]
pub unsafe extern "C" fn core_spawn_particle(
    ptr: *mut EngineCore,
    px: f32,
    py: f32,
    pz: f32,
    vx: f32,
    vy: f32,
    vz: f32,
    size_start: f32,
    size_end: f32,
    r0: f32,
    g0: f32,
    b0: f32,
    a0: f32,
    r1: f32,
    g1: f32,
    b1: f32,
    a1: f32,
    life: f32,
    gravity: f32,
    drag: f32,
    bounce: f32,
    floor_y: f32,
    additive: u32,
    stretch: f32,
) {
    (*ptr).particles.spawn(
        Vec3::new(px, py, pz),
        Vec3::new(vx, vy, vz),
        size_start,
        size_end,
        [r0, g0, b0, a0],
        [r1, g1, b1, a1],
        life,
        gravity,
        drag,
        bounce,
        floor_y,
        additive != 0,
        stretch,
    );
}

#[no_mangle]
pub unsafe extern "C" fn core_particles_alpha_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).particles.packed_alpha.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_particles_alpha_len(ptr: *const EngineCore) -> usize {
    (*ptr).particles.packed_alpha.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_particles_add_ptr(ptr: *const EngineCore) -> *const f32 {
    (*ptr).particles.packed_additive.as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn core_particles_add_len(ptr: *const EngineCore) -> usize {
    (*ptr).particles.packed_additive.len()
}

#[no_mangle]
pub unsafe extern "C" fn core_particles_count(ptr: *const EngineCore) -> usize {
    (*ptr).particles.active_count()
}

// ---------- Verlet Cloth & Rope Grids ----------

#[no_mangle]
pub unsafe extern "C" fn core_create_cloth(
    ptr: *mut EngineCore,
    ox: f32,
    oy: f32,
    oz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
    dx: f32,
    dy: f32,
    dz: f32,
    cols: u32,
    rows: u32,
    pin_top: u32,
    pin_left: u32,
) -> u32 {
    (*ptr).cloth.add_grid(ClothGrid::new(
        Vec3::new(ox, oy, oz),
        Vec3::new(rx, ry, rz),
        Vec3::new(dx, dy, dz),
        cols as usize,
        rows as usize,
        pin_top != 0,
        pin_left != 0,
    ))
}

#[no_mangle]
pub unsafe extern "C" fn core_set_cloth_wind(
    ptr: *mut EngineCore,
    cloth_id: u32,
    wx: f32,
    wy: f32,
    wz: f32,
) {
    let core = &mut *ptr;
    if let Some(g) = core.cloth.grids.get_mut(cloth_id as usize) {
        g.wind = Vec3::new(wx, wy, wz);
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_push_cloth_sphere(
    ptr: *mut EngineCore,
    cloth_id: u32,
    cx: f32,
    cy: f32,
    cz: f32,
    radius: f32,
) {
    let core = &mut *ptr;
    if let Some(g) = core.cloth.grids.get_mut(cloth_id as usize) {
        g.push_sphere(Vec3::new(cx, cy, cz), radius);
    }
}

#[no_mangle]
pub unsafe extern "C" fn core_cloth_verts_ptr(ptr: *const EngineCore, cloth_id: u32) -> *const f32 {
    let core = &*ptr;
    core.cloth
        .grids
        .get(cloth_id as usize)
        .map(|g| g.vertex_buf.as_ptr())
        .unwrap_or(std::ptr::null())
}

#[no_mangle]
pub unsafe extern "C" fn core_cloth_verts_len(ptr: *const EngineCore, cloth_id: u32) -> usize {
    let core = &*ptr;
    core.cloth
        .grids
        .get(cloth_id as usize)
        .map(|g| g.vertex_buf.len())
        .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn core_cloth_indices_ptr(ptr: *const EngineCore, cloth_id: u32) -> *const u32 {
    let core = &*ptr;
    core.cloth
        .grids
        .get(cloth_id as usize)
        .map(|g| g.index_buf.as_ptr())
        .unwrap_or(std::ptr::null())
}

#[no_mangle]
pub unsafe extern "C" fn core_cloth_indices_len(ptr: *const EngineCore, cloth_id: u32) -> usize {
    let core = &*ptr;
    core.cloth
        .grids
        .get(cloth_id as usize)
        .map(|g| g.index_buf.len())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_abi_version_and_lifecycle() {
        assert_eq!(core_abi_version(), 1);
        let core = core_create();
        assert!(!core.is_null());
        unsafe { core_destroy(core) };
    }

    #[test]
    fn test_allocator_roundtrip() {
        let ptr = quark_alloc(64);
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::write_bytes(ptr, 0xAB, 64);
            assert_eq!(*ptr, 0xAB);
            quark_dealloc(ptr, 64);
        }
    }

    #[test]
    fn test_c_abi_glb_and_step_roundtrip() {
        let core = core_create();
        let glb = gltf_loader::tests::make_minimal_triangle_glb();
        unsafe {
            let status = core_parse_glb(core, glb.as_ptr(), glb.len());
            assert_eq!(status, 0);
            assert_eq!(core_glb_vertices_len(core), 24);
            assert_eq!(core_glb_indices_len(core), 3);
            core_glb_clear(core);
            assert_eq!(core_glb_vertices_len(core), 0);

            let e = core_spawn(core);
            core_set_transform(core, e, 0.0, 0.0, -5.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1);
            core_set_mesh_3d(core, e, 7, 2, 0, 1.0);
            let vp = Mat4::perspective_rh_gl(60f32.to_radians(), 1.0, 0.1, 100.0)
                * Mat4::look_at_rh(Vec3::ZERO, Vec3::NEG_Z, Vec3::Y);
            core_step(core, 1.0 / 60.0, vp.to_cols_array().as_ptr());
            assert_eq!(core_render_3d_len(core), 4);
            core_destroy(core);
        }
    }
}
