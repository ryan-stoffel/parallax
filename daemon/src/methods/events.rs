//! `events/subscribe` and `events/unsubscribe`, and the cursors that deliver a connection's
//! events.

use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::ErrorObject;
use parallax_protocol::{
    ErrorKind, EventsSubscribeParams, ParallaxEvent, ProjectId, RunId, SubscriptionId,
};
use serde::Serialize;
use serde_json::value::RawValue;

use super::Context;
use crate::event_log::{Entry, EventLog, Gone, is_approval, raw};
use crate::store::store_error;

/// One subscription's place in the event log.
#[derive(Debug)]
pub(crate) struct Cursor {
    pub subscription: SubscriptionId,
    /// The project whose events it gets, or `None` for host-level events.
    pub project: Option<ProjectId>,
    /// Every project's events and the host's, whatever `project` says: a shell subscription's
    /// (0059's `orchestration/subscribeShell`).
    pub all: bool,
    /// The `seq` of the last event delivered or skipped.
    pub after: u64,
    /// Only this run's events (PLX-453).
    pub run: Option<RunId>,
    /// `agent.output` cut down to its approval items, and left out when it has none (PLX-453).
    pub shell: bool,
}

impl Cursor {
    /// Whether this subscription's scope, `run`, and `shell` keep `entry`.
    pub(crate) fn keeps(&self, entry: &Entry) -> bool {
        (self.all || entry.project == self.project)
            && self.run.is_none_or(|run| entry.run == Some(run))
            && !(self.shell && entry.kind() == AGENT_OUTPUT && !entry.approvals)
    }

    /// `entry`'s event as this subscription delivers it, when that differs from its JSON: a
    /// `shell` subscription's `agent.output` cut down to its approval items.
    fn view(&self, entry: &Entry) -> Option<Box<RawValue>> {
        if !self.shell || entry.kind() != AGENT_OUTPUT {
            return None;
        }
        let ParallaxEvent::AgentOutput {
            run_id,
            items,
            compacted,
        } = entry.event().into_owned()
        else {
            return None;
        };
        Some(raw(&ParallaxEvent::AgentOutput {
            run_id,
            items: items.into_iter().filter(is_approval).collect(),
            compacted,
        }))
    }
}

const AGENT_OUTPUT: &str = "agent.output";

/// One event for one subscription.
#[derive(Debug)]
pub(crate) struct Delivery {
    pub subscription: SubscriptionId,
    pub entry: Arc<Entry>,
    /// The subscription's own view of the event, when it differs from the entry's JSON.
    pub view: Option<Box<RawValue>>,
}

/// `events/event`'s params with the event's JSON embedded as it is, not serialized again.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryParams<'a> {
    subscription: SubscriptionId,
    seq: u64,
    time: Timestamp,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<ProjectId>,
    event: &'a RawValue,
}

impl Delivery {
    pub fn params(&self) -> DeliveryParams<'_> {
        DeliveryParams {
            subscription: self.subscription,
            seq: self.entry.seq,
            time: self.entry.time,
            project: self.entry.project,
            event: self.view.as_deref().unwrap_or(&self.entry.json),
        }
    }
}

/// Checks a subscription and returns its cursor. The connection's writer sends the response and
/// then starts delivering from the cursor, so no event can arrive before the response.
pub(crate) async fn subscribe(
    context: &Context,
    params: EventsSubscribeParams,
) -> Result<Cursor, ErrorObject> {
    if params.project.is_none() && (params.run.is_some() || params.shell) {
        // A run's events and approvals are never host-level, so this would deliver nothing.
        return Err(ErrorObject::invalid_params("run and shell need a project"));
    }
    if let Some(project) = params.project {
        let exists = context
            .daemon
            .reader
            .run(&context.cancel, move |store| {
                // A normal thread's events go to its repo entry's id (#110).
                let is_project = store
                    .get_project(project.into())
                    .map_err(|error| store_error(&error))?
                    .is_some();
                Ok(is_project
                    || store
                        .get_repo(project.into())
                        .map_err(|error| store_error(&error))?
                        .is_some())
            })
            .await?;
        if !exists {
            return Err(ErrorObject::parallax(
                ErrorKind::ProjectNotFound,
                format!("no project has id {project}"),
            ));
        }
    }
    context
        .daemon
        .log
        .check(params.after)
        .map_err(|gone| resync_required(params.after, gone))?;
    Ok(Cursor {
        subscription: SubscriptionId::generate(),
        project: params.project,
        all: false,
        after: params.after,
        run: params.run,
        shell: params.shell,
    })
}

fn resync_required(after: u64, gone: Gone) -> ErrorObject {
    let message = match gone {
        Gone::Dropped => format!("the events after seq {after} are no longer available"),
        Gone::Unknown { head } => {
            format!("seq {after} is not in this event log, whose last event is {head}")
        }
    };
    ErrorObject::parallax(ErrorKind::ResyncRequired, message)
}

/// A connection's subscriptions.
#[derive(Debug, Default)]
pub(crate) struct Cursors {
    cursors: Vec<Cursor>,
    turn: usize,
}

impl Cursors {
    pub fn add(&mut self, cursor: Cursor) {
        self.cursors.push(cursor);
    }

    /// Ends a subscription. Ending one that doesn't exist does nothing.
    pub fn remove(&mut self, subscription: SubscriptionId) {
        self.cursors
            .retain(|cursor| cursor.subscription != subscription);
    }

    /// The next event for one of the subscriptions, which take turns so one busy project can't
    /// hold up another.
    ///
    /// # Errors
    ///
    /// The subscription whose next events the log no longer has, which this removes.
    pub fn next(&mut self, log: &EventLog) -> Result<Option<Delivery>, SubscriptionId> {
        for _ in 0..self.cursors.len() {
            let index = self.turn % self.cursors.len();
            self.turn = self.turn.wrapping_add(1);
            let cursor = &mut self.cursors[index];
            let Ok((event, seq)) = log.next_matching(cursor.after, |entry| cursor.keeps(entry))
            else {
                return Err(self.cursors.remove(index).subscription);
            };
            cursor.after = seq;
            if let Some(entry) = event {
                return Ok(Some(Delivery {
                    subscription: cursor.subscription,
                    view: cursor.view(&entry),
                    entry,
                }));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use parallax_protocol::{
        AgentApprovalBy, AgentApprovalDecision, AgentOutputItem, ApprovalId, ParallaxEvent,
        ProjectId, RunId, SubscriptionId,
    };

    use super::{Cursor, Cursors};
    use crate::event_log::EventLog;

    fn cursor(project: Option<ProjectId>, after: u64) -> Cursor {
        Cursor {
            subscription: SubscriptionId::generate(),
            project,
            all: false,
            after,
            run: None,
            shell: false,
        }
    }

    fn drain(cursors: &mut Cursors, log: &EventLog) -> Vec<(SubscriptionId, u64)> {
        let mut delivered = Vec::new();
        while let Some(event) = cursors.next(log).unwrap() {
            delivered.push((event.subscription, event.entry.seq));
        }
        delivered
    }

    #[test]
    fn each_subscription_gets_its_own_events_after_its_seq() {
        let log = EventLog::new(10);
        let project = ProjectId::generate();
        for owner in [None, Some(project), None] {
            log.append_in_memory(Timestamp::now(), owner, ParallaxEvent::Unknown);
        }
        let host = cursor(None, 0);
        let (host_id, late_id) = (host.subscription, SubscriptionId::generate());
        let project_cursor = cursor(Some(project), 0);
        let project_id = project_cursor.subscription;
        let mut cursors = Cursors::default();
        cursors.add(host);
        cursors.add(project_cursor);
        cursors.add(Cursor {
            subscription: late_id,
            project: None,
            all: false,
            after: 1,
            run: None,
            shell: false,
        });

        let mut delivered = drain(&mut cursors, &log);
        delivered.sort_by_key(|&(subscription, seq)| (seq, subscription));
        let mut expected = vec![(host_id, 1), (project_id, 2), (host_id, 3), (late_id, 3)];
        expected.sort_by_key(|&(subscription, seq)| (seq, subscription));
        assert_eq!(delivered, expected);

        log.append_in_memory(Timestamp::now(), None, ParallaxEvent::Unknown);
        cursors.remove(host_id);
        assert_eq!(drain(&mut cursors, &log), [(late_id, 4)]);
    }

    #[test]
    fn run_and_shell_cursors_skip_what_they_filter_out_and_keep_the_order() {
        let log = EventLog::new(20);
        let project = ProjectId::generate();
        let (open, sibling) = (RunId::generate(), RunId::generate());
        let text = AgentOutputItem::Text {
            message_id: None,
            text: "Reading the code.".to_owned(),
        };
        let approval = AgentOutputItem::ApprovalResolved {
            approval_id: ApprovalId::generate(),
            decision: AgentApprovalDecision::Allowed,
            by: AgentApprovalBy::User,
            always: false,
            message: None,
        };
        let output = |run_id, items: Vec<AgentOutputItem>| ParallaxEvent::AgentOutput {
            run_id,
            items,
            compacted: None,
        };
        for event in [
            output(open, vec![text.clone()]),                      // 1
            output(sibling, vec![text.clone(), approval.clone()]), // 2
            ParallaxEvent::AgentWakeupsPaused { run_id: sibling }, // 3
            output(open, vec![approval.clone()]),                  // 4
            output(sibling, vec![text.clone()]),                   // 5
        ] {
            log.append_in_memory(Timestamp::now(), Some(project), event);
        }
        let run = Cursor {
            run: Some(open),
            ..cursor(Some(project), 0)
        };
        let shell = Cursor {
            shell: true,
            ..cursor(Some(project), 0)
        };
        let (run_id, shell_id) = (run.subscription, shell.subscription);
        let mut cursors = Cursors::default();
        cursors.add(run);
        cursors.add(shell);

        let mut delivered = Vec::new();
        while let Some(event) = cursors.next(&log).unwrap() {
            let sent: ParallaxEvent = serde_json::from_str(event.params().event.get()).unwrap();
            delivered.push((event.subscription, event.entry.seq, sent));
        }
        let of = |id| {
            delivered
                .iter()
                .filter(|(subscription, ..)| *subscription == id)
                .map(|(_, seq, event)| (*seq, event.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            of(run_id),
            [
                (1, output(open, vec![text.clone()])),
                (4, output(open, vec![approval.clone()]))
            ]
        );
        assert_eq!(
            of(shell_id),
            [
                (2, output(sibling, vec![approval.clone()])),
                (3, ParallaxEvent::AgentWakeupsPaused { run_id: sibling }),
                (4, output(open, vec![approval])),
            ]
        );
        // Both cursors moved past the last event, which neither delivered.
        assert!(cursors.cursors.iter().all(|cursor| cursor.after == 5));
    }

    #[test]
    fn a_cursor_behind_the_retention_is_reported_and_removed() {
        let log = EventLog::new(1);
        log.append_in_memory(Timestamp::now(), None, ParallaxEvent::Unknown);
        log.append_in_memory(Timestamp::now(), None, ParallaxEvent::Unknown);
        let lagging = cursor(None, 0);
        let id = lagging.subscription;
        let mut cursors = Cursors::default();
        cursors.add(lagging);
        assert_eq!(cursors.next(&log).unwrap_err(), id);
        assert!(matches!(cursors.next(&log), Ok(None)));
    }
}
