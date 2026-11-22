use crate::animation::{AnimChannel, AnimationClipData, SkeletonData, MAX_BONES};
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Quat, Vec3};
use std::collections::HashMap;

pub const SUBMESH_STRIDE_F32: usize = 16;

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct VertexPbr {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Clone, Debug)]
pub struct GlbImage {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub struct TriggerBox {
    pub center: [f32; 3],
    pub half_extents: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
pub struct GlbSubmesh {
    pub index_offset: u32,
    pub index_count: u32,
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub emissive_factor: [f32; 3],
    pub base_color_tex: Option<u32>,
    pub normal_tex: Option<u32>,
    pub metallic_roughness_tex: Option<u32>,
    pub emissive_tex: Option<u32>,
    pub role: u32, // 0 = visual, 1 = _col, 2 = _trig
}

#[derive(Clone, Debug)]
pub struct ParsedGlb {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub joints: Vec<u16>,
    pub weights: Vec<f32>,
    pub submeshes: Vec<GlbSubmesh>,
    pub submesh_floats: Vec<f32>,
    pub images: Vec<GlbImage>,
    pub collider_triangles: Vec<f32>,
    pub trigger_boxes: Vec<TriggerBox>,
    pub trigger_floats: Vec<f32>,
    pub skeleton: Option<SkeletonData>,
    pub clips: Vec<AnimationClipData>,
    pub bounds_min: [f32; 3],
    pub bounds_max: [f32; 3],
}

#[derive(Debug)]
pub enum GltfParseError {
    InvalidContainer(String),
    MissingBinaryBuffer,
    NoGeometry,
}

pub fn parse_glb(bytes: &[u8]) -> Result<ParsedGlb, GltfParseError> {
    if bytes.len() < 12 {
        return Err(GltfParseError::InvalidContainer("file too short".into()));
    }
    let gltf = gltf::Gltf::from_slice(bytes)
        .map_err(|e| GltfParseError::InvalidContainer(e.to_string()))?;

    let blob = gltf.blob.as_deref().ok_or(GltfParseError::MissingBinaryBuffer)?;

    // Extract embedded images
    let mut images = Vec::new();
    for img in gltf.images() {
        match img.source() {
            gltf::image::Source::View { view, mime_type } => {
                let start = view.offset();
                let end = start + view.length();
                if end <= blob.len() {
                    images.push(GlbImage {
                        mime_type: mime_type.to_string(),
                        bytes: blob[start..end].to_vec(),
                    });
                }
            }
            gltf::image::Source::Uri { .. } => {}
        }
    }

    let mut vertices: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut joints: Vec<u16> = Vec::new();
    let mut weights: Vec<f32> = Vec::new();
    let mut has_skin_attrs = false;
    let mut submeshes: Vec<GlbSubmesh> = Vec::new();
    let mut collider_triangles: Vec<f32> = Vec::new();
    let mut trigger_boxes: Vec<TriggerBox> = Vec::new();
    let mut bmin = Vec3::splat(f32::INFINITY);
    let mut bmax = Vec3::splat(f32::NEG_INFINITY);

    let mut visited_scene_nodes = false;
    if let Some(scene) = gltf.default_scene().or_else(|| gltf.scenes().next()) {
        visited_scene_nodes = true;
        for node in scene.nodes() {
            visit_node(
                &node,
                Mat4::IDENTITY,
                blob,
                &mut vertices,
                &mut indices,
                &mut joints,
                &mut weights,
                &mut has_skin_attrs,
                &mut submeshes,
                &mut collider_triangles,
                &mut trigger_boxes,
                &mut bmin,
                &mut bmax,
            );
        }
    }

    if !visited_scene_nodes || submeshes.is_empty() {
        for mesh in gltf.meshes() {
            append_mesh(
                &mesh,
                mesh.name().unwrap_or(""),
                Mat4::IDENTITY,
                blob,
                &mut vertices,
                &mut indices,
                &mut joints,
                &mut weights,
                &mut has_skin_attrs,
                &mut submeshes,
                &mut collider_triangles,
                &mut trigger_boxes,
                &mut bmin,
                &mut bmax,
            );
        }
    }

    if submeshes.is_empty() || vertices.is_empty() {
        return Err(GltfParseError::NoGeometry);
    }

    if !has_skin_attrs {
        joints.clear();
        weights.clear();
    }

    let mut submesh_floats = Vec::with_capacity(submeshes.len() * SUBMESH_STRIDE_F32);
    for sm in &submeshes {
        submesh_floats.extend_from_slice(&[
            sm.index_offset as f32,
            sm.index_count as f32,
            sm.base_color[0],
            sm.base_color[1],
            sm.base_color[2],
            sm.base_color[3],
            sm.metallic,
            sm.roughness,
            sm.emissive_factor[0],
            sm.emissive_factor[1],
            sm.emissive_factor[2],
            sm.base_color_tex.map_or(-1.0, |i| i as f32),
            sm.normal_tex.map_or(-1.0, |i| i as f32),
            sm.metallic_roughness_tex.map_or(-1.0, |i| i as f32),
            sm.emissive_tex.map_or(-1.0, |i| i as f32),
            sm.role as f32,
        ]);
    }

    let mut trigger_floats = Vec::with_capacity(trigger_boxes.len() * 6);
    for tb in &trigger_boxes {
        trigger_floats.extend_from_slice(&tb.center);
        trigger_floats.extend_from_slice(&tb.half_extents);
    }

    // Parse primary skeleton & animation clips if present
    let (skeleton, node_to_joint) = parse_skeleton(&gltf, blob);
    let clips = if !node_to_joint.is_empty() {
        parse_animations(&gltf, blob, &node_to_joint)
    } else {
        Vec::new()
    };

    Ok(ParsedGlb {
        vertices,
        indices,
        joints,
        weights,
        submeshes,
        submesh_floats,
        images,
        collider_triangles,
        trigger_boxes,
        trigger_floats,
        skeleton,
        clips,
        bounds_min: bmin.to_array(),
        bounds_max: bmax.to_array(),
    })
}

fn parse_skeleton(gltf: &gltf::Gltf, blob: &[u8]) -> (Option<SkeletonData>, HashMap<usize, usize>) {
    let mut node_to_joint = HashMap::new();
    let Some(skin) = gltf.skins().next() else {
        return (None, node_to_joint);
    };
    let joint_nodes: Vec<gltf::Node> = skin.joints().take(MAX_BONES).collect();
    if joint_nodes.is_empty() {
        return (None, node_to_joint);
    }
    for (j_idx, node) in joint_nodes.iter().enumerate() {
        node_to_joint.insert(node.index(), j_idx);
    }

    let mut parent_indices = vec![-1i32; joint_nodes.len()];
    for node in &joint_nodes {
        let p_joint = node_to_joint[&node.index()] as i32;
        for child in node.children() {
            if let Some(&c_joint) = node_to_joint.get(&child.index()) {
                parent_indices[c_joint] = p_joint;
            }
        }
    }

    let mut rest_translations = Vec::with_capacity(joint_nodes.len());
    let mut rest_rotations = Vec::with_capacity(joint_nodes.len());
    let mut rest_scales = Vec::with_capacity(joint_nodes.len());
    for node in &joint_nodes {
        let (t, r, s) = node.transform().decomposed();
        rest_translations.push(Vec3::from_array(t));
        rest_rotations.push(Quat::from_array(r).normalize());
        rest_scales.push(Vec3::from_array(s));
    }

    let reader = skin.reader(|buffer| match buffer.source() {
        gltf::buffer::Source::Bin => Some(blob),
        gltf::buffer::Source::Uri(_) => None,
    });
    let mut inverse_bind_matrices: Vec<Mat4> = reader
        .read_inverse_bind_matrices()
        .map(|it| it.take(joint_nodes.len()).map(|m| Mat4::from_cols_array_2d(&m)).collect())
        .unwrap_or_default();
    inverse_bind_matrices.resize(joint_nodes.len(), Mat4::IDENTITY);

    (
        Some(SkeletonData {
            joint_count: joint_nodes.len(),
            parent_indices,
            rest_translations,
            rest_rotations,
            rest_scales,
            inverse_bind_matrices,
        }),
        node_to_joint,
    )
}

fn parse_animations(
    gltf: &gltf::Gltf,
    blob: &[u8],
    node_to_joint: &HashMap<usize, usize>,
) -> Vec<AnimationClipData> {
    let mut clips = Vec::new();
    for (idx, anim) in gltf.animations().enumerate() {
        let name = anim
            .name()
            .map(String::from)
            .unwrap_or_else(|| format!("Clip_{idx}"));
        let mut channels = Vec::new();
        let mut duration = 0.0f32;

        for ch in anim.channels() {
            let Some(&joint_index) = node_to_joint.get(&ch.target().node().index()) else {
                continue;
            };
            let reader = ch.reader(|buffer| match buffer.source() {
                gltf::buffer::Source::Bin => Some(blob),
                gltf::buffer::Source::Uri(_) => None,
            });
            let Some(inputs) = reader.read_inputs() else {
                continue;
            };
            let times: Vec<f32> = inputs.collect();
            if let Some(&last_t) = times.last() {
                duration = duration.max(last_t);
            }
            let Some(outputs) = reader.read_outputs() else {
                continue;
            };
            let mut anim_ch = AnimChannel {
                joint_index,
                times,
                translations: None,
                rotations: None,
                scales: None,
            };
            match outputs {
                gltf::animation::util::ReadOutputs::Translations(it) => {
                    anim_ch.translations = Some(it.map(Vec3::from_array).collect());
                }
                gltf::animation::util::ReadOutputs::Rotations(it) => {
                    anim_ch.rotations =
                        Some(it.into_f32().map(|q| Quat::from_array(q).normalize()).collect());
                }
                gltf::animation::util::ReadOutputs::Scales(it) => {
                    anim_ch.scales = Some(it.map(Vec3::from_array).collect());
                }
                gltf::animation::util::ReadOutputs::MorphTargetWeights(_) => continue,
            }
            channels.push(anim_ch);
        }

        if !channels.is_empty() {
            clips.push(AnimationClipData {
                name,
                duration,
                channels,
            });
        }
    }
    clips
}

#[allow(clippy::too_many_arguments)]
fn visit_node(
    node: &gltf::Node,
    parent_mat: Mat4,
    blob: &[u8],
    vertices: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    joints: &mut Vec<u16>,
    weights: &mut Vec<f32>,
    has_skin_attrs: &mut bool,
    submeshes: &mut Vec<GlbSubmesh>,
    collider_triangles: &mut Vec<f32>,
    trigger_boxes: &mut Vec<TriggerBox>,
    bmin: &mut Vec3,
    bmax: &mut Vec3,
) {
    let local = Mat4::from_cols_array_2d(&node.transform().matrix());
    let world = parent_mat * local;
    if let Some(mesh) = node.mesh() {
        let name = node.name().or_else(|| mesh.name()).unwrap_or("");
        // Skinned meshes keep vertices in mesh/bind space; rigid nodes bake world transform
        let baked_mat = if node.skin().is_some() { Mat4::IDENTITY } else { world };
        append_mesh(
            &mesh,
            name,
            baked_mat,
            blob,
            vertices,
            indices,
            joints,
            weights,
            has_skin_attrs,
            submeshes,
            collider_triangles,
            trigger_boxes,
            bmin,
            bmax,
        );
    }
    for child in node.children() {
        visit_node(
            &child,
            world,
            blob,
            vertices,
            indices,
            joints,
            weights,
            has_skin_attrs,
            submeshes,
            collider_triangles,
            trigger_boxes,
            bmin,
            bmax,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn append_mesh(
    mesh: &gltf::Mesh,
    name: &str,
    world_mat: Mat4,
    blob: &[u8],
    vertices: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    joints: &mut Vec<u16>,
    weights: &mut Vec<f32>,
    has_skin_attrs: &mut bool,
    submeshes: &mut Vec<GlbSubmesh>,
    collider_triangles: &mut Vec<f32>,
    trigger_boxes: &mut Vec<TriggerBox>,
    bmin: &mut Vec3,
    bmax: &mut Vec3,
) {
    let role = if name.ends_with("_col") {
        1
    } else if name.ends_with("_trig") {
        2
    } else {
        0
    };

    let normal_mat = world_mat.inverse().transpose();
    for primitive in mesh.primitives() {
        let reader = primitive.reader(|buffer| match buffer.source() {
            gltf::buffer::Source::Bin => Some(blob),
            gltf::buffer::Source::Uri(_) => None,
        });
        let Some(pos_iter) = reader.read_positions() else {
            continue;
        };
        let positions: Vec<[f32; 3]> = pos_iter.collect();
        if positions.is_empty() {
            continue;
        }
        let normals: Vec<[f32; 3]> = reader
            .read_normals()
            .map(|it| it.collect())
            .unwrap_or_default();
        let uvs: Vec<[f32; 2]> = reader
            .read_tex_coords(0)
            .map(|tc| tc.into_f32().collect())
            .unwrap_or_default();
        let prim_joints: Vec<[u16; 4]> = reader
            .read_joints(0)
            .map(|j| j.into_u16().collect())
            .unwrap_or_default();
        let prim_weights: Vec<[f32; 4]> = reader
            .read_weights(0)
            .map(|w| w.into_f32().collect())
            .unwrap_or_default();

        if !prim_joints.is_empty() && !prim_weights.is_empty() {
            *has_skin_attrs = true;
        }

        let local_indices: Vec<u32> = match reader.read_indices() {
            Some(ind) => ind.into_u32().collect(),
            None => (0..positions.len() as u32).collect(),
        };
        if local_indices.is_empty() {
            continue;
        }

        let base_vertex = (vertices.len() / 8) as u32;
        let index_offset = indices.len() as u32;
        let index_count = local_indices.len() as u32;

        let mut world_positions = Vec::with_capacity(positions.len());
        let mut local_bmin = Vec3::splat(f32::INFINITY);
        let mut local_bmax = Vec3::splat(f32::NEG_INFINITY);
        for p in &positions {
            let wp = world_mat.transform_point3(Vec3::from_array(*p));
            *bmin = bmin.min(wp);
            *bmax = bmax.max(wp);
            local_bmin = local_bmin.min(wp);
            local_bmax = local_bmax.max(wp);
            world_positions.push(wp);
        }

        if role == 1 {
            for tri in local_indices.chunks_exact(3) {
                let (i0, i1, i2) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
                if i0 < world_positions.len()
                    && i1 < world_positions.len()
                    && i2 < world_positions.len()
                {
                    collider_triangles.extend_from_slice(&world_positions[i0].to_array());
                    collider_triangles.extend_from_slice(&world_positions[i1].to_array());
                    collider_triangles.extend_from_slice(&world_positions[i2].to_array());
                }
            }
        } else if role == 2 {
            let center = (local_bmin + local_bmax) * 0.5;
            let half = ((local_bmax - local_bmin) * 0.5).max(Vec3::splat(0.1));
            trigger_boxes.push(TriggerBox {
                center: center.to_array(),
                half_extents: half.to_array(),
            });
        }

        let mut fallback_normals = vec![Vec3::ZERO; positions.len()];
        if normals.len() != positions.len() {
            for tri in local_indices.chunks_exact(3) {
                let (i0, i1, i2) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
                if i0 < world_positions.len()
                    && i1 < world_positions.len()
                    && i2 < world_positions.len()
                {
                    let e1 = world_positions[i1] - world_positions[i0];
                    let e2 = world_positions[i2] - world_positions[i0];
                    let n = e1.cross(e2);
                    fallback_normals[i0] += n;
                    fallback_normals[i1] += n;
                    fallback_normals[i2] += n;
                }
            }
        }

        for i in 0..positions.len() {
            let wp = world_positions[i];
            let wn = if normals.len() == positions.len() {
                normal_mat
                    .transform_vector3(Vec3::from_array(normals[i]))
                    .normalize_or_zero()
            } else {
                let n = fallback_normals[i].normalize_or_zero();
                if n.length_squared() > 0.0 {
                    n
                } else {
                    Vec3::Y
                }
            };
            let uv = uvs.get(i).copied().unwrap_or([0.0, 0.0]);
            let vtx = VertexPbr {
                pos: wp.to_array(),
                normal: wn.to_array(),
                uv,
            };
            vertices.extend_from_slice(bytemuck::cast_slice(&[vtx]));
            let j = prim_joints.get(i).copied().unwrap_or([0, 0, 0, 0]);
            let w = prim_weights.get(i).copied().unwrap_or([1.0, 0.0, 0.0, 0.0]);
            joints.extend_from_slice(&j);
            weights.extend_from_slice(&w);
        }

        for idx in local_indices {
            indices.push(base_vertex + idx);
        }

        let mat = primitive.material();
        let pbr = mat.pbr_metallic_roughness();
        submeshes.push(GlbSubmesh {
            index_offset,
            index_count,
            base_color: pbr.base_color_factor(),
            metallic: pbr.metallic_factor(),
            roughness: pbr.roughness_factor(),
            emissive_factor: mat.emissive_factor(),
            base_color_tex: pbr.base_color_texture().map(|t| t.texture().source().index() as u32),
            normal_tex: mat.normal_texture().map(|t| t.texture().source().index() as u32),
            metallic_roughness_tex: pbr
                .metallic_roughness_texture()
                .map(|t| t.texture().source().index() as u32),
            emissive_tex: mat.emissive_texture().map(|t| t.texture().source().index() as u32),
            role,
        });
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub(crate) fn make_minimal_triangle_glb() -> Vec<u8> {
        let mut bin = Vec::new();
        let verts: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        for v in verts {
            bin.extend_from_slice(&v.to_le_bytes());
        }
        let indices: [u16; 3] = [0, 1, 2];
        for i in indices {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        while bin.len() % 4 != 0 {
            bin.push(0);
        }

        let json = format!(
            concat!(
                r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"#,
                r#""bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},{{"buffer":0,"byteOffset":36,"byteLength":6}}],"#,
                r#""accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}},"#,
                r#"{{"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}}],"#,
                r#""meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1}}]}}]}}"#
            ),
            bin.len()
        );
        let mut json_bytes = json.into_bytes();
        while json_bytes.len() % 4 != 0 {
            json_bytes.push(b' ');
        }

        let total_len = 12 + 8 + json_bytes.len() + 8 + bin.len();
        let mut glb = Vec::with_capacity(total_len);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total_len as u32).to_le_bytes());

        glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4E4F534Au32.to_le_bytes());
        glb.extend_from_slice(&json_bytes);

        glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x004E4942u32.to_le_bytes());
        glb.extend_from_slice(&bin);
        glb
    }

    #[test]
    fn test_parse_minimal_valid_glb() {
        let glb = make_minimal_triangle_glb();
        let parsed = parse_glb(&glb).expect("valid minimal GLB should parse");
        assert_eq!(parsed.vertices.len(), 3 * 8);
        assert_eq!(parsed.indices, vec![0, 1, 2]);
        assert_eq!(parsed.submeshes.len(), 1);
        assert!((parsed.vertices[5] - 1.0).abs() < 1e-4);
        assert!((parsed.bounds_max[0] - 1.0).abs() < 1e-4);
        assert!((parsed.bounds_max[1] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn test_parse_malformed_glb_returns_error() {
        assert!(parse_glb(b"not-a-glb").is_err());
        assert!(parse_glb(&[]).is_err());
    }

    #[test]
    fn test_glb_col_and_trig_conventions_and_embedded_image() {
        let mut bin = Vec::new();
        let verts: [f32; 9] = [0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0];
        for v in verts {
            bin.extend_from_slice(&v.to_le_bytes());
        }
        let fake_png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let img_offset = bin.len();
        bin.extend_from_slice(&fake_png);
        while bin.len() % 4 != 0 {
            bin.push(0);
        }

        let json = format!(
            concat!(
                r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"#,
                r#""bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},{{"buffer":0,"byteOffset":{},"byteLength":{}}}],"#,
                r#""accessors":[{{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[2,2,0]}}],"#,
                r#""images":[{{"bufferView":1,"mimeType":"image/png"}}],"#,
                r#""textures":[{{"source":0}}],"#,
                r#""materials":[{{"pbrMetallicRoughness":{{"baseColorFactor":[0.8,0.2,0.2,1.0],"baseColorTexture":{{"index":0}}}}}}],"#,
                r#""meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"material":0}}]}}],"#,
                r#""nodes":[{{"name":"Wall_col","mesh":0}},{{"name":"Zone_trig","mesh":0,"translation":[5,0,0]}}],"#,
                r#""scenes":[{{"nodes":[0,1]}}],"scene":0}}"#
            ),
            bin.len(),
            img_offset,
            fake_png.len()
        );
        let mut json_bytes = json.into_bytes();
        while json_bytes.len() % 4 != 0 {
            json_bytes.push(b' ');
        }
        let total_len = 12 + 8 + json_bytes.len() + 8 + bin.len();
        let mut glb = Vec::with_capacity(total_len);
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&(total_len as u32).to_le_bytes());
        glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x4E4F534Au32.to_le_bytes());
        glb.extend_from_slice(&json_bytes);
        glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        glb.extend_from_slice(&0x004E4942u32.to_le_bytes());
        glb.extend_from_slice(&bin);

        let parsed = parse_glb(&glb).expect("GLB with conventions and image should parse");
        assert_eq!(parsed.images.len(), 1);
        assert_eq!(parsed.images[0].mime_type, "image/png");
        assert_eq!(parsed.images[0].bytes, fake_png);
        assert_eq!(parsed.submeshes[0].base_color_tex, Some(0));
        assert_eq!(parsed.collider_triangles.len(), 9);
        assert_eq!(parsed.trigger_boxes.len(), 1);
        assert!((parsed.trigger_boxes[0].center[0] - 6.0).abs() < 1e-4);
    }
}
