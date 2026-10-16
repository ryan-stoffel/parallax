//! Areas and pins (PLX-789): `area/*`, `areas.changed`, and `pinned` on `thread/update`, and
//! repo entries and Spaces as members (PLX-852).

use parallax_protocol::methods::{AreaCreate, AreaDelete, AreaUpdate, OrchestrationSubscribeShell};
use parallax_protocol::{
    Area, AreaCreateParams, AreaDeleteParams, AreaId, AreaUpdateParams, SubscribeShellParams,
};

use super::*;

fn create(id: AreaId, name: &str, color: &str, threads: Vec<RunId>) -> AreaCreateParams {
    AreaCreateParams {
        id,
        name: name.to_owned(),
        color: color.to_owned(),
        threads,
        projects: Vec::new(),
        repos: Vec::new(),
    }
}

/// Whether `event` is `areas.changed` with exactly `expected`.
fn changed_to(expected: &[Area]) -> impl FnMut(&EventsEventParams) -> bool + '_ {
    move |event| matches!(&event.event, ParallaxEvent::AreasChanged { areas } if areas == expected)
}

/// An area keeps only top-level threads, is idempotent on its id, appends `areas.changed` for
/// each change but not a no-op, and loses a deleted thread.
#[tokio::test]
async fn an_area_lists_top_level_threads_and_follows_their_deletion() {
    let host = Host::start(fake(editing()));
    let mut client = host.client().await;
    client.subscribe(0, None).await;
    let parent = start_params(None, "Lead");
    client.call::<ThreadStart>(parent.clone()).await.unwrap();
    let child = ThreadStartParams {
        parent: Some(parent.run_id),
        ..start_params(None, "Help")
    };
    client.call::<ThreadStart>(child.clone()).await.unwrap();
    let other = start_params(None, "Other");
    client.call::<ThreadStart>(other.clone()).await.unwrap();

    let id = AreaId::generate();
    let members = vec![
        other.run_id,
        child.run_id,
        RunId::generate(),
        parent.run_id,
        other.run_id,
    ];
    let params = AreaCreateParams {
        projects: vec![ProjectId::generate()],
        ..create(id, " Work ", "violet", members)
    };
    let area = client
        .call::<AreaCreate>(params.clone())
        .await
        .unwrap()
        .area;
    assert_eq!(area.name, "Work");
    assert_eq!(area.threads, [other.run_id, parent.run_id]);
    assert!(area.projects.is_empty());
    client.until(changed_to(std::slice::from_ref(&area))).await;
    assert_eq!(
        client.call::<AreaCreate>(params).await.unwrap().area,
        area,
        "idempotent on the id"
    );
    let taken = client
        .call::<AreaCreate>(create(id, "Other", "violet", Vec::new()))
        .await
        .unwrap_err();
    assert_eq!(kind(&taken), ErrorKind::IdConflict);

    let update = AreaUpdateParams {
        area: id,
        name: None,
        color: Some("teal".to_owned()),
        threads: Some(vec![parent.run_id, other.run_id]),
        projects: None,
        repos: None,
    };
    let updated = client
        .call::<AreaUpdate>(update.clone())
        .await
        .unwrap()
        .area;
    assert_eq!(updated.color, "teal");
    assert_eq!(updated.threads, [parent.run_id, other.run_id]);
    client
        .until(changed_to(std::slice::from_ref(&updated)))
        .await;
    // The same update again appends nothing, so the next `areas.changed` is the delete's.
    assert_eq!(
        client.call::<AreaUpdate>(update).await.unwrap().area,
        updated
    );
    client.delete(parent.run_id).await.unwrap();
    let after_delete = Area {
        threads: vec![other.run_id],
        ..updated
    };
    let events = client
        .until(|event| matches!(event.event, ParallaxEvent::AreasChanged { .. }))
        .await;
    assert!(changed_to(std::slice::from_ref(&after_delete))(
        events.last().unwrap()
    ));
    let missing = client
        .call::<AreaUpdate>(AreaUpdateParams {
            area: AreaId::generate(),
            name: Some("Gone".to_owned()),
            color: None,
            threads: None,
            projects: None,
            repos: None,
        })
        .await
        .unwrap_err();
    assert_eq!(kind(&missing), ErrorKind::AreaNotFound);
}

/// An area's name and color are checked, areas are listed in `thread/list` and the shell
/// snapshot, oldest first, and a pin round-trips through `thread/update`.
#[tokio::test]
async fn areas_are_checked_listed_and_deleted_beside_pins() {
    let host = Host::start(fake(editing()));
    let mut client = host.client().await;
    client.subscribe(0, None).await;
    let other = start_params(None, "Other");
    client.call::<ThreadStart>(other.clone()).await.unwrap();
    let work = client
        .call::<AreaCreate>(create(
            AreaId::generate(),
            "Work",
            "violet",
            vec![other.run_id],
        ))
        .await
        .unwrap()
        .area;
    for (name, color) in [
        ("WORK", "violet"),
        (&"x".repeat(41), "violet"),
        ("  ", "violet"),
        ("Home", "Violet"),
    ] {
        let refused = client
            .call::<AreaCreate>(create(AreaId::generate(), name, color, Vec::new()))
            .await
            .unwrap_err();
        assert_eq!(
            refused.code, INVALID_PARAMS,
            "{name:?} {color:?}: {refused:?}"
        );
    }
    let long = client
        .call::<AreaCreate>(create(
            AreaId::generate(),
            &"é".repeat(40),
            "teal",
            Vec::new(),
        ))
        .await
        .unwrap()
        .area;

    let pin = ThreadUpdateParams {
        pinned: Some(true),
        ..attention(other.run_id, false, None)
    };
    let pinned = client
        .call::<ThreadUpdate>(pin.clone())
        .await
        .unwrap()
        .thread;
    assert!(pinned.pinned);
    client
        .until(|event| matches!(&event.event, ParallaxEvent::ThreadUpdated { thread } if thread.id == other.run_id && thread.pinned))
        .await;
    assert!(
        client
            .call::<ThreadUpdate>(pin)
            .await
            .unwrap()
            .thread
            .pinned
    );

    let listed = client.list().await;
    assert_eq!(listed.areas, [work.clone(), long.clone()], "oldest first");
    assert!(
        listed
            .threads
            .iter()
            .any(|thread| thread.id == other.run_id && thread.pinned)
    );
    let mut shell = host.client().await;
    let snapshot = shell
        .call::<OrchestrationSubscribeShell>(SubscribeShellParams { after_seq: None })
        .await
        .unwrap()
        .snapshot
        .unwrap();
    assert_eq!(snapshot.areas, listed.areas);

    client
        .call::<AreaDelete>(AreaDeleteParams { area: long.id })
        .await
        .unwrap();
    client.until(changed_to(std::slice::from_ref(&work))).await;
    client
        .call::<AreaDelete>(AreaDeleteParams { area: long.id })
        .await
        .unwrap();
    assert_eq!(client.list().await.areas, [work]);
}

/// An area keeps Spaces and repo entries but not the scratch entry, and loses a Space when
/// `space/delete` deletes it, appending `areas.changed`.
#[tokio::test]
async fn an_area_holds_spaces_until_they_are_deleted() {
    let host = Host::start(fake(editing()));
    let path = real_repo(host.work.path(), "app");
    let mut client = host.client().await;
    client.subscribe(0, None).await;
    let repo = client.add(&path).await;
    let space = client
        .call::<SpaceCreate>(SpaceCreateParams {
            id: RepoId::generate(),
            name: "Calculus".to_owned(),
            icon: None,
        })
        .await
        .unwrap()
        .repo;
    // A thread with no repo makes the scratch entry.
    client
        .call::<ThreadStart>(start_params(None, "Loose"))
        .await
        .unwrap();
    let scratch = client
        .list()
        .await
        .repos
        .into_iter()
        .find(|r| r.scratch)
        .unwrap();

    let area = client
        .call::<AreaCreate>(AreaCreateParams {
            repos: vec![space.id, scratch.id, RepoId::generate(), repo.id, space.id],
            ..create(AreaId::generate(), "School", "sky", Vec::new())
        })
        .await
        .unwrap()
        .area;
    assert_eq!(area.repos, [space.id, repo.id]);
    client.until(changed_to(std::slice::from_ref(&area))).await;

    client
        .call::<SpaceDelete>(SpaceDeleteParams { space: space.id })
        .await
        .unwrap();
    let left = Area {
        repos: vec![repo.id],
        ..area
    };
    client.until(changed_to(std::slice::from_ref(&left))).await;
    assert_eq!(client.list().await.areas, [left]);
}
