use cargo_metadata::{DependencyKind, MetadataCommand};

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
}
