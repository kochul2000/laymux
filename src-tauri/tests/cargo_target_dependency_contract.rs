use cargo_metadata::{DependencyKind, MetadataCommand};

const WINDOWS_TARGET: &str = "x86_64-pc-windows-msvc";
const LINUX_TARGET: &str = "x86_64-unknown-linux-gnu";

#[test]
fn rfd_backends_are_target_scoped_and_lockfile_resolves() {
    let metadata = MetadataCommand::new()
        .manifest_path(format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR")))
        .no_deps()
        .other_options(vec!["--locked".to_owned()])
        .exec()
        .expect("Cargo.lock must resolve the target-specific rfd dependencies");
    let package = metadata
        .packages
        .iter()
        .find(|package| package.name.as_str() == "laymux")
        .expect("laymux package must be present in cargo metadata");

    let mut rfd = package
        .dependencies
        .iter()
        .filter(|dependency| dependency.name == "rfd")
        .collect::<Vec<_>>();
    rfd.sort_by_key(|dependency| {
        dependency
            .target
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_default()
    });

    assert_eq!(
        rfd.len(),
        2,
        "rfd must have one dependency per supported OS"
    );
    for dependency in &rfd {
        assert_eq!(dependency.kind, DependencyKind::Normal);
        assert_eq!(dependency.req.to_string(), "^0.15");
        assert!(
            !dependency.uses_default_features,
            "rfd defaults must stay disabled so Linux backend changes are explicit"
        );
    }

    let linux = rfd
        .iter()
        .find(|dependency| {
            dependency
                .target
                .as_ref()
                .map(ToString::to_string)
                .as_deref()
                == Some("cfg(target_os = \"linux\")")
        })
        .expect("Linux rfd dependency must be target-scoped");
    assert_eq!(linux.features, ["gtk3"]);

    let windows = rfd
        .iter()
        .find(|dependency| {
            dependency
                .target
                .as_ref()
                .map(ToString::to_string)
                .as_deref()
                == Some("cfg(windows)")
        })
        .expect("Windows rfd dependency must be target-scoped");
    assert!(
        windows.features.is_empty(),
        "Linux dialog backend features must not enter the Windows graph"
    );

    let linux_graph = resolved_rfd_dependency_names(LINUX_TARGET);
    for dependency in ["glib-sys", "gobject-sys", "gtk-sys"] {
        assert!(
            linux_graph.iter().any(|name| name == dependency),
            "the resolved Linux rfd graph must contain {dependency}: {linux_graph:?}"
        );
    }
    for dependency in ["ashpd", "pollster", "urlencoding"] {
        assert!(
            !linux_graph.iter().any(|name| name == dependency),
            "the resolved Linux rfd graph must not contain portal dependency {dependency}"
        );
    }

    let windows_graph = resolved_rfd_dependency_names(WINDOWS_TARGET);
    for dependency in [
        "glib-sys",
        "gobject-sys",
        "gtk-sys",
        "ashpd",
        "pollster",
        "urlencoding",
    ] {
        assert!(
            !windows_graph.iter().any(|name| name == dependency),
            "the resolved Windows rfd graph must not contain Linux backend dependency {dependency}"
        );
    }
}

fn resolved_rfd_dependency_names(target: &str) -> Vec<String> {
    let metadata = MetadataCommand::new()
        .manifest_path(format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR")))
        .other_options(vec![
            "--locked".to_owned(),
            "--filter-platform".to_owned(),
            target.to_owned(),
        ])
        .exec()
        .unwrap_or_else(|error| panic!("Cargo.lock must resolve for {target}: {error}"));
    let rfd = metadata
        .packages
        .iter()
        .find(|package| package.name.as_str() == "rfd")
        .expect("resolved graph must contain rfd");
    let resolve = metadata
        .resolve
        .expect("metadata must contain a resolve graph");
    let node = resolve
        .nodes
        .iter()
        .find(|node| node.id == rfd.id)
        .expect("resolved graph must contain the rfd node");
    let mut names = node
        .deps
        .iter()
        .map(|dependency| {
            metadata
                .packages
                .iter()
                .find(|package| package.id == dependency.pkg)
                .unwrap_or_else(|| {
                    panic!("resolved dependency {} must have a package", dependency.pkg)
                })
                .name
                .to_string()
        })
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}
