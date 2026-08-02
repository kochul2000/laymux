use std::collections::HashMap;

use serde_json::Value;
use serde_path_to_error::Segment;

#[derive(Debug)]
pub(super) enum OriginalPathTree {
    Leaf,
    Map(HashMap<String, OriginalPathTree>),
    Seq(Vec<OriginalArrayItem>),
}

#[derive(Debug)]
pub(super) struct OriginalArrayItem {
    index: usize,
    child: OriginalPathTree,
}

impl OriginalPathTree {
    pub(super) fn from_value(value: &Value) -> Self {
        match value {
            Value::Object(object) => Self::Map(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::from_value(value)))
                    .collect(),
            ),
            Value::Array(array) => Self::Seq(
                array
                    .iter()
                    .enumerate()
                    .map(|(index, value)| OriginalArrayItem {
                        index,
                        child: Self::from_value(value),
                    })
                    .collect(),
            ),
            _ => Self::Leaf,
        }
    }

    pub(super) fn descend_mut(&mut self, segment: &Segment) -> Option<&mut Self> {
        match segment {
            Segment::Map { key } => match self {
                Self::Map(object) => object.get_mut(key),
                _ => None,
            },
            Segment::Seq { index } => match self {
                Self::Seq(array) => array.get_mut(*index).map(|item| &mut item.child),
                _ => None,
            },
            _ => None,
        }
    }

    pub(super) fn contains(&self, segment: &Segment) -> bool {
        match segment {
            Segment::Map { key } => match self {
                Self::Map(object) => object.contains_key(key),
                _ => false,
            },
            Segment::Seq { index } => match self {
                Self::Seq(array) => *index < array.len(),
                _ => false,
            },
            _ => false,
        }
    }

    pub(super) fn remove(&mut self, segment: &Segment) -> Option<()> {
        match segment {
            Segment::Map { key } => match self {
                Self::Map(object) => object.remove(key).map(|_| ()),
                _ => None,
            },
            Segment::Seq { index } => match self {
                Self::Seq(array) if *index < array.len() => {
                    array.remove(*index);
                    Some(())
                }
                _ => None,
            },
            _ => None,
        }
    }

    pub(super) fn format_path(&self, segments: &[Segment]) -> Option<String> {
        let mut out = String::new();
        let mut current = self;
        for segment in segments {
            match segment {
                Segment::Map { key } => {
                    if !out.is_empty() {
                        out.push('.');
                    }
                    out.push_str(key);
                    current = match current {
                        Self::Map(object) => object.get(key)?,
                        _ => return None,
                    };
                }
                Segment::Seq { index } => {
                    let item = match current {
                        Self::Seq(array) => array.get(*index)?,
                        _ => return None,
                    };
                    out.push_str(&format!("[{}]", item.index));
                    current = &item.child;
                }
                Segment::Enum { variant } => {
                    if !out.is_empty() {
                        out.push('.');
                    }
                    out.push_str(variant);
                }
                Segment::Unknown => out.push_str(".?"),
            }
        }
        Some(out)
    }
}
