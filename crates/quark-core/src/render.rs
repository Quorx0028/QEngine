use crate::ecs::World;
use glam::{Mat4, Vec3, Vec4};

pub const SPRITE_STRIDE_F32: usize = 14;
pub const DRAW_3D_STRIDE_U32: usize = 4;

#[derive(Clone, Copy)]
struct Sort2DEntry {
    slot: usize,
    layer: i32,
    y: f32,
}

#[derive(Clone, Copy)]
struct Sort3DEntry {
    slot: usize,
    mesh_id: u32,
    material_id: u32,
    flags: u32,
}

pub struct RenderQueue {
    pub items_2d: Vec<f32>,
    pub tex_ids_2d: Vec<u32>,
    pub items_3d: Vec<u32>,
    scratch_2d: Vec<Sort2DEntry>,
    scratch_3d: Vec<Sort3DEntry>,
}

impl RenderQueue {
    pub fn new() -> Self {
        Self {
            items_2d: Vec::new(),
            tex_ids_2d: Vec::new(),
            items_3d: Vec::new(),
            scratch_2d: Vec::new(),
            scratch_3d: Vec::new(),
        }
    }

    pub fn build_2d(&mut self, world: &World) {
        self.items_2d.clear();
        self.tex_ids_2d.clear();
        self.scratch_2d.clear();

        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            if let Some(sp) = world.sprites_2d[i] {
                let offset = i * 16;
                let y = world.world_matrices[offset + 13];
                self.scratch_2d.push(Sort2DEntry {
                    slot: i,
                    layer: sp.layer,
                    y,
                });
            }
        }

        // Layer ascending, then Y descending (painter order for top-down 2D/2.5D RPGs).
        self.scratch_2d.sort_by(|a, b| {
            a.layer
                .cmp(&b.layer)
                .then_with(|| b.y.total_cmp(&a.y))
                .then_with(|| a.slot.cmp(&b.slot))
        });

        for entry in &self.scratch_2d {
            let sp = world.sprites_2d[entry.slot].unwrap();
            let offset = entry.slot * 16;
            let m = &world.world_matrices[offset..offset + 16];
            let x = m[12];
            let y = m[13];
            let z = m[14];
            let rot = m[1].atan2(m[0]);
            let sx = (m[0] * m[0] + m[1] * m[1]).sqrt();
            let sy = (m[4] * m[4] + m[5] * m[5]).sqrt();

            self.items_2d.extend_from_slice(&[
                x,
                y,
                z,
                sp.size.x * sx,
                sp.size.y * sy,
                rot,
                sp.uv_min.x,
                sp.uv_min.y,
                sp.uv_max.x,
                sp.uv_max.y,
                sp.color[0],
                sp.color[1],
                sp.color[2],
                sp.color[3],
            ]);
            self.tex_ids_2d.push(sp.tex_id);
        }
    }

    pub fn build_3d(&mut self, world: &World, view_proj: &Mat4) {
        self.items_3d.clear();
        self.scratch_3d.clear();

        let planes = extract_frustum_planes(view_proj);

        for (i, &alive) in world.alive.iter().enumerate() {
            if !alive {
                continue;
            }
            let Some(mesh) = world.meshes_3d[i] else {
                continue;
            };
            let offset = i * 16;
            let m = &world.world_matrices[offset..offset + 16];
            let center = Vec3::new(m[12], m[13], m[14]);
            let sx = Vec3::new(m[0], m[1], m[2]).length();
            let sy = Vec3::new(m[4], m[5], m[6]).length();
            let sz = Vec3::new(m[8], m[9], m[10]).length();
            let radius = mesh.bounds_radius * sx.max(sy).max(sz);

            if radius <= 0.0 || sphere_in_frustum(&planes, center, radius) {
                self.scratch_3d.push(Sort3DEntry {
                    slot: i,
                    mesh_id: mesh.mesh_id,
                    material_id: mesh.material_id,
                    flags: mesh.flags,
                });
            }
        }

        self.scratch_3d.sort_by(|a, b| {
            (a.flags & 1)
                .cmp(&(b.flags & 1))
                .then_with(|| a.material_id.cmp(&b.material_id))
                .then_with(|| a.mesh_id.cmp(&b.mesh_id))
        });

        for entry in &self.scratch_3d {
            self.items_3d.extend_from_slice(&[
                entry.mesh_id,
                entry.material_id,
                entry.slot as u32,
                entry.flags,
            ]);
        }
    }
}

impl Default for RenderQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn extract_frustum_planes(vp: &Mat4) -> [Vec4; 6] {
    let r0 = Vec4::new(vp.x_axis.x, vp.y_axis.x, vp.z_axis.x, vp.w_axis.x);
    let r1 = Vec4::new(vp.x_axis.y, vp.y_axis.y, vp.z_axis.y, vp.w_axis.y);
    let r2 = Vec4::new(vp.x_axis.z, vp.y_axis.z, vp.z_axis.z, vp.w_axis.z);
    let r3 = Vec4::new(vp.x_axis.w, vp.y_axis.w, vp.z_axis.w, vp.w_axis.w);

    let mut planes = [
        r3 + r0,
        r3 - r0,
        r3 + r1,
        r3 - r1,
        r3 + r2,
        r3 - r2,
    ];
    for p in &mut planes {
        let len = Vec3::new(p.x, p.y, p.z).length();
        if len > 1e-6 {
            *p /= len;
        }
    }
    planes
}

fn sphere_in_frustum(planes: &[Vec4; 6], center: Vec3, radius: f32) -> bool {
    for p in planes {
        let dist = p.x * center.x + p.y * center.y + p.z * center.z + p.w;
        if dist < -radius {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecs::{entity_index, MeshInstance3D, Sprite2D, World};
    use glam::{Mat4, Quat, Vec2, Vec3};

    #[test]
    fn test_render_2d_y_and_layer_sorting() {
        let mut world = World::new();
        let mut queue = RenderQueue::new();

        let front = world.spawn();
        world.set_transform_immediate(front, Vec3::new(0.0, 2.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.sprites_2d[entity_index(front)] = Some(Sprite2D {
            size: Vec2::ONE,
            uv_min: Vec2::ZERO,
            uv_max: Vec2::ONE,
            color: [1.0, 0.0, 0.0, 1.0],
            tex_id: 1,
            layer: 0,
        });

        let back = world.spawn();
        world.set_transform_immediate(back, Vec3::new(0.0, 10.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.sprites_2d[entity_index(back)] = Some(Sprite2D {
            size: Vec2::ONE,
            uv_min: Vec2::ZERO,
            uv_max: Vec2::ONE,
            color: [0.0, 1.0, 0.0, 1.0],
            tex_id: 2,
            layer: 0,
        });

        let overlay = world.spawn();
        world.set_transform_immediate(overlay, Vec3::new(0.0, 50.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.sprites_2d[entity_index(overlay)] = Some(Sprite2D {
            size: Vec2::ONE,
            uv_min: Vec2::ZERO,
            uv_max: Vec2::ONE,
            color: [0.0, 0.0, 1.0, 1.0],
            tex_id: 3,
            layer: 1,
        });

        world.compute_interpolated_matrices(1.0);
        queue.build_2d(&world);
        assert_eq!(queue.tex_ids_2d, vec![2, 1, 3]);
        assert_eq!(queue.items_2d.len(), 3 * SPRITE_STRIDE_F32);
    }

    #[test]
    fn test_render_3d_frustum_culling() {
        let mut world = World::new();
        let mut queue = RenderQueue::new();

        let visible = world.spawn();
        world.set_transform_immediate(visible, Vec3::new(0.0, 0.0, -5.0), Quat::IDENTITY, Vec3::ONE);
        world.meshes_3d[entity_index(visible)] = Some(MeshInstance3D {
            mesh_id: 10,
            material_id: 1,
            flags: 0,
            bounds_radius: 1.0,
        });

        let behind = world.spawn();
        world.set_transform_immediate(behind, Vec3::new(0.0, 0.0, 15.0), Quat::IDENTITY, Vec3::ONE);
        world.meshes_3d[entity_index(behind)] = Some(MeshInstance3D {
            mesh_id: 20,
            material_id: 1,
            flags: 0,
            bounds_radius: 1.0,
        });

        world.compute_interpolated_matrices(1.0);
        let proj = Mat4::perspective_rh_gl(60f32.to_radians(), 16.0 / 9.0, 0.1, 100.0);
        let view = Mat4::look_at_rh(Vec3::ZERO, Vec3::NEG_Z, Vec3::Y);
        queue.build_3d(&world, &(proj * view));

        assert_eq!(queue.items_3d.len(), DRAW_3D_STRIDE_U32);
        assert_eq!(queue.items_3d[0], 10);
    }
}
