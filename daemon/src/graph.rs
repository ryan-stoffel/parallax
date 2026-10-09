//! The thread graph (0059 phase 2, PLX-644): each thread's runs, their attempts, execution nodes,
//! and runtime requests, as projections of its events.
//!
//! [`apply`] folds one event into them, and `Tx::stage` calls it for every thread event in the
//! event's own transaction, so the graph and the log commit together. A run is one counted turn:
//! `turnStarted` opens it with its first attempt and root node, and `turnFinished`, or the CLI's
//! exit (`agent.finished`), ends it. A follow-up's turn can start before the one it follows ends,
//! so a thread can have two open; output goes to the newest. A retry on another account
//! (`agent.accountFallback`) fails the attempt, and the run's next `turnStarted` adds one. Tool
//! calls, subagents, and permission requests are nodes; an interactive request asks the user a
//! question, so its node is a `user_input_request`. Permission requests are runtime requests
//! too, which a sidebar reads while they wait. `queue.updated` writes the queued runs.
//!
//! [`import`] folds a thread's stored events the first time the thread is touched after the
//! graph was added, so its runs are numbered from its start; the writer does it before a new
//! event's fold, and [`sweep`] imports the rest in the background, newest first.

use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    AgentApprovalDecision, AgentOutcome, AgentOutputItem, AgentSubagentStatus, AgentToolStatus,
    ApprovalId, LoggedEvent, ParallaxEvent, ProjectId, QueuedMessage, RunId, ThreadRun,
    ThreadRunStatus, TurnId,
};
use parallax_store::{GraphNode, GraphRun, RuntimeRequest, Store, StoreError};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use uuid::Uuid;

use crate::server::Daemon;
use crate::store::store_error;

/// Folds `event`, at `seq`, into thread `thread`'s graph. Returns the run it belongs to: for a
/// batch of output, the newest run it touched.
pub(crate) fn apply(
    db: &Store,
    thread: Uuid,
    seq: u64,
    time: Timestamp,
    project: Option<ProjectId>,
    event: &ParallaxEvent,
) -> Result<Option<Uuid>, StoreError> {
    match event {
        ParallaxEvent::AgentOutput { items, .. } => {
            let mut fold = Fold::new(db, thread, seq, time, project)?;
            let mut touched = fold.current().map(|run| Uuid::from(run.id));
            for item in items {
                fold.item(item, None)?;
                touched = fold.current().map(|run| run.id.into()).or(touched);
            }
            Ok(touched)
        }
        ParallaxEvent::AgentFinished { outcome, .. } => {
            let status = match outcome {
                AgentOutcome::Completed { .. } => ThreadRunStatus::Completed,
                AgentOutcome::Failed { .. } => ThreadRunStatus::Failed,
                AgentOutcome::Interrupted => ThreadRunStatus::Interrupted,
                AgentOutcome::Cancelled | AgentOutcome::Unknown => ThreadRunStatus::Cancelled,
            };
            let mut fold = Fold::new(db, thread, seq, time, project)?;
            let last = fold.current().map(|run| run.id.into());
            while let Some(run) = fold.open.pop() {
                fold.end(run, status)?;
            }
            // What the CLI left open ended with it, a background subagent included.
            db.end_open_nodes(thread, status_name(status))?;
            db.end_pending_requests(thread, "cancelled")?;
            Ok(last)
        }
        ParallaxEvent::AgentAccountFallback { .. } => {
            let fold = Fold::new(db, thread, seq, time, project)?;
            for run in &fold.open {
                if let Some(attempt) = run.attempt {
                    db.set_attempt_status(thread, run.id.into(), attempt, "failed")?;
                }
                let run = ThreadRun {
                    status: ThreadRunStatus::Starting,
                    ..run.clone()
                };
                put_run(db, thread, &run, None)?;
            }
            Ok(fold.current().map(|run| run.id.into()))
        }
        ParallaxEvent::QueueUpdated { messages, held, .. } => {
            let queued = messages
                .iter()
                .enumerate()
                .map(|(position, message)| queued_run(thread, position, message, *held))
                .collect::<Vec<_>>();
            db.replace_queued_runs(thread, &queued)?;
            Ok(None)
        }
        _ => Ok(None),
    }
}

/// A batch's fold: the thread's open runs, oldest first, which its items change.
struct Fold<'a> {
    db: &'a Store,
    thread: Uuid,
    seq: u64,
    time: Timestamp,
    project: Option<ProjectId>,
    open: Vec<ThreadRun>,
}

impl<'a> Fold<'a> {
    fn new(
        db: &'a Store,
        thread: Uuid,
        seq: u64,
        time: Timestamp,
        project: Option<ProjectId>,
    ) -> Result<Self, StoreError> {
        let open = db
            .open_graph_runs(thread)?
            .iter()
            .filter_map(parse)
            .collect();
        Ok(Self {
            db,
            thread,
            seq,
            time,
            project,
            open,
        })
    }

    /// The run output goes to: the newest open one.
    fn current(&self) -> Option<&ThreadRun> {
        self.open.last()
    }

    /// Folds one item. `parent` is the subagent node a subagent's item goes under.
    fn item(&mut self, item: &AgentOutputItem, parent: Option<&str>) -> Result<(), StoreError> {
        match item {
            AgentOutputItem::TurnStarted {
                turn_id,
                text,
                wake,
                from,
                images,
                threads,
            } => self.start(*turn_id, |run| {
                run.text.clone_from(text);
                run.wake = *wake;
                run.from = *from;
                run.images = u32::try_from(images.len()).unwrap_or(u32::MAX);
                run.threads.clone_from(threads);
            }),
            AgentOutputItem::TurnFinished { turn_id, .. } => {
                // A turn with no id is the first of its CLI: the oldest still open.
                let at = match turn_id {
                    Some(id) => self.open.iter().position(|run| run.id == *id),
                    None => (!self.open.is_empty()).then_some(0),
                };
                self.end_at(at, ThreadRunStatus::Completed)
            }
            AgentOutputItem::FollowUpDropped { turn_id } => {
                let at = self.open.iter().position(|run| run.id == *turn_id);
                self.end_at(at, ThreadRunStatus::Cancelled)
            }
            AgentOutputItem::ToolCall { call_id, name, .. } => {
                let Some(run) = self.current().map(|run| run.id) else {
                    return Ok(());
                };
                let parent = parent.map_or_else(|| root(run), str::to_owned);
                let payload = serde_json::json!({ "callId": call_id, "name": name });
                self.node(
                    tool(run, call_id),
                    Some(parent),
                    "tool_call",
                    "running",
                    &payload,
                )
            }
            AgentOutputItem::ToolResult {
                call_id, status, ..
            } => {
                let Some(run) = self.current().map(|run| run.id) else {
                    return Ok(());
                };
                let status = match status {
                    AgentToolStatus::Ok => "completed",
                    AgentToolStatus::Error | AgentToolStatus::Denied | AgentToolStatus::Unknown => {
                        "failed"
                    }
                };
                self.db
                    .set_node_status(self.thread, &tool(run, call_id), status)
            }
            AgentOutputItem::ApprovalRequested {
                approval_id,
                interactive,
                ..
            } => self.request(item, *approval_id, *interactive, parent),
            AgentOutputItem::ApprovalResolved {
                approval_id,
                decision,
                ..
            } => self.resolve(*approval_id, *decision),
            AgentOutputItem::Subagent { call_id, item, .. } => self.subagent(call_id, item),
            AgentOutputItem::SubagentFinished {
                call_id, status, ..
            } => {
                let Some(run) = self.current().map(|run| run.id) else {
                    return Ok(());
                };
                let status = match status {
                    AgentSubagentStatus::Completed => "completed",
                    AgentSubagentStatus::Failed => "failed",
                    AgentSubagentStatus::Stopped | AgentSubagentStatus::Unknown => "cancelled",
                };
                self.db
                    .set_node_status(self.thread, &format!("{run}/subagent/{call_id}"), status)
            }
            _ => Ok(()),
        }
    }

    /// Ends the open run at `at`, if there is one, with `status`.
    fn end_at(&mut self, at: Option<usize>, status: ThreadRunStatus) -> Result<(), StoreError> {
        match at {
            Some(at) => {
                let run = self.open.remove(at);
                self.end(run, status)
            }
            None => Ok(()),
        }
    }

    /// A permission request, `item`: a node of the current run, which waits for it, and a
    /// runtime request a sidebar reads while it waits.
    fn request(
        &mut self,
        item: &AgentOutputItem,
        approval_id: ApprovalId,
        interactive: bool,
        parent: Option<&str>,
    ) -> Result<(), StoreError> {
        let run = self.current().map(|run| run.id);
        let node = run.map(|run| format!("{run}/request/{approval_id}"));
        if let (Some(run), Some(node)) = (run, &node) {
            let kind = if interactive {
                "user_input_request"
            } else {
                "approval_request"
            };
            let parent = parent.map_or_else(|| root(run), str::to_owned);
            let payload = serde_json::json!({ "requestId": approval_id });
            self.node(node.clone(), Some(parent), kind, "waiting", &payload)?;
            self.set_current_status(ThreadRunStatus::Waiting)?;
        }
        let Ok(run_id) = RunId::try_from(self.thread) else {
            return Ok(());
        };
        let request = LoggedEvent {
            seq: self.seq,
            time: self.time,
            project: self.project,
            event: ParallaxEvent::AgentOutput {
                run_id,
                items: vec![item.clone()],
                compacted: None,
            },
        };
        self.db.put_runtime_request(&RuntimeRequest {
            id: approval_id.into(),
            thread_id: self.thread,
            node_id: node,
            status: "pending".to_owned(),
            payload: serde_json::to_string(&request).unwrap_or_default(),
        })
    }

    /// How permission request `approval_id` ended. A run that waited on it alone runs again.
    fn resolve(
        &mut self,
        approval_id: ApprovalId,
        decision: AgentApprovalDecision,
    ) -> Result<(), StoreError> {
        let status = match decision {
            AgentApprovalDecision::Withdrawn => "cancelled",
            AgentApprovalDecision::Expired => "expired",
            _ => "resolved",
        };
        let id = Uuid::from(approval_id);
        if let Some(node) = self.db.runtime_request_node(self.thread, id)? {
            self.db
                .set_runtime_request_status(self.thread, id, status)?;
            if let Some(node) = node {
                self.db.set_node_status(self.thread, &node, "completed")?;
            }
        }
        if self
            .current()
            .is_some_and(|run| run.status == ThreadRunStatus::Waiting)
            && self.db.pending_requests(Some(self.thread))?.is_empty()
        {
            self.set_current_status(ThreadRunStatus::Running)?;
        }
        Ok(())
    }

    /// An item of the agent's own subagent `call_id`: its node, made on its first item under
    /// the tool call that started it, with its tool calls and requests under that.
    fn subagent(&mut self, call_id: &str, item: &AgentOutputItem) -> Result<(), StoreError> {
        let Some(run) = self.current().map(|run| run.id) else {
            return Ok(());
        };
        let node = format!("{run}/subagent/{call_id}");
        if self.db.node_status(self.thread, &node)?.is_none() {
            let payload = serde_json::json!({ "callId": call_id });
            self.node(
                node.clone(),
                Some(tool(run, call_id)),
                "subagent",
                "running",
                &payload,
            )?;
        }
        match item {
            AgentOutputItem::ToolCall { .. }
            | AgentOutputItem::ToolResult { .. }
            | AgentOutputItem::ApprovalRequested { .. }
            | AgentOutputItem::ApprovalResolved { .. }
            | AgentOutputItem::Subagent { .. }
            | AgentOutputItem::SubagentFinished { .. } => self.item(item, Some(&node)),
            _ => Ok(()),
        }
    }

    /// Starts run `turn_id`, or one with a new id, with `fill` setting its message. A run that
    /// exists and isn't queued gets another attempt instead: a retry after a fallback, or a
    /// first turn's, which has no id.
    fn start(
        &mut self,
        turn_id: Option<TurnId>,
        fill: impl FnOnce(&mut ThreadRun),
    ) -> Result<(), StoreError> {
        let existing = match turn_id {
            Some(id) => self
                .db
                .graph_run(self.thread, id.into())?
                .as_ref()
                .and_then(parse),
            None => self
                .open
                .iter()
                .rev()
                .find(|run| run.status == ThreadRunStatus::Starting)
                .cloned(),
        };
        if let Some(mut run) = existing.filter(|run| run.status != ThreadRunStatus::Queued) {
            let reason = if run.status == ThreadRunStatus::Starting {
                "provider_recovery"
            } else {
                "retry"
            };
            let attempt = run.attempt.unwrap_or(0) + 1;
            run.attempt = Some(attempt);
            run.status = ThreadRunStatus::Running;
            run.completed_at = None;
            self.db
                .put_run_attempt(run.id.into(), attempt, self.thread, reason, "running")?;
            self.db
                .set_node_status(self.thread, &root(run.id), "running")?;
            put_run(self.db, self.thread, &run, None)?;
            self.open.retain(|open| open.id != run.id);
            self.open.push(run);
            return Ok(());
        }
        let mut run = ThreadRun {
            id: turn_id.unwrap_or_else(TurnId::generate),
            status: ThreadRunStatus::Running,
            ordinal: Some(self.db.next_run_ordinal(self.thread)?),
            position: None,
            attempt: Some(1),
            text: None,
            images: 0,
            threads: Vec::new(),
            from: None,
            wake: false,
            queue_held: false,
            started_at: Some(self.time),
            completed_at: None,
        };
        fill(&mut run);
        put_run(self.db, self.thread, &run, Some(self.seq))?;
        self.db
            .put_run_attempt(run.id.into(), 1, self.thread, "initial", "running")?;
        self.node(
            root(run.id),
            None,
            "root_turn",
            "running",
            &serde_json::json!({}),
        )?;
        self.open.push(run);
        Ok(())
    }

    /// Ends `run`, which left `open`, with `status`: its attempt and its root node. A subagent
    /// it started can work on after its turn; the CLI's exit ends that.
    fn end(&self, mut run: ThreadRun, status: ThreadRunStatus) -> Result<(), StoreError> {
        let word = status_name(status);
        run.status = status;
        run.completed_at = Some(self.time);
        if let Some(attempt) = run.attempt {
            self.db
                .set_attempt_status(self.thread, run.id.into(), attempt, word)?;
        }
        self.db.set_node_status(self.thread, &root(run.id), word)?;
        put_run(self.db, self.thread, &run, None)
    }

    fn set_current_status(&mut self, status: ThreadRunStatus) -> Result<(), StoreError> {
        if let Some(run) = self.open.last_mut() {
            run.status = status;
            put_run(self.db, self.thread, run, None)?;
        }
        Ok(())
    }

    fn node(
        &self,
        id: String,
        parent_id: Option<String>,
        kind: &str,
        status: &str,
        payload: &serde_json::Value,
    ) -> Result<(), StoreError> {
        let run_id = id
            .split('/')
            .next()
            .and_then(|run| Uuid::parse_str(run).ok());
        self.db.put_node(&GraphNode {
            id,
            thread_id: self.thread,
            run_id,
            parent_id,
            kind: kind.to_owned(),
            status: status.to_owned(),
            payload: payload.to_string(),
        })
    }
}

fn root(run: TurnId) -> String {
    format!("{run}/root")
}

fn tool(run: TurnId, call_id: &str) -> String {
    format!("{run}/tool/{call_id}")
}

/// A stored run's payload, or `None`, with a warning, if it's corrupt.
fn parse(row: &GraphRun) -> Option<ThreadRun> {
    match serde_json::from_str(&row.payload) {
        Ok(run) => Some(run),
        Err(error) => {
            warn!(run = %row.id, %error, "a stored run is corrupt; leaving it out");
            None
        }
    }
}

/// Writes `run`, with the `seq` that started it when it starts now.
fn put_run(
    db: &Store,
    thread: Uuid,
    run: &ThreadRun,
    first_seq: Option<u64>,
) -> Result<(), StoreError> {
    let first_seq = match first_seq {
        Some(seq) => Some(seq),
        None => db
            .graph_run(thread, run.id.into())?
            .and_then(|row| row.first_seq),
    };
    db.put_graph_run(&GraphRun {
        id: run.id.into(),
        thread_id: thread,
        ordinal: run.ordinal,
        status: status_name(run.status).to_owned(),
        position: run.position,
        first_seq,
        attempt: run.attempt,
        payload: serde_json::to_string(run).unwrap_or_default(),
    })
}

fn queued_run(thread: Uuid, position: usize, message: &QueuedMessage, held: bool) -> GraphRun {
    let run = ThreadRun {
        id: message.id,
        status: ThreadRunStatus::Queued,
        ordinal: None,
        position: Some(u32::try_from(position).unwrap_or(u32::MAX)),
        attempt: None,
        text: Some(message.text.clone()),
        images: message.images,
        threads: message.threads.clone(),
        from: None,
        wake: false,
        queue_held: held,
        started_at: None,
        completed_at: None,
    };
    GraphRun {
        id: run.id.into(),
        thread_id: thread,
        ordinal: None,
        status: status_name(run.status).to_owned(),
        position: run.position,
        first_seq: None,
        attempt: None,
        payload: serde_json::to_string(&run).unwrap_or_default(),
    }
}

/// A run status's stored name, as its JSON spells it.
fn status_name(status: ThreadRunStatus) -> &'static str {
    match status {
        ThreadRunStatus::Queued => "queued",
        ThreadRunStatus::Starting => "starting",
        ThreadRunStatus::Running => "running",
        ThreadRunStatus::Waiting => "waiting",
        ThreadRunStatus::Completed => "completed",
        ThreadRunStatus::Interrupted => "interrupted",
        ThreadRunStatus::Failed => "failed",
        ThreadRunStatus::Cancelled | ThreadRunStatus::Unknown => "cancelled",
    }
}

/// Folds thread `thread`'s stored events into the graph, in order, and tags each with its run.
/// The caller records the import.
pub(crate) fn import(db: &Store, thread: Uuid) -> Result<(), StoreError> {
    let (events, _) = db.run_events(thread, 0, usize::MAX, usize::MAX)?;
    for stored in events {
        // A kind this build can't read changes nothing.
        let Ok(event) = serde_json::from_str::<ParallaxEvent>(&stored.payload) else {
            continue;
        };
        let project = stored
            .project_id
            .and_then(|id| ProjectId::try_from(id).ok());
        if let Some(run) = apply(db, thread, stored.seq, stored.time, project, &event)? {
            db.set_event_run(stored.seq, run)?;
        }
    }
    Ok(())
}

/// Imports every thread the graph doesn't have yet, newest first, one writer job each, so no job
/// holds the writer for long, until `stop`. A thread an event or subscription touches first is
/// imported then, ahead of this.
pub(crate) async fn sweep(daemon: Arc<Daemon>, stop: CancellationToken) {
    let threads = daemon
        .reader
        .run(&CancellationToken::new(), |db| {
            db.threads_to_import().map_err(|error| store_error(&error))
        })
        .await;
    let threads = match threads {
        Ok(threads) => threads,
        Err(error) => {
            warn!(error = %error.message, "could not list the threads to import into the graph");
            return;
        }
    };
    if threads.is_empty() {
        return;
    }
    let started = std::time::Instant::now();
    let count = threads.len();
    for thread in threads {
        if stop.is_cancelled() {
            return;
        }
        let imported = daemon
            .store
            .run(&CancellationToken::new(), move |tx| {
                tx.import_thread(thread)
            })
            .await;
        if let Err(error) = imported {
            warn!(%thread, error = %error.message, "could not import a thread into the graph");
        }
    }
    info!(
        threads = count,
        millis = started.elapsed().as_millis(),
        "imported the threads into the graph"
    );
}

/// Thread `thread`'s runs, as `orchestration/subscribeThread` sends them.
pub(crate) fn runs(db: &Store, thread: Uuid) -> Result<Vec<ThreadRun>, ErrorObject> {
    Ok(db
        .graph_runs(thread)
        .map_err(|error| store_error(&error))?
        .iter()
        .filter_map(parse)
        .collect())
}

/// The permission requests thread `thread`, or every thread, waits on, oldest first.
pub(crate) fn requests(db: &Store, thread: Option<Uuid>) -> Result<Vec<LoggedEvent>, ErrorObject> {
    Ok(db
        .pending_requests(thread)
        .map_err(|error| store_error(&error))?
        .into_iter()
        .filter_map(|request| serde_json::from_str(&request.payload).ok())
        .collect())
}

#[cfg(test)]
mod tests;
