use crate::ecs::{entity_index, EntityHandle, World, INVALID_ENTITY};
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
    },
}

#[derive(Clone, Debug)]
pub struct JointEntry {
    pub id: u32,
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
            },
        });
        id
    }

    pub fn remove(&mut self, joint_id: u32) -> bool {
        let before = self.joints.len();
        self.joints.retain(|j| j.id != joint_id);
        self.joints.len() != before
    }

    pub fn has_pair(&self, e1: EntityHandle, e2: EntityHandle) -> bool {
        if e1 == INVALID_ENTITY || e2 == INVALID_ENTITY {
            return false;
        }
        self.joints.iter().any(|j| {
            let (a, b) = match &j.kind {
                JointKind::Distance { entity_a, entity_b, .. }
                | JointKind::Spring { entity_a, entity_b, .. }
                | JointKind::Hinge { entity_a, entity_b, .. } => (*entity_a, *entity_b),
            };
            (a == e1 && b == e2) || (a == e2 && b == e1)
        })
    }

    pub fn retain_alive(&mut self, world: &World) {
        self.joints.retain(|j| {
            let (a, b) = match &j.kind {
                JointKind::Distance { entity_a, entity_b, .. }
                | JointKind::Spring { entity_a, entity_b, .. }
                | JointKind::Hinge { entity_a, entity_b, .. } => (*entity_a, *entity_b),
            };
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

    pub fn solve_constraints(&self, world: &mut World, dt: f32) {
        for j in &self.joints {
            match j.kind {
                JointKind::Distance {
                    entity_a,
                    entity_b,
                    anchor_a,
                    anchor_b,
                    rest_length,
                    stiffness,
                } => {
                    solve_distance_constraint(
                        world,
                        entity_a,
                        entity_b,
                        anchor_a,
                        anchor_b,
                        rest_length,
                        stiffness,
                        dt,
                    );
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
                } => {
                    solve_distance_constraint(
                        world, entity_a, entity_b, anchor_a, anchor_b, 0.0, 1.0, dt,
                    );
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
                    );
                }
                JointKind::Spring { .. } => {}
            }
        }
    }
}

fn body_rot(world: &World, handle: EntityHandle) -> Quat {
    if handle == INVALID_ENTITY || !world.is_alive(handle) {
        return Quat::IDENTITY;
    }
    world.curr_rot[entity_index(handle)]
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
    let r = world_pt - world.curr_pos[idx];
    let vel = world.velocities[idx] + world.angular_velocities[idx].cross(r);
    (world_pt, vel, 1.0 / rb.mass.max(0.01), rb.lock_rotation)
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
    if let Some(rb) = &mut world.rigid_bodies[idx] {
        rb.sleeping = false;
        rb.sleep_timer = 0.0;
    }
    world.velocities[idx] += impulse * inv_m;
    if !lock_rot {
        let r = world.curr_rot[idx] * local_anchor;
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
) {
    let (pa, va, inv_ma, lock_a) = body_kinematics(world, entity_a, anchor_a);
    let (pb, vb, inv_mb, lock_b) = body_kinematics(world, entity_b, anchor_b);
    let inv_sum = inv_ma + inv_mb;
    if inv_sum <= 1e-6 {
        return;
    }

    let delta = pb - pa;
    let dist = delta.length();
    let error = dist - rest_length;
    if error.abs() < 1e-5 {
        return;
    }
    let dir = if dist > 1e-6 { delta / dist } else { Vec3::Y };

    // Positional correction
    let corr = dir * (error * stiffness / inv_sum);
    if inv_ma > 0.0 && entity_a != INVALID_ENTITY && world.is_alive(entity_a) {
        world.curr_pos[entity_index(entity_a)] += corr * inv_ma;
    }
    if inv_mb > 0.0 && entity_b != INVALID_ENTITY && world.is_alive(entity_b) {
        world.curr_pos[entity_index(entity_b)] -= corr * inv_mb;
    }

    // Velocity projection along constraint normal + mild Baumgarte
    let rel_v = (vb - va).dot(dir);
    let bias = (error / dt.max(1e-4)) * 0.15 * stiffness;
    let j_mag = (rel_v + bias) / inv_sum;
    let impulse = dir * j_mag;
    apply_body_impulse(world, entity_a, anchor_a, impulse, inv_ma, lock_a);
    apply_body_impulse(world, entity_b, anchor_b, -impulse, inv_mb, lock_b);
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
