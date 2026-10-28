//! `thread/setSpace` (0090, PLX-1108): a thread added to a Space keeps working where it was, gets
//! the Space's instructions in its next CLI process, and leaves the Space when it's deleted.

use parallax_protocol::methods::{RepoUpdate, SpaceCreate, SpaceDelete, ThreadSetSpace};
use parallax_protocol::{
    RepoUpdateParams, SpaceCreateParams, SpaceDeleteParams, Thread, ThreadSetSpaceParams,
};

use super::*;

/// The fake CLI as a backend that records each run's instructions.
struct WithInstructions {
    fake: FakeBackend,
    seen: Arc<Mutex<Vec<Option<String>>>>,
}

impl Backend for WithInstructions {
    fn name(&self) -> &str {
        self.fake.name()
    }

    fn capabilities(&self) -> Capabilities {
        self.fake.capabilities()
    }

    fn start(&self, request: RunRequest) -> Result<Started, StartError> {
        self.seen.lock().unwrap().push(request.instructions.clone());
        self.fake.start(request)
    }
}

impl Conn {
    async fn set_space(
        &mut self,
        threads: Vec<RunId>,
        space: Option<RepoId>,
    ) -> Result<Vec<Thread>, ErrorObject> {
        self.call::<ThreadSetSpace>(ThreadSetSpaceParams { threads, space })
            .await
            .map(|result| result.threads)
    }
}

#[tokio::test]
async fn a_thread_added_to_a_space_gets_its_instructions_and_leaves_when_it_goes() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut backends = BackendRegistry::new();
    backends.register(
        Provider::Anthropic,
        Arc::new(WithInstructions {
            fake: fake_backend(editing()),
            seen: Arc::clone(&seen),
        }),
    );
    let host = Host::start(backends);
    let mut client = host.client().await;
    let chat = client
        .call::<ThreadStart>(start_params(None, "Plan a trip"))
        .await
        .unwrap()
        .thread;
    let mut runs = host.client().await;
    runs.subscribe(0, Some(scope(chat.repo))).await;
    runs.until(updated_to(AgentStatus::Completed)).await;
    let space = client
        .call::<SpaceCreate>(SpaceCreateParams {
            id: RepoId::generate(),
            name: "Travel".to_owned(),
            icon: None,
        })
        .await
        .unwrap()
        .repo;
    client
        .call::<RepoUpdate>(RepoUpdateParams {
            repo: space.id,
            icon: None,
            name: None,
            instructions: Some("Answer in French.".to_owned()),
            files: None,
        })
        .await
        .unwrap();

    let added = client
        .set_space(vec![chat.id], Some(space.id))
        .await
        .unwrap();
    assert_eq!(added[0].space, Some(space.id));
    assert_eq!(added[0].repo, chat.repo, "it keeps working where it was");
    let listed = client.list().await;
    let listed = listed.threads.iter().find(|t| t.id == chat.id).unwrap();
    assert_eq!(listed.space, Some(space.id));

    // Its next CLI process gets the Space's instructions; its first had none.
    client
        .call::<AgentSend>(message(chat.id, "And a packing list"))
        .await
        .unwrap();
    runs.until(updated_to(AgentStatus::Completed)).await;
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen[0], None);
    assert!(
        seen.last()
            .unwrap()
            .as_deref()
            .unwrap()
            .contains("Answer in French."),
        "{seen:?}"
    );

    // A thread started in the Space lives there, and no thread or no Space is refused.
    let inside = client
        .call::<ThreadStart>(start_params(Some(space.id), "Book a hotel"))
        .await
        .unwrap()
        .thread;
    let refused = client.set_space(vec![inside.id], None).await.unwrap_err();
    assert_eq!(refused.code, INVALID_PARAMS);
    let none = client
        .set_space(Vec::new(), Some(space.id))
        .await
        .unwrap_err();
    assert_eq!(none.code, INVALID_PARAMS);
    let unknown = client
        .set_space(vec![chat.id], Some(RepoId::generate()))
        .await
        .unwrap_err();
    assert_eq!(kind(&unknown), ErrorKind::RepoNotFound);

    // Deleting the Space deletes what started there and takes the added thread out.
    client
        .call::<SpaceDelete>(SpaceDeleteParams { space: space.id })
        .await
        .unwrap();
    let listed = client.list().await;
    assert!(listed.threads.iter().all(|t| t.id != inside.id));
    let chat = listed.threads.iter().find(|t| t.id == chat.id).unwrap();
    assert_eq!(chat.space, None);
}
