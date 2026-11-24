use crate::ecs::{entity_index, EntityHandle, RigidBody, World, INVALID_ENTITY};
use glam::{Quat, Vec3};

#[derive(Clone, Debug)]
pub enum JointKind {
    Distance {
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        rest_length: f32,
        stiffness: f32,
    },
    Spring {
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        rest_length: f32,
        stiffness: f32,
        damping: f32,
    },
    Hinge {
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        local_axis_a: Vec3,
        local_axis_b: Vec3,
        ref_dir_a: Vec3,
        ref_dir_b: Vec3,
        min_angle: Option<f32>,
        max_angle: Option<f32>,
        motor_speed: f32,
        motor_max_torque: f32,
    },
    BallSocket {
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
    },
    Fixed {
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        rel_rot: Quat,
    },
    Prismatic {
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        local_axis_a: Vec3,
        rel_rot: Quat,
        min_dist: Option<f32>,
        max_dist: Option<f32>,
    },
}

#[derive(Clone, Debug)]
pub struct JointEntry {
    pub id: u32,
    pub break_force: Option<f32>,
    pub last_impulse: f32,
    pub kind: JointKind,
}

#[derive(Default)]
pub struct JointSolver {
    pub joints: Vec<JointEntry>,
    next_id: u32,
}

impl JointSolver {
    pub fn new() -> Self {
        Self {
            joints: Vec::new(),
            next_id: 1,
        }
    }

    pub fn clear(&mut self) {
        self.joints.clear();
        self.next_id = 1;
    }

    pub fn add_distance(
        &mut self,
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        rest_length: f32,
        stiffness: f32,
    ) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.joints.push(JointEntry {
            id,
            break_force: None,
            last_impulse: 0.0,
            kind: JointKind::Distance {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
                rest_length: rest_length.max(0.0),
                stiffness: stiffness.clamp(0.05, 1.0),
            },
        });
        id
    }

    pub fn add_spring(
        &mut self,
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        rest_length: f32,
        stiffness: f32,
        damping: f32,
    ) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.joints.push(JointEntry {
            id,
            break_force: None,
            last_impulse: 0.0,
            kind: JointKind::Spring {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
                rest_length: rest_length.max(0.0),
                stiffness: stiffness.max(0.0),
                damping: damping.max(0.0),
            },
        });
        id
    }

    pub fn add_hinge(
        &mut self,
        world: &World,
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        world_axis: Vec3,
        min_angle: Option<f32>,
        max_angle: Option<f32>,
    ) -> u32 {
        let axis = world_axis.normalize_or_zero();
        let axis = if axis.length_squared() > 0.5 { axis } else { Vec3::Y };
        let rot_a = body_rot(world, entity_a);
        let rot_b = body_rot(world, entity_b);

        let world_ref = if axis.y.abs() < 0.9 { Vec3::Y } else { Vec3::X };
        let tangent = axis.cross(world_ref).normalize_or_zero();

        let id = self.next_id;
        self.next_id += 1;
        self.joints.push(JointEntry {
            id,
            break_force: None,
            last_impulse: 0.0,
            kind: JointKind::Hinge {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
                local_axis_a: rot_a.inverse() * axis,
                local_axis_b: rot_b.inverse() * axis,
                ref_dir_a: rot_a.inverse() * tangent,
                ref_dir_b: rot_b.inverse() * tangent,
                min_angle,
                max_angle,
                motor_speed: 0.0,
                motor_max_torque: 0.0,
            },
        });
        id
    }

    pub fn add_ball_socket(
        &mut self,
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
    ) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.joints.push(JointEntry {
            id,
            break_force: None,
            last_impulse: 0.0,
            kind: JointKind::BallSocket {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
            },
        });
        id
    }

    pub fn add_fixed(
        &mut self,
        world: &World,
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
    ) -> u32 {
        let rot_a = body_rot(world, entity_a);
        let rot_b = body_rot(world, entity_b);
        let rel_rot = (rot_a.conjugate() * rot_b).normalize();
        let id = self.next_id;
        self.next_id += 1;
        self.joints.push(JointEntry {
            id,
            break_force: None,
            last_impulse: 0.0,
            kind: JointKind::Fixed {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
                rel_rot,
            },
        });
        id
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_prismatic(
        &mut self,
        world: &World,
        entity_a: EntityHandle,
        entity_b: EntityHandle,
        anchor_a: Vec3,
        anchor_b: Vec3,
        world_axis: Vec3,
        min_dist: Option<f32>,
        max_dist: Option<f32>,
    ) -> u32 {
        let axis = world_axis.normalize_or_zero();
        let axis = if axis.length_squared() > 0.5 { axis } else { Vec3::Y };
        let rot_a = body_rot(world, entity_a);
        let rot_b = body_rot(world, entity_b);
        let rel_rot = (rot_a.conjugate() * rot_b).normalize();
        let id = self.next_id;
        self.next_id += 1;
        self.joints.push(JointEntry {
            id,
            break_force: None,
            last_impulse: 0.0,
            kind: JointKind::Prismatic {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
                local_axis_a: rot_a.inverse() * axis,
                rel_rot,
                min_dist,
                max_dist,
            },
        });
        id
    }

    pub fn set_hinge_motor(&mut self, joint_id: u32, speed: f32, max_torque: f32) -> bool {
        for j in &mut self.joints {
            if j.id == joint_id {
                if let JointKind::Hinge {
                    motor_speed,
                    motor_max_torque,
                    ..
                } = &mut j.kind
                {
                    *motor_speed = speed;
                    *motor_max_torque = max_torque.max(0.0);
                    return true;
                }
            }
        }
        false
    }

    pub fn set_break_force(&mut self, joint_id: u32, break_force: Option<f32>) -> bool {
        for j in &mut self.joints {
            if j.id == joint_id {
                j.break_force = break_force.map(|f| f.max(0.0));
                return true;
            }
        }
        false
    }

    pub fn remove(&mut self, joint_id: u32) -> bool {
        let before = self.joints.len();
        self.joints.retain(|j| j.id != joint_id);
        self.joints.len() != before
    }

    fn joint_entities(kind: &JointKind) -> (EntityHandle, EntityHandle) {
        match kind {
            JointKind::Distance { entity_a, entity_b, .. }
            | JointKind::Spring { entity_a, entity_b, .. }
            | JointKind::Hinge { entity_a, entity_b, .. }
            | JointKind::BallSocket { entity_a, entity_b, .. }
            | JointKind::Fixed { entity_a, entity_b, .. }
            | JointKind::Prismatic { entity_a, entity_b, .. } => (*entity_a, *entity_b),
        }
    }

    pub fn has_pair(&self, e1: EntityHandle, e2: EntityHandle) -> bool {
        if e1 == INVALID_ENTITY || e2 == INVALID_ENTITY {
            return false;
        }
        self.joints.iter().any(|j| {
            let (a, b) = Self::joint_entities(&j.kind);
            (a == e1 && b == e2) || (a == e2 && b == e1)
        })
    }

    pub fn retain_alive(&mut self, world: &World) {
        self.joints.retain(|j| {
            let (a, b) = Self::joint_entities(&j.kind);
            let a_ok = a == INVALID_ENTITY || world.is_alive(a);
            let b_ok = b == INVALID_ENTITY || world.is_alive(b);
            a_ok && b_ok
        });
    }

    pub fn apply_springs(&self, world: &mut World, dt: f32) {
        for j in &self.joints {
            let JointKind::Spring {
                entity_a,
                entity_b,
                anchor_a,
                anchor_b,
                rest_length,
                stiffness,
                damping,
            } = j.kind
            else {
                continue;
            };
            let (pa, va, inv_ma, lock_a) = body_kinematics(world, entity_a, anchor_a);
            let (pb, vb, inv_mb, lock_b) = body_kinematics(world, entity_b, anchor_b);
            let inv_sum = inv_ma + inv_mb;
            if inv_sum <= 1e-6 {
                continue;
            }
            let delta = pb - pa;
            let dist = delta.length();
            if dist <= 1e-5 {
                continue;
            }
            let dir = delta / dist;
            let stretch = dist - rest_length;
            let rel_v = (vb - va).dot(dir);
            let force_mag = stretch * stiffness + rel_v * damping;
            let impulse = dir * (force_mag * dt);

            apply_body_impulse(world, entity_a, anchor_a, impulse, inv_ma, lock_a);
            apply_body_impulse(world, entity_b, anchor_b, -impulse, inv_mb, lock_b);
        }
    }

    pub fn begin_substep(&mut self) {
        for j in &mut self.joints {
            j.last_impulse = 0.0;
        }
    }

    pub fn break_overloaded(&mut self, dt: f32) {
        let inv_dt = 1.0 / dt.max(1e-4);
        self.joints.retain(|j| {
            j.break_force
                .map_or(true, |bf| (j.last_impulse * inv_dt) <= bf)
        });
    }

    pub fn solve_constraints(&mut self, world: &mut World, dt: f32) {
        let mut i = 0usize;
        while i < self.joints.len() {
            let max_imp = self.joints[i].break_force.map(|bf| bf * dt.max(1e-4));
            let imp = match self.joints[i].kind {
                JointKind::Distance {
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                    rest_length,
                    stiffness,
                } => solve_distance_constraint(
                    world,
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                    rest_length,
                    stiffness,
                    dt,
                    max_imp,
                ),
                JointKind::BallSocket {
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                } => solve_distance_constraint(
                    world, entity_a, entity_b, anchor_a, anchor_b, 0.0, 1.0, dt, max_imp,
                ),
                JointKind::Fixed {
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                    rel_rot,
                } => {
                    let imp = solve_distance_constraint(
                        world, entity_a, entity_b, anchor_a, anchor_b, 0.0, 1.0, dt, max_imp,
                    );
                    if max_imp.map_or(true, |m| imp <= m) {
                        solve_locked_rotation(world, entity_a, entity_b, rel_rot);
                    }
                    imp
                }
                JointKind::Hinge {
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                    local_axis_a,
                    local_axis_b,
                    ref_dir_a,
                    ref_dir_b,
                    min_angle,
                    max_angle,
                    motor_speed,
                    motor_max_torque,
                } => {
                    let imp = solve_distance_constraint(
                        world, entity_a, entity_b, anchor_a, anchor_b, 0.0, 1.0, dt, max_imp,
                    );
                    if max_imp.map_or(true, |m| imp <= m) {
                        solve_hinge_angular(
                            world,
                            entity_a,
                            entity_b,
                            local_axis_a,
                            local_axis_b,
                            ref_dir_a,
                            ref_dir_b,
                            min_angle,
                            max_angle,
                            motor_speed,
                            motor_max_torque,
                            dt,
                        );
                    }
                    imp
                }
                JointKind::Prismatic {
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                    local_axis_a,
                    rel_rot,
                    min_dist,
                    max_dist,
                } => {
                    let imp = solve_prismatic_constraint(
                        world,
                        entity_a,
                        entity_b,
                        anchor_a,
                        anchor_b,
                        local_axis_a,
                        min_dist,
                        max_dist,
                        dt,
                    );
                    if max_imp.map_or(true, |m| imp <= m) {
                        solve_locked_rotation(world, entity_a, entity_b, rel_rot);
                    }
                    imp
                }
                JointKind::Spring { .. } => 0.0,
            };
            self.joints[i].last_impulse += imp;
            if let Some(bf) = self.joints[i].break_force {
                if (self.joints[i].last_impulse / dt.max(1e-4)) > bf {
                    self.joints.swap_remove(i);
                    continue;
                }
            }
            i += 1;
        }
    }
}

fn body_rot(world: &World, handle: EntityHandle) -> Quat {
    if handle == INVALID_ENTITY || !world.is_alive(handle) {
        return Quat::IDENTITY;
    }
    world.curr_rot[entity_index(handle)]
}

fn body_mass(world: &World, idx: usize, rb: RigidBody) -> f32 {
    if rb.density > 0.0 {
        let vol = match world.colliders_3d[idx] {
            Some(crate::ecs::Collider3D::Aabb { half_extents: h }) => {
                8.0 * h.x.max(0.01) * h.y.max(0.01) * h.z.max(0.01)
            }
            Some(crate::ecs::Collider3D::Sphere { radius: r }) => {
                (4.0 / 3.0) * std::f32::consts::PI * r * r * r
            }
            Some(crate::ecs::Collider3D::Capsule { radius: r, half_height: hh }) => {
                std::f32::consts::PI * r * r * (2.0 * hh + (4.0 / 3.0) * r)
            }
            Some(crate::ecs::Collider3D::Cylinder { radius: r, half_height: hh }) => {
                std::f32::consts::PI * r * r * (2.0 * hh)
            }
            _ => rb.mass.max(0.01),
        };
        (vol * rb.density).max(0.01)
    } else {
        rb.mass.max(0.01)
    }
}

fn body_kinematics(world: &World, handle: EntityHandle, local_anchor: Vec3) -> (Vec3, Vec3, f32, bool) {
    if handle == INVALID_ENTITY || !world.is_alive(handle) {
        return (local_anchor, Vec3::ZERO, 0.0, true);
    }
    let idx = entity_index(handle);
    let world_pt = world.curr_pos[idx] + world.curr_rot[idx] * local_anchor;
    let Some(rb) = world.rigid_bodies[idx] else {
        return (world_pt, Vec3::ZERO, 0.0, true);
    };
    if !rb.dynamic {
        return (world_pt, Vec3::ZERO, 0.0, true);
    }
    let com_world = world.curr_pos[idx] + world.curr_rot[idx] * rb.center_of_mass;
    let r = world_pt - com_world;
    let vel = world.velocities[idx] + world.angular_velocities[idx].cross(r);
    (world_pt, vel, 1.0 / body_mass(world, idx, rb), rb.lock_rotation)
}

fn apply_body_impulse(
    world: &mut World,
    handle: EntityHandle,
    local_anchor: Vec3,
    impulse: Vec3,
    inv_m: f32,
    lock_rot: bool,
) {
    if inv_m <= 0.0 || handle == INVALID_ENTITY || !world.is_alive(handle) {
        return;
    }
    let idx = entity_index(handle);
    let com_offset = world.rigid_bodies[idx].map_or(Vec3::ZERO, |r| r.center_of_mass);
    if let Some(rb) = &mut world.rigid_bodies[idx] {
        rb.sleeping = false;
        rb.sleep_timer = 0.0;
    }
    world.velocities[idx] += impulse * inv_m;
    if !lock_rot {
        let r = world.curr_rot[idx] * (local_anchor - com_offset);
        world.angular_velocities[idx] += r.cross(impulse) * (inv_m * 1.5);
    }
}

#[allow(clippy::too_many_arguments)]
fn solve_distance_constraint(
    world: &mut World,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    anchor_a: Vec3,
    anchor_b: Vec3,
    rest_length: f32,
    stiffness: f32,
    dt: f32,
    max_break_impulse: Option<f32>,
) -> f32 {
    let (pa, va, inv_ma, lock_a) = body_kinematics(world, entity_a, anchor_a);
    let (pb, vb, inv_mb, lock_b) = body_kinematics(world, entity_b, anchor_b);
    let inv_sum = inv_ma + inv_mb;
    if inv_sum <= 1e-6 {
        return 0.0;
    }

    let delta = pb - pa;
    let dist = delta.length();
    let error = dist - rest_length;
    if error.abs() < 1e-5 {
        return 0.0;
    }
    let dir = if dist > 1e-6 { delta / dist } else { Vec3::Y };

    let rel_v = (vb - va).dot(dir);
    let bias = (error / dt.max(1e-4)) * 0.15 * stiffness;
    let j_mag = (rel_v + bias) / inv_sum;

    if let Some(limit) = max_break_impulse {
        if j_mag.abs() > limit {
            let clamped = j_mag.clamp(-limit, limit);
            let impulse = dir * clamped;
            apply_body_impulse(world, entity_a, anchor_a, impulse, inv_ma, lock_a);
            apply_body_impulse(world, entity_b, anchor_b, -impulse, inv_mb, lock_b);
            return j_mag.abs();
        }
    }

    let corr = dir * (error * stiffness / inv_sum);
    if inv_ma > 0.0 && entity_a != INVALID_ENTITY && world.is_alive(entity_a) {
        world.curr_pos[entity_index(entity_a)] += corr * inv_ma;
    }
    if inv_mb > 0.0 && entity_b != INVALID_ENTITY && world.is_alive(entity_b) {
        world.curr_pos[entity_index(entity_b)] -= corr * inv_mb;
    }

    let impulse = dir * j_mag;
    apply_body_impulse(world, entity_a, anchor_a, impulse, inv_ma, lock_a);
    apply_body_impulse(world, entity_b, anchor_b, -impulse, inv_mb, lock_b);
    j_mag.abs()
}

fn solve_locked_rotation(
    world: &mut World,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    rel_rot: Quat,
) {
    let dyn_b = entity_b != INVALID_ENTITY
        && world.is_alive(entity_b)
        && world.rigid_bodies[entity_index(entity_b)].map_or(false, |rb| rb.dynamic && !rb.lock_rotation);
    let dyn_a = entity_a != INVALID_ENTITY
        && world.is_alive(entity_a)
        && world.rigid_bodies[entity_index(entity_a)].map_or(false, |rb| rb.dynamic && !rb.lock_rotation);
    let rot_a = body_rot(world, entity_a);
    let rot_b = body_rot(world, entity_b);
    let target_b = (rot_a * rel_rot).normalize();
    if dyn_b && !dyn_a {
        let idx_b = entity_index(entity_b);
        world.curr_rot[idx_b] = target_b;
        world.angular_velocities[idx_b] = if entity_a != INVALID_ENTITY && world.is_alive(entity_a) {
            world.angular_velocities[entity_index(entity_a)]
        } else {
            Vec3::ZERO
        };
    } else if dyn_a && !dyn_b {
        let idx_a = entity_index(entity_a);
        world.curr_rot[idx_a] = (rot_b * rel_rot.conjugate()).normalize();
        world.angular_velocities[idx_a] = Vec3::ZERO;
    } else if dyn_a && dyn_b {
        let idx_a = entity_index(entity_a);
        let idx_b = entity_index(entity_b);
        let mid_b = rot_b.slerp(target_b, 0.5);
        world.curr_rot[idx_b] = mid_b;
        world.curr_rot[idx_a] = (mid_b * rel_rot.conjugate()).normalize();
        let avg_w = 0.5 * (world.angular_velocities[idx_a] + world.angular_velocities[idx_b]);
        world.angular_velocities[idx_a] = avg_w;
        world.angular_velocities[idx_b] = avg_w;
    }
}

#[allow(clippy::too_many_arguments)]
fn solve_prismatic_constraint(
    world: &mut World,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    anchor_a: Vec3,
    anchor_b: Vec3,
    local_axis_a: Vec3,
    min_dist: Option<f32>,
    max_dist: Option<f32>,
    dt: f32,
) -> f32 {
    let (pa, va, inv_ma, lock_a) = body_kinematics(world, entity_a, anchor_a);
    let (pb, vb, inv_mb, lock_b) = body_kinematics(world, entity_b, anchor_b);
    let inv_sum = inv_ma + inv_mb;
    if inv_sum <= 1e-6 {
        return 0.0;
    }
    let axis = (body_rot(world, entity_a) * local_axis_a).normalize_or_zero();
    let delta = pb - pa;
    let along = delta.dot(axis);
    let perp = delta - axis * along;

    // Remove perpendicular separation completely
    let mut total_imp = 0.0f32;
    let perp_len = perp.length();
    if perp_len > 1e-5 {
        let dir = perp / perp_len;
        let corr = dir * (perp_len / inv_sum);
        if inv_ma > 0.0 && entity_a != INVALID_ENTITY && world.is_alive(entity_a) {
            world.curr_pos[entity_index(entity_a)] += corr * inv_ma;
        }
        if inv_mb > 0.0 && entity_b != INVALID_ENTITY && world.is_alive(entity_b) {
            world.curr_pos[entity_index(entity_b)] -= corr * inv_mb;
        }
        let rel_v = (vb - va).dot(dir);
        let bias = (perp_len / dt.max(1e-4)) * 0.2;
        let j_mag = (rel_v + bias) / inv_sum;
        let impulse = dir * j_mag;
        apply_body_impulse(world, entity_a, anchor_a, impulse, inv_ma, lock_a);
        apply_body_impulse(world, entity_b, anchor_b, -impulse, inv_mb, lock_b);
        total_imp += j_mag.abs();
    }

    // Limit sliding distance along axis
    let clamped = match (min_dist, max_dist) {
        (Some(lo), Some(hi)) => along.clamp(lo.min(hi), lo.max(hi)),
        (Some(lo), None) => along.max(lo),
        (None, Some(hi)) => along.min(hi),
        (None, None) => along,
    };
    let err = along - clamped;
    if err.abs() > 1e-5 {
        let corr = axis * (err / inv_sum);
        if inv_ma > 0.0 && entity_a != INVALID_ENTITY && world.is_alive(entity_a) {
            world.curr_pos[entity_index(entity_a)] += corr * inv_ma;
        }
        if inv_mb > 0.0 && entity_b != INVALID_ENTITY && world.is_alive(entity_b) {
            world.curr_pos[entity_index(entity_b)] -= corr * inv_mb;
        }
        let vel_along = (vb - va).dot(axis);
        if (err > 0.0 && vel_along > 0.0) || (err < 0.0 && vel_along < 0.0) {
            let j_mag = vel_along / inv_sum;
            let impulse = axis * j_mag;
            apply_body_impulse(world, entity_a, anchor_a, impulse, inv_ma, lock_a);
            apply_body_impulse(world, entity_b, anchor_b, -impulse, inv_mb, lock_b);
            total_imp += j_mag.abs();
        }
    }
    total_imp
}

#[allow(clippy::too_many_arguments)]
fn solve_hinge_angular(
    world: &mut World,
    entity_a: EntityHandle,
    entity_b: EntityHandle,
    local_axis_a: Vec3,
    local_axis_b: Vec3,
    ref_dir_a: Vec3,
    ref_dir_b: Vec3,
    min_angle: Option<f32>,
    max_angle: Option<f32>,
    motor_speed: f32,
    motor_max_torque: f32,
    dt: f32,
) {
    let dyn_b = entity_b != INVALID_ENTITY
        && world.is_alive(entity_b)
        && world.rigid_bodies[entity_index(entity_b)].map_or(false, |rb| rb.dynamic && !rb.lock_rotation);
    let dyn_a = entity_a != INVALID_ENTITY
        && world.is_alive(entity_a)
        && world.rigid_bodies[entity_index(entity_a)].map_or(false, |rb| rb.dynamic && !rb.lock_rotation);

    if !dyn_b && !dyn_a {
        return;
    }

    let rot_a = body_rot(world, entity_a);
    let rot_b = body_rot(world, entity_b);
    let axis_a = (rot_a * local_axis_a).normalize_or_zero();
    let axis_b = (rot_b * local_axis_b).normalize_or_zero();

    // Align swing axes (keep freedom along hinge axis only)
    let align = Quat::from_rotation_arc(axis_b, axis_a);
    if dyn_b && !dyn_a {
        let idx_b = entity_index(entity_b);
        world.curr_rot[idx_b] = (align * world.curr_rot[idx_b]).normalize();
        let w = world.angular_velocities[idx_b];
        world.angular_velocities[idx_b] = axis_a * w.dot(axis_a);
    } else if dyn_b && dyn_a {
        let idx_b = entity_index(entity_b);
        let half = Quat::IDENTITY.slerp(align, 0.5);
        world.curr_rot[idx_b] = (half * world.curr_rot[idx_b]).normalize();
        let idx_a = entity_index(entity_a);
        world.curr_rot[idx_a] = (half.inverse() * world.curr_rot[idx_a]).normalize();
    } else if dyn_a {
        let idx_a = entity_index(entity_a);
        world.curr_rot[idx_a] = (align.inverse() * world.curr_rot[idx_a]).normalize();
        let w = world.angular_velocities[idx_a];
        world.angular_velocities[idx_a] = axis_a * w.dot(axis_a);
    }

    // Optional hinge motor around hinge axis
    if motor_max_torque > 0.0 && dyn_b {
        let idx_b = entity_index(entity_b);
        let cur_spin = world.angular_velocities[idx_b].dot(axis_a);
        let err = motor_speed - cur_spin;
        let max_dw = motor_max_torque * dt;
        let dw = err.clamp(-max_dw, max_dw);
        world.angular_velocities[idx_b] += axis_a * dw;
        if let Some(rb) = &mut world.rigid_bodies[idx_b] {
            rb.sleeping = false;
            rb.sleep_timer = 0.0;
        }
    }

    if min_angle.is_none() && max_angle.is_none() {
        return;
    }

    let rot_a2 = body_rot(world, entity_a);
    let rot_b2 = body_rot(world, entity_b);
    let ax = (rot_a2 * local_axis_a).normalize_or_zero();
    let ra = (rot_a2 * ref_dir_a).normalize_or_zero();
    let rb_dir = (rot_b2 * ref_dir_b).normalize_or_zero();
    // Project rb_dir into plane perp to ax
    let rb_proj = (rb_dir - ax * rb_dir.dot(ax)).normalize_or_zero();
    let sin_t = ra.cross(rb_proj).dot(ax);
    let cos_t = ra.dot(rb_proj);
    let angle = sin_t.atan2(cos_t);

    let lo = min_angle.unwrap_or(-std::f32::consts::PI);
    let hi = max_angle.unwrap_or(std::f32::consts::PI);
    let target = if angle < lo {
        Some(lo)
    } else if angle > hi {
        Some(hi)
    } else {
        None
    };

    if let Some(clamped) = target {
        let diff = clamped - angle;
        let fix = Quat::from_axis_angle(ax, diff);
        if dyn_b {
            let idx_b = entity_index(entity_b);
            world.curr_rot[idx_b] = (fix * world.curr_rot[idx_b]).normalize();
            let spin = world.angular_velocities[idx_b].dot(ax);
            if (angle < lo && spin < 0.0) || (angle > hi && spin > 0.0) {
                world.angular_velocities[idx_b] -= ax * spin;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ecs::{Collider3D, RigidBody, World};

    #[test]
    fn test_distance_joint_preserves_rest_length() {
        let mut world = World::new();
        let mut solver = JointSolver::new();

        let anchor = world.spawn();
        world.set_transform_immediate(anchor, Vec3::new(0.0, 5.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        let bob = world.spawn();
        world.set_transform_immediate(bob, Vec3::new(3.0, 5.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.rigid_bodies[entity_index(bob)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 1.0,
            restitution: 0.0,
            friction: 0.2,
            linear_damping: 0.0,
            angular_damping: 0.1,
            mass: 1.0,
            lock_rotation: true,
            ..Default::default()
        });
        world.colliders_3d[entity_index(bob)] = Some(Collider3D::Sphere { radius: 0.3 });

        solver.add_distance(anchor, bob, Vec3::ZERO, Vec3::ZERO, 3.0, 1.0);

        let dt = 1.0 / 60.0;
        for _ in 0..120 {
            world.velocities[entity_index(bob)] += Vec3::new(0.0, -20.0, 0.0) * dt;
            world.curr_pos[entity_index(bob)] += world.velocities[entity_index(bob)] * dt;
            for _ in 0..6 {
                solver.solve_constraints(&mut world, dt);
            }
        }

        let dist = world.curr_pos[entity_index(bob)].distance(world.curr_pos[entity_index(anchor)]);
        assert!((dist - 3.0).abs() < 0.08, "distance joint stretched too far: {dist}");
    }

    #[test]
    fn test_hinge_joint_rotates_around_axis_within_angle_limits() {
        let mut world = World::new();
        let mut solver = JointSolver::new();

        let door = world.spawn();
        world.set_transform_immediate(door, Vec3::new(0.5, 1.0, 0.0), Quat::IDENTITY, Vec3::ONE);
        world.rigid_bodies[entity_index(door)] = Some(RigidBody {
            dynamic: true,
            gravity_scale: 0.0,
            restitution: 0.0,
            friction: 0.2,
            linear_damping: 0.05,
            angular_damping: 0.05,
            mass: 1.0,
            lock_rotation: false,
            ..Default::default()
        });

        solver.add_hinge(
            &world,
            INVALID_ENTITY,
            door,
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(-0.5, 0.0, 0.0),
            Vec3::Y,
            Some(-0.1),
            Some(1.4),
        );

        world.angular_velocities[entity_index(door)] = Vec3::new(2.0, 6.0, 1.0);
        let dt = 1.0 / 60.0;
        for _ in 0..60 {
            let idx = entity_index(door);
            let dq = Quat::from_scaled_axis(world.angular_velocities[idx] * dt);
            world.curr_rot[idx] = (dq * world.curr_rot[idx]).normalize();
            for _ in 0..4 {
                solver.solve_constraints(&mut world, dt);
            }
        }

        let (_axis, angle) = world.curr_rot[entity_index(door)].to_axis_angle();
        assert!(angle <= 1.45, "hinge angle exceeded max limit: {angle}");
        let hinge_world = world.curr_pos[entity_index(door)] + world.curr_rot[entity_index(door)] * Vec3::new(-0.5, 0.0, 0.0);
        assert!(hinge_world.distance(Vec3::new(0.0, 1.0, 0.0)) < 0.05);
    }
}
