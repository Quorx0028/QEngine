pub mod ecs;
pub mod gltf_loader;
pub mod physics;
pub mod render;

use ecs::{
    entity_index, Collider2D, Collider3D, EntityHandle, MeshInstance3D, RigidBody, Sprite2D, World,
};
use gltf_loader::{parse_glb, ParsedGlb};
use physics::{PhysicsConfig, PhysicsWorld, TileGrid2D};
use render::RenderQueue;

use glam::{Mat4, Quat, Vec2, Vec3};
use std::alloc::{alloc, dealloc, Layout};

pub const ABI_VERSION: u32 = 1;
const ALLOC_ALIGN: usize = 16;

pub struct EngineCore {
    pub world: World,
    pub physics: PhysicsWorld,
    pub render_queue: RenderQueue,
    pub last_glb: Option<ParsedGlb>,
    pub glb_bounds: [f32; 6],
}

impl EngineCore {
    pub fn new() -> Self {
        Self {
            world: World::new(),
            physics: PhysicsWorld::new(PhysicsConfig::default()),
            render_queue: RenderQueue::new(),
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
            grounded: false,
        });
    }
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
        _ => Collider3D::Capsule {
            radius: a,
            half_height: b,
        },
    };
    core.world.colliders_3d[entity_index(entity)] = Some(col);
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
        _ => Collider2D::Circle2D { radius: a },
    };
    core.world.colliders_2d[entity_index(entity)] = Some(col);
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
    let res = core.physics.step(&mut core.world, frame_dt);
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
    let core = &*ptr;
    let Some(hit) = core.physics.raycast_3d(
        &core.world,
        Vec3::new(ox, oy, oz),
        Vec3::new(dx, dy, dz),
        max_dist,
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
pub unsafe extern "C" fn core_glb_clear(ptr: *mut EngineCore) {
    (*ptr).last_glb = None;
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
