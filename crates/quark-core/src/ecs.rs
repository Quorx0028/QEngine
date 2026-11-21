use glam::{Mat4, Quat, Vec2, Vec3};

pub type EntityHandle = u32;
pub const INVALID_ENTITY: EntityHandle = 0;

const INDEX_BITS: u32 = 20;
const INDEX_MASK: u32 = (1 << INDEX_BITS) - 1;
const MAX_GEN: u16 = 4095;

#[inline]
pub fn entity_index(handle: EntityHandle) -> usize {
    (handle & INDEX_MASK) as usize
}

#[inline]
fn entity_gen(handle: EntityHandle) -> u16 {
    (handle >> INDEX_BITS) as u16
}

#[inline]
fn pack_entity(index: usize, generation: u16) -> EntityHandle {
    ((generation as u32) << INDEX_BITS) | ((index as u32) & INDEX_MASK)
}

#[derive(Clone, Copy, Debug)]
pub struct RigidBody {
    pub dynamic: bool,
    pub gravity_scale: f32,
    pub restitution: f32,
    pub friction: f32,
    pub grounded: bool,
}

impl Default for RigidBody {
    fn default() -> Self {
        Self {
            dynamic: true,
            gravity_scale: 1.0,
            restitution: 0.0,
            friction: 0.85,
            grounded: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Collider3D {
    Aabb { half_extents: Vec3 },
    Sphere { radius: f32 },
    Capsule { radius: f32, half_height: f32 },
}

#[derive(Clone, Copy, Debug)]
pub enum Collider2D {
    Aabb2D { half_extents: Vec2 },
    Circle2D { radius: f32 },
}

#[derive(Clone, Copy, Debug)]
pub struct Sprite2D {
    pub size: Vec2,
    pub uv_min: Vec2,
    pub uv_max: Vec2,
    pub color: [f32; 4],
    pub tex_id: u32,
    pub layer: i32,
}

#[derive(Clone, Copy, Debug)]
pub struct MeshInstance3D {
    pub mesh_id: u32,
    pub material_id: u32,
    pub flags: u32,
    pub bounds_radius: f32,
}

pub struct World {
    pub alive: Vec<bool>,
    pub generations: Vec<u16>,
    free_list: Vec<usize>,
    pub parents: Vec<EntityHandle>,

    pub prev_pos: Vec<Vec3>,
    pub curr_pos: Vec<Vec3>,
    pub prev_rot: Vec<Quat>,
    pub curr_rot: Vec<Quat>,
    pub scale: Vec<Vec3>,
    pub velocities: Vec<Vec3>,

    pub rigid_bodies: Vec<Option<RigidBody>>,
    pub colliders_3d: Vec<Option<Collider3D>>,
    pub colliders_2d: Vec<Option<Collider2D>>,
    pub sprites_2d: Vec<Option<Sprite2D>>,
    pub meshes_3d: Vec<Option<MeshInstance3D>>,

    pub world_matrices: Vec<f32>,
    local_scratch: Vec<Mat4>,
    world_scratch: Vec<Mat4>,
    resolved_scratch: Vec<u8>,
}

impl World {
    pub fn new() -> Self {
        Self {
            alive: Vec::new(),
            generations: Vec::new(),
            free_list: Vec::new(),
            parents: Vec::new(),
            prev_pos: Vec::new(),
            curr_pos: Vec::new(),
            prev_rot: Vec::new(),
            curr_rot: Vec::new(),
            scale: Vec::new(),
            velocities: Vec::new(),
            rigid_bodies: Vec::new(),
            colliders_3d: Vec::new(),
            colliders_2d: Vec::new(),
            sprites_2d: Vec::new(),
            meshes_3d: Vec::new(),
            world_matrices: Vec::new(),
            local_scratch: Vec::new(),
            world_scratch: Vec::new(),
            resolved_scratch: Vec::new(),
        }
    }

    pub fn alive_count(&self) -> usize {
        self.alive.iter().filter(|&&a| a).count()
    }

    pub fn slot_count(&self) -> usize {
        self.alive.len()
    }

    pub fn is_alive(&self, handle: EntityHandle) -> bool {
        if handle == INVALID_ENTITY {
            return false;
        }
        let idx = entity_index(handle);
        let generation = entity_gen(handle);
        idx < self.alive.len() && self.alive[idx] && self.generations[idx] == generation
    }

    pub fn spawn(&mut self) -> EntityHandle {
        if let Some(idx) = self.free_list.pop() {
            self.alive[idx] = true;
            self.reset_slot(idx);
            return pack_entity(idx, self.generations[idx]);
        }
        let idx = self.alive.len();
        if idx > INDEX_MASK as usize {
            return INVALID_ENTITY;
        }
        self.alive.push(true);
        self.generations.push(1);
        self.parents.push(INVALID_ENTITY);
        self.prev_pos.push(Vec3::ZERO);
        self.curr_pos.push(Vec3::ZERO);
        self.prev_rot.push(Quat::IDENTITY);
        self.curr_rot.push(Quat::IDENTITY);
        self.scale.push(Vec3::ONE);
        self.velocities.push(Vec3::ZERO);
        self.rigid_bodies.push(None);
        self.colliders_3d.push(None);
        self.colliders_2d.push(None);
        self.sprites_2d.push(None);
        self.meshes_3d.push(None);
        self.world_matrices
            .extend_from_slice(&Mat4::IDENTITY.to_cols_array());
        self.local_scratch.push(Mat4::IDENTITY);
        self.world_scratch.push(Mat4::IDENTITY);
        self.resolved_scratch.push(0);
        pack_entity(idx, 1)
    }

    fn reset_slot(&mut self, idx: usize) {
        self.parents[idx] = INVALID_ENTITY;
        self.prev_pos[idx] = Vec3::ZERO;
        self.curr_pos[idx] = Vec3::ZERO;
        self.prev_rot[idx] = Quat::IDENTITY;
        self.curr_rot[idx] = Quat::IDENTITY;
        self.scale[idx] = Vec3::ONE;
        self.velocities[idx] = Vec3::ZERO;
        self.rigid_bodies[idx] = None;
        self.colliders_3d[idx] = None;
        self.colliders_2d[idx] = None;
        self.sprites_2d[idx] = None;
        self.meshes_3d[idx] = None;
        let offset = idx * 16;
        self.world_matrices[offset..offset + 16].copy_from_slice(&Mat4::IDENTITY.to_cols_array());
    }

    pub fn despawn(&mut self, handle: EntityHandle) -> bool {
        if !self.is_alive(handle) {
            return false;
        }
        let idx = entity_index(handle);
        self.alive[idx] = false;
        let next_gen = if self.generations[idx] >= MAX_GEN {
            1
        } else {
            self.generations[idx] + 1
        };
        self.generations[idx] = next_gen;
        self.reset_slot(idx);
        // Detach any children so they do not point to a dead parent slot.
        for p in &mut self.parents {
            if *p == handle {
                *p = INVALID_ENTITY;
            }
        }
        self.free_list.push(idx);
        true
    }

    pub fn set_parent(&mut self, child: EntityHandle, parent: EntityHandle) -> bool {
        if !self.is_alive(child) {
            return false;
        }
        if parent == INVALID_ENTITY {
            self.parents[entity_index(child)] = INVALID_ENTITY;
            return true;
        }
        if !self.is_alive(parent) || child == parent {
            return false;
        }
        // Prevent hierarchy cycles.
        let mut cursor = parent;
        let mut hops = 0usize;
        while cursor != INVALID_ENTITY && self.is_alive(cursor) && hops < self.alive.len() {
            if cursor == child {
                return false;
            }
            cursor = self.parents[entity_index(cursor)];
            hops += 1;
        }
        self.parents[entity_index(child)] = parent;
        true
    }

    pub fn set_prev_transform(&mut self, handle: EntityHandle, pos: Vec3, rot: Quat) -> bool {
        if !self.is_alive(handle) {
            return false;
        }
        let idx = entity_index(handle);
        self.prev_pos[idx] = pos;
        self.prev_rot[idx] = rot.normalize();
        true
    }

    pub fn set_curr_transform(
        &mut self,
        handle: EntityHandle,
        pos: Vec3,
        rot: Quat,
        scale: Vec3,
    ) -> bool {
        if !self.is_alive(handle) {
            return false;
        }
        let idx = entity_index(handle);
        self.curr_pos[idx] = pos;
        self.curr_rot[idx] = rot.normalize();
        self.scale[idx] = scale;
        true
    }

    pub fn set_transform_immediate(
        &mut self,
        handle: EntityHandle,
        pos: Vec3,
        rot: Quat,
        scale: Vec3,
    ) -> bool {
        if !self.is_alive(handle) {
            return false;
        }
        let idx = entity_index(handle);
        let norm_rot = rot.normalize();
        self.prev_pos[idx] = pos;
        self.curr_pos[idx] = pos;
        self.prev_rot[idx] = norm_rot;
        self.curr_rot[idx] = norm_rot;
        self.scale[idx] = scale;
        true
    }

    pub fn snapshot_prev_transforms(&mut self) {
        self.prev_pos.copy_from_slice(&self.curr_pos);
        self.prev_rot.copy_from_slice(&self.curr_rot);
    }

    pub fn compute_interpolated_matrices(&mut self, alpha: f32) {
        let a = alpha.clamp(0.0, 1.0);
        let count = self.alive.len();
        for i in 0..count {
            if !self.alive[i] {
                self.resolved_scratch[i] = 2;
                continue;
            }
            let pos = self.prev_pos[i].lerp(self.curr_pos[i], a);
            let rot = self.prev_rot[i].slerp(self.curr_rot[i], a);
            self.local_scratch[i] = Mat4::from_scale_rotation_translation(self.scale[i], rot, pos);
            self.resolved_scratch[i] = 0;
        }

        // Resolve parent chains iteratively without recursion.
        let mut chain = Vec::with_capacity(16);
        for i in 0..count {
            if self.resolved_scratch[i] != 0 {
                continue;
            }
            chain.clear();
            let mut cur = i;
            let mut base_mat = Mat4::IDENTITY;
            while self.resolved_scratch[cur] == 0 {
                self.resolved_scratch[cur] = 1; // visiting
                chain.push(cur);
                let p = self.parents[cur];
                if p == INVALID_ENTITY || !self.is_alive(p) {
                    break;
                }
                let p_idx = entity_index(p);
                if self.resolved_scratch[p_idx] == 2 {
                    base_mat = self.world_scratch[p_idx];
                    break;
                }
                if self.resolved_scratch[p_idx] == 1 {
                    // Cycle fallback.
                    break;
                }
                cur = p_idx;
            }
            let mut acc = base_mat;
            for &idx in chain.iter().rev() {
                acc = acc * self.local_scratch[idx];
                self.world_scratch[idx] = acc;
                self.resolved_scratch[idx] = 2;
                let offset = idx * 16;
                self.world_matrices[offset..offset + 16].copy_from_slice(&acc.to_cols_array());
            }
        }
    }

    pub fn entity_world_matrix(&self, handle: EntityHandle) -> Option<&[f32]> {
        if !self.is_alive(handle) {
            return None;
        }
        let offset = entity_index(handle) * 16;
        Some(&self.world_matrices[offset..offset + 16])
    }

    pub fn clear(&mut self) {
        self.alive.clear();
        self.generations.clear();
        self.free_list.clear();
        self.parents.clear();
        self.prev_pos.clear();
        self.curr_pos.clear();
        self.prev_rot.clear();
        self.curr_rot.clear();
        self.scale.clear();
        self.velocities.clear();
        self.rigid_bodies.clear();
        self.colliders_3d.clear();
        self.colliders_2d.clear();
        self.sprites_2d.clear();
        self.meshes_3d.clear();
        self.world_matrices.clear();
        self.local_scratch.clear();
        self.world_scratch.clear();
        self.resolved_scratch.clear();
    }
}

impl Default for World {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::{Mat4, Quat, Vec3};

    #[test]
    fn test_generational_entity_reuse() {
        let mut world = World::new();
        let e1 = world.spawn();
        assert_ne!(e1, INVALID_ENTITY);
        assert!(world.is_alive(e1));

        assert!(world.despawn(e1));
        assert!(!world.is_alive(e1));
        assert!(!world.despawn(e1));

        let e2 = world.spawn();
        assert_ne!(e1, e2);
        assert!(world.is_alive(e2));
        assert!(!world.is_alive(e1));
        assert_eq!(entity_index(e1), entity_index(e2));
    }

    #[test]
    fn test_transform_interpolation_alpha() {
        let mut world = World::new();
        let e = world.spawn();
        world.set_prev_transform(e, Vec3::ZERO, Quat::IDENTITY);
        world.set_curr_transform(e, Vec3::new(10.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);

        world.compute_interpolated_matrices(0.0);
        let m0 = Mat4::from_cols_slice(world.entity_world_matrix(e).unwrap());
        assert!((m0.w_axis.x - 0.0).abs() < 1e-5);

        world.compute_interpolated_matrices(0.5);
        let m5 = Mat4::from_cols_slice(world.entity_world_matrix(e).unwrap());
        assert!((m5.w_axis.x - 5.0).abs() < 1e-5);

        world.compute_interpolated_matrices(1.0);
        let m10 = Mat4::from_cols_slice(world.entity_world_matrix(e).unwrap());
        assert!((m10.w_axis.x - 10.0).abs() < 1e-5);
    }

    #[test]
    fn test_parent_child_world_matrix() {
        let mut world = World::new();
        let parent = world.spawn();
        let child = world.spawn();
        world.set_transform_immediate(parent, Vec3::new(10.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.set_transform_immediate(child, Vec3::new(0.0, 5.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        assert!(world.set_parent(child, parent));

        world.compute_interpolated_matrices(1.0);
        let mc = Mat4::from_cols_slice(world.entity_world_matrix(child).unwrap());
        assert!((mc.w_axis.x - 10.0).abs() < 1e-5);
        assert!((mc.w_axis.y - 5.0).abs() < 1e-5);
        assert!((mc.w_axis.z - 0.0).abs() < 1e-5);
    }

    #[test]
    fn test_despawn_parent_detaches_child() {
        let mut world = World::new();
        let parent = world.spawn();
        let child = world.spawn();
        world.set_transform_immediate(parent, Vec3::new(4.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.set_transform_immediate(child, Vec3::new(1.0, 2.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        assert!(world.set_parent(child, parent));
        assert!(world.despawn(parent));
        assert_eq!(world.parents[entity_index(child)], INVALID_ENTITY);
        world.compute_interpolated_matrices(1.0);
        let mc = Mat4::from_cols_slice(world.entity_world_matrix(child).unwrap());
        assert!((mc.w_axis.x - 1.0).abs() < 1e-5);
    }
}
