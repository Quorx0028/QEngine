use crate::ecs::{entity_index, EntityHandle, World};
use glam::{Mat4, Quat, Vec3};

pub const MAX_BONES: usize = 64;

#[derive(Clone, Debug)]
pub struct SkeletonData {
    pub joint_count: usize,
    pub parent_indices: Vec<i32>,
    pub rest_translations: Vec<Vec3>,
    pub rest_rotations: Vec<Quat>,
    pub rest_scales: Vec<Vec3>,
    pub inverse_bind_matrices: Vec<Mat4>,
}

#[derive(Clone, Debug)]
pub struct AnimChannel {
    pub joint_index: usize,
    pub times: Vec<f32>,
    pub translations: Option<Vec<Vec3>>,
    pub rotations: Option<Vec<Quat>>,
    pub scales: Option<Vec<Vec3>>,
}

#[derive(Clone, Debug)]
pub struct AnimationClipData {
    pub name: String,
    pub duration: f32,
    pub channels: Vec<AnimChannel>,
}

#[derive(Clone, Copy, Debug)]
pub struct EntityAnimState {
    pub skeleton_id: u32,
    pub clip_id: u32,
    pub time: f32,
    pub speed: f32,
    pub looping: bool,
    pub prev_clip_id: Option<u32>,
    pub prev_time: f32,
    pub fade_elapsed: f32,
    pub fade_duration: f32,
}

pub struct AnimationSystem {
    pub skeletons: Vec<SkeletonData>,
    pub clips: Vec<(u32, AnimationClipData)>, // (skeleton_id, clip)
    pub entity_states: Vec<Option<EntityAnimState>>,
    pub entity_palette_offsets: Vec<i32>,
    pub bone_palettes: Vec<f32>,
    local_t: Vec<Vec3>,
    local_r: Vec<Quat>,
    local_s: Vec<Vec3>,
    prev_t: Vec<Vec3>,
    prev_r: Vec<Quat>,
    prev_s: Vec<Vec3>,
    global_mats: Vec<Mat4>,
}

impl AnimationSystem {
    pub fn new() -> Self {
        Self {
            skeletons: Vec::new(),
            clips: Vec::new(),
            entity_states: Vec::new(),
            entity_palette_offsets: Vec::new(),
            bone_palettes: Vec::new(),
            local_t: vec![Vec3::ZERO; MAX_BONES],
            local_r: vec![Quat::IDENTITY; MAX_BONES],
            local_s: vec![Vec3::ONE; MAX_BONES],
            prev_t: vec![Vec3::ZERO; MAX_BONES],
            prev_r: vec![Quat::IDENTITY; MAX_BONES],
            prev_s: vec![Vec3::ONE; MAX_BONES],
            global_mats: vec![Mat4::IDENTITY; MAX_BONES],
        }
    }

    pub fn clear(&mut self) {
        self.skeletons.clear();
        self.clips.clear();
        self.entity_states.clear();
        self.entity_palette_offsets.clear();
        self.bone_palettes.clear();
    }

    pub fn register_skeleton(&mut self, skeleton: SkeletonData) -> u32 {
        let id = self.skeletons.len() as u32;
        self.skeletons.push(skeleton);
        id
    }

    pub fn register_clip(&mut self, skeleton_id: u32, clip: AnimationClipData) -> u32 {
        let id = self.clips.len() as u32;
        self.clips.push((skeleton_id, clip));
        id
    }

    pub fn play_on_entity(
        &mut self,
        entity: EntityHandle,
        skeleton_id: u32,
        clip_id: u32,
        speed: f32,
        looping: bool,
        fade_sec: f32,
    ) {
        let idx = entity_index(entity);
        if idx >= self.entity_states.len() {
            self.entity_states.resize(idx + 1, None);
        }
        let prev = self.entity_states[idx];
        let (prev_clip_id, prev_time, fade_duration) = if fade_sec > 0.001 {
            if let Some(p) = prev {
                (Some(p.clip_id), p.time, fade_sec)
            } else {
                (None, 0.0, 0.0)
            }
        } else {
            (None, 0.0, 0.0)
        };

        self.entity_states[idx] = Some(EntityAnimState {
            skeleton_id,
            clip_id,
            time: 0.0,
            speed,
            looping,
            prev_clip_id,
            prev_time,
            fade_elapsed: 0.0,
            fade_duration,
        });
    }

    pub fn sample_into(
        &mut self,
        skeleton_id: u32,
        clip_id: u32,
        time: f32,
        looping: bool,
        out_matrices: &mut [f32],
    ) {
        let Some(skel) = self.skeletons.get(skeleton_id as usize) else {
            return;
        };
        let n = skel.joint_count.min(MAX_BONES);
        for j in 0..n {
            self.local_t[j] = skel.rest_translations[j];
            self.local_r[j] = skel.rest_rotations[j];
            self.local_s[j] = skel.rest_scales[j];
        }

        if let Some((_, clip)) = self.clips.get(clip_id as usize) {
            sample_clip_pose(
                clip,
                time,
                looping,
                n,
                &mut self.local_t,
                &mut self.local_r,
                &mut self.local_s,
            );
        }

        build_skin_palette(
            skel,
            n,
            &self.local_t,
            &self.local_r,
            &self.local_s,
            &mut self.global_mats,
            out_matrices,
        );
    }

    pub fn step(&mut self, world: &World, dt: f32) {
        let slot_count = world.alive.len();
        self.entity_palette_offsets.resize(slot_count, -1);
        self.entity_palette_offsets.fill(-1);
        self.bone_palettes.clear();

        if self.entity_states.len() < slot_count {
            self.entity_states.resize(slot_count, None);
        }

        for i in 0..slot_count {
            if !world.alive[i] {
                self.entity_states[i] = None;
                continue;
            }
            let Some(mut st) = self.entity_states[i] else {
                continue;
            };
            st.time += dt * st.speed;
            if st.prev_clip_id.is_some() {
                st.prev_time += dt * st.speed;
                st.fade_elapsed += dt;
                if st.fade_elapsed >= st.fade_duration {
                    st.prev_clip_id = None;
                }
            }
            self.entity_states[i] = Some(st);

            let Some(skel) = self.skeletons.get(st.skeleton_id as usize) else {
                continue;
            };
            let n = skel.joint_count.min(MAX_BONES);
            for j in 0..n {
                self.local_t[j] = skel.rest_translations[j];
                self.local_r[j] = skel.rest_rotations[j];
                self.local_s[j] = skel.rest_scales[j];
            }
            if let Some((_, clip)) = self.clips.get(st.clip_id as usize) {
                sample_clip_pose(
                    clip,
                    st.time,
                    st.looping,
                    n,
                    &mut self.local_t,
                    &mut self.local_r,
                    &mut self.local_s,
                );
            }

            if let Some(prev_id) = st.prev_clip_id {
                for j in 0..n {
                    self.prev_t[j] = skel.rest_translations[j];
                    self.prev_r[j] = skel.rest_rotations[j];
                    self.prev_s[j] = skel.rest_scales[j];
                }
                if let Some((_, prev_clip)) = self.clips.get(prev_id as usize) {
                    sample_clip_pose(
                        prev_clip,
                        st.prev_time,
                        true,
                        n,
                        &mut self.prev_t,
                        &mut self.prev_r,
                        &mut self.prev_s,
                    );
                }
                let blend = (st.fade_elapsed / st.fade_duration.max(1e-4)).clamp(0.0, 1.0);
                for j in 0..n {
                    self.local_t[j] = self.prev_t[j].lerp(self.local_t[j], blend);
                    self.local_r[j] = self.prev_r[j].slerp(self.local_r[j], blend);
                    self.local_s[j] = self.prev_s[j].lerp(self.local_s[j], blend);
                }
            }

            let offset = self.bone_palettes.len();
            self.entity_palette_offsets[i] = offset as i32;
            self.bone_palettes.resize(offset + n * 16, 0.0);
            build_skin_palette(
                skel,
                n,
                &self.local_t,
                &self.local_r,
                &self.local_s,
                &mut self.global_mats,
                &mut self.bone_palettes[offset..offset + n * 16],
            );
        }
    }

    pub fn get_bone_world_matrix(
        &self,
        world: &World,
        entity: EntityHandle,
        joint_index: usize,
    ) -> Option<Mat4> {
        if !world.is_alive(entity) {
            return None;
        }
        let slot = entity_index(entity);
        let st = self.entity_states.get(slot).and_then(|s| *s)?;
        let skel = self.skeletons.get(st.skeleton_id as usize)?;
        if joint_index >= skel.joint_count {
            return None;
        }
        let p_off = *self.entity_palette_offsets.get(slot)?;
        if p_off < 0 {
            return None;
        }
        let start = p_off as usize + joint_index * 16;
        if start + 16 > self.bone_palettes.len() {
            return None;
        }
        let skin = Mat4::from_cols_slice(&self.bone_palettes[start..start + 16]);
        let inv_bind = skel.inverse_bind_matrices[joint_index];
        let local_global = skin * inv_bind.inverse();
        let w_off = slot * 16;
        let entity_world = Mat4::from_cols_slice(&world.world_matrices[w_off..w_off + 16]);
        Some(entity_world * local_global)
    }
}

impl Default for AnimationSystem {
    fn default() -> Self {
        Self::new()
    }
}

fn sample_clip_pose(
    clip: &AnimationClipData,
    raw_time: f32,
    looping: bool,
    joint_limit: usize,
    out_t: &mut [Vec3],
    out_r: &mut [Quat],
    out_s: &mut [Vec3],
) {
    let dur = clip.duration.max(1e-5);
    let t = if looping {
        raw_time.rem_euclid(dur)
    } else {
        raw_time.clamp(0.0, dur)
    };

    for ch in &clip.channels {
        if ch.joint_index >= joint_limit || ch.times.is_empty() {
            continue;
        }
        let (i0, i1, alpha) = find_keyframe_pair(&ch.times, t);
        if let Some(vals) = &ch.translations {
            out_t[ch.joint_index] = vals[i0].lerp(vals[i1], alpha);
        }
        if let Some(vals) = &ch.rotations {
            out_r[ch.joint_index] = vals[i0].slerp(vals[i1], alpha);
        }
        if let Some(vals) = &ch.scales {
            out_s[ch.joint_index] = vals[i0].lerp(vals[i1], alpha);
        }
    }
}

fn find_keyframe_pair(times: &[f32], t: f32) -> (usize, usize, f32) {
    if times.len() == 1 || t <= times[0] {
        return (0, 0, 0.0);
    }
    let last = times.len() - 1;
    if t >= times[last] {
        return (last, last, 0.0);
    }
    let idx = times.partition_point(|&x| x <= t).saturating_sub(1).min(last - 1);
    let t0 = times[idx];
    let t1 = times[idx + 1];
    let span = (t1 - t0).max(1e-6);
    (idx, idx + 1, ((t - t0) / span).clamp(0.0, 1.0))
}

fn build_skin_palette(
    skel: &SkeletonData,
    n: usize,
    lt: &[Vec3],
    lr: &[Quat],
    ls: &[Vec3],
    global_mats: &mut [Mat4],
    out_matrices: &mut [f32],
) {
    for j in 0..n {
        let local = Mat4::from_scale_rotation_translation(ls[j], lr[j], lt[j]);
        let p = skel.parent_indices[j];
        global_mats[j] = if p >= 0 && (p as usize) < j {
            global_mats[p as usize] * local
        } else {
            local
        };
        let skin = global_mats[j] * skel.inverse_bind_matrices[j];
        let dst = j * 16;
        if dst + 16 <= out_matrices.len() {
            out_matrices[dst..dst + 16].copy_from_slice(&skin.to_cols_array());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::{Mat4, Quat, Vec3};

    #[test]
    fn test_skeletal_animation_keyframe_interpolation_and_fade() {
        let skeleton = SkeletonData {
            joint_count: 2,
            parent_indices: vec![-1, 0],
            rest_translations: vec![Vec3::ZERO, Vec3::new(0.0, 2.0, 0.0)],
            rest_rotations: vec![Quat::IDENTITY, Quat::IDENTITY],
            rest_scales: vec![Vec3::ONE, Vec3::ONE],
            inverse_bind_matrices: vec![
                Mat4::IDENTITY,
                Mat4::from_translation(Vec3::new(0.0, -2.0, 0.0)),
            ],
        };
        let clip = AnimationClipData {
            name: "Wave".into(),
            duration: 1.0,
            channels: vec![AnimChannel {
                joint_index: 1,
                times: vec![0.0, 1.0],
                translations: Some(vec![Vec3::new(0.0, 2.0, 0.0), Vec3::new(2.0, 2.0, 0.0)]),
                rotations: None,
                scales: None,
            }],
        };

        let mut sys = AnimationSystem::new();
        let skel_id = sys.register_skeleton(skeleton);
        let clip_id = sys.register_clip(skel_id, clip);

        let mut palette = vec![0.0f32; 2 * 16];
        sys.sample_into(skel_id, clip_id, 0.5, true, &mut palette);
        let bone1 = Mat4::from_cols_slice(&palette[16..32]);
        assert!((bone1.w_axis.x - 1.0).abs() < 1e-4, "expected x=1.0, got {}", bone1.w_axis.x);
        assert!((bone1.w_axis.y - 0.0).abs() < 1e-4, "expected y=0.0, got {}", bone1.w_axis.y);
    }

    #[test]
    fn test_bone_world_matrix_socket() {
        let mut world = World::new();
        let e = world.spawn();
        world.set_transform_immediate(e, Vec3::new(10.0, 0.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.compute_interpolated_matrices(1.0);

        let skeleton = SkeletonData {
            joint_count: 1,
            parent_indices: vec![-1],
            rest_translations: vec![Vec3::new(0.0, 2.0, 0.0)],
            rest_rotations: vec![Quat::IDENTITY],
            rest_scales: vec![Vec3::ONE],
            inverse_bind_matrices: vec![Mat4::from_translation(Vec3::new(0.0, -2.0, 0.0))],
        };
        let clip = AnimationClipData {
            name: "Idle".into(),
            duration: 1.0,
            channels: vec![AnimChannel {
                joint_index: 0,
                times: vec![0.0, 1.0],
                translations: Some(vec![Vec3::new(0.0, 3.0, 0.0), Vec3::new(0.0, 3.0, 0.0)]),
                rotations: None,
                scales: None,
            }],
        };
        let mut sys = AnimationSystem::new();
        let skel_id = sys.register_skeleton(skeleton);
        let clip_id = sys.register_clip(skel_id, clip);
        sys.play_on_entity(e, skel_id, clip_id, 1.0, true, 0.0);
        sys.step(&world, 0.1);

        let m = sys.get_bone_world_matrix(&world, e, 0).expect("socket matrix should exist");
        assert!((m.w_axis.x - 10.0).abs() < 1e-4);
        assert!((m.w_axis.y - 3.0).abs() < 1e-4);
    }
}
