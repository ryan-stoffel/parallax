//! `guest/*` (0108), behind the `guestLinks` capability, and what a guest's connection may call.
//!
//! The owner, from a full-access session, makes a link with `guest/create`, reads them with
//! `guest/list`, ends one with `guest/revoke`, and sends or drops a guest's waiting message with
//! `guest/send` and `guest/dismiss`. A guest sends one with `guest/suggest` while its link allows
//! it. Links themselves live in [`crate::server::remote::guest`].
//!
//! [`admits`] runs before any method a guest's connection calls: a method its level allows
//! ([`read_only::allows_guest`]), on a live link, within [`guest::MAX_READS`] a minute, for the
//! link's own thread id.

use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::methods::RequestName;
use parallax_protocol::{
    ClientInfo, ErrorKind, GuestCreateParams, GuestCreateResult, GuestEntry, GuestHistoryParams,
    GuestHistoryResult, GuestListParams, GuestListResult, GuestRevokeParams, GuestSnapshot,
    GuestSubscribeParams, GuestSubscribeResult, GuestSuggestParams, GuestSuggestResult,
    GuestSuggestionParams, GuestThread, LoggedEvent, PROTOCOL_VERSION, RunId,
    SubscribeThreadParams, ThreadHistoryParams, ThreadSnapshot,
};

use super::agent::{check_message, plain_message};
use super::{Context, Cursor, Session, read_only};
use crate::server::remote::guest::{self, Link, refusal};
use crate::store::store_error;

/// What a guest hears for a method outside its list, another thread, or an ended link.
const OUTSIDE: &str = "A guest link shows one thread and can't call this.";

/// Whether guest `link`'s connection may make `request`: a guest method, on a live link, within its
/// reads a minute, naming the link's thread wherever the method names one.
pub(super) fn admits(link: &Link, request: &Request) -> Result<(), ErrorObject> {
    let Some(method) =
        RequestName::from_name(&request.method).filter(|method| read_only::allows_guest(*method))
    else {
        return Err(refusal(OUTSIDE));
    };
    if !link.live() {
        return Err(refusal("This guest link has ended."));
    }
    if !link.take_read() {
        return Err(ErrorObject::parallax(
            ErrorKind::GuestRateLimited,
            "A guest gets 10 reads a minute. Try again shortly.",
        ));
    }
    let thread: Option<RunId> = match method {
        RequestName::GuestSubscribe => request
            .params::<GuestSubscribeParams>()
            .ok()
            .map(|p| p.thread_id),
        RequestName::GuestHistory => request
            .params::<GuestHistoryParams>()
            .ok()
            .map(|p| p.thread_id),
        RequestName::GuestSuggest => request
            .params::<GuestSuggestParams>()
            .ok()
            .map(|p| p.thread_id),
        // Ends one of the connection's own subscriptions, which name no thread.
        RequestName::EventsUnsubscribe => return Ok(()),
        _ => None,
    };
    if thread != Some(link.thread) {
        return Err(refusal(OUTSIDE));
    }
    Ok(())
}

/// The session plxd gives a guest's connection, which sends no `initialize` (0108).
pub(crate) fn session() -> Session {
    Session {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: "guest".to_owned(),
            version: String::new(),
            machine_id: None,
        },
        resync_notice: false,
        legacy: false,
    }
}

/// `guest/subscribe`: the thread's subscription, as `orchestration/subscribeThread` makes it,
/// with a snapshot built from scratch by [`snapshot`]. Its events go out as `guest/event`, which
/// the connection builds the same way.
pub(super) async fn subscribe(
    context: &Context,
    params: GuestSubscribeParams,
) -> Result<(GuestSubscribeResult, Cursor), ErrorObject> {
    let GuestSubscribeParams {
        thread_id,
        after_seq,
    } = params;
    let full = SubscribeThreadParams {
        thread_id,
        after_seq,
    };
    let (result, cursor) = super::orchestration::subscribe_thread(context, full).await?;
    let snapshot = match result.snapshot {
        Some(full) => {
            let title = title(context, thread_id).await?;
            Some(snapshot(&full, title))
        }
        None => None,
    };
    let result = GuestSubscribeResult {
        subscription: result.subscription,
        snapshot,
    };
    Ok((result, cursor))
}

/// `guest/history`: the page `orchestration/threadHistory` reads, built from scratch.
pub(super) async fn history(
    context: &Context,
    params: GuestHistoryParams,
) -> Result<GuestHistoryResult, ErrorObject> {
    let GuestHistoryParams { thread_id, before } = params;
    let full = ThreadHistoryParams { thread_id, before };
    let page = super::orchestration::thread_history(context, full).await?;
    Ok(GuestHistoryResult {
        entries: entries(&page.events, thread_id),
        more: page.more,
    })
}

/// What `full` shows a guest: the thread's id, title, status, and age, and its events as
/// [`guest::guest_entry`] builds them. Nothing else of it is read.
fn snapshot(full: &ThreadSnapshot, title: Option<String>) -> GuestSnapshot {
    let thread = full.thread.id;
    GuestSnapshot {
        seq: full.seq,
        thread: GuestThread {
            id: thread,
            title,
            status: full.thread.status,
            created_at: full.thread.created_at,
        },
        entries: entries(&full.events, thread),
        more: full.more,
    }
}

fn entries(events: &[LoggedEvent], thread: RunId) -> Vec<GuestEntry> {
    events
        .iter()
        .filter_map(|logged| guest::guest_entry(&logged.event, logged.seq, logged.time, thread))
        .collect()
}

/// Thread `thread`'s title, if it has one.
async fn title(context: &Context, thread: RunId) -> Result<Option<String>, ErrorObject> {
    let row = context
        .daemon
        .reader
        .run(&context.cancel, move |db| {
            db.get_thread(thread.into()).map_err(|e| store_error(&e))
        })
        .await?;
    Ok(match row {
        Some(row) => crate::threads::thread_entry(&row)?.title,
        None => None,
    })
}

/// `guest/create`.
pub(super) async fn create(
    context: &Context,
    params: GuestCreateParams,
) -> Result<GuestCreateResult, ErrorObject> {
    let GuestCreateParams {
        thread_id,
        can_suggest,
    } = params;
    guest::create(&context.daemon, thread_id, can_suggest).await
}

/// `guest/list`.
pub(super) fn list(context: &Context, _: GuestListParams) -> GuestListResult {
    GuestListResult {
        links: context.daemon.guests.list(),
    }
}

/// `guest/revoke`: Stop sharing. Ending a link that already ended changes nothing.
pub(super) fn revoke(context: &Context, params: &GuestRevokeParams) -> GuestListResult {
    guest::end(&context.daemon, &params.link, "its owner stopped sharing");
    list(context, GuestListParams {})
}

/// `guest/suggest`: only from a guest, whose link [`admits`] checked.
pub(super) fn suggest(
    context: &Context,
    params: GuestSuggestParams,
) -> Result<GuestSuggestResult, ErrorObject> {
    let Some(link) = &context.guest else {
        return Err(refusal("Only a guest suggests a message."));
    };
    check_message("text", &params.text, &[])?;
    let suggestion = link.suggest(params.text)?;
    Ok(GuestSuggestResult { suggestion })
}

/// `guest/send`: sends a guest's waiting message to its thread as the owner's own, then drops it.
pub(super) async fn send(
    context: &Context,
    params: GuestSuggestionParams,
) -> Result<GuestListResult, ErrorObject> {
    let GuestSuggestionParams { link, suggestion } = params;
    let link = context
        .daemon
        .guests
        .get(&link)
        .ok_or_else(|| refusal("This guest link has ended."))?;
    let waiting = link
        .suggestion(suggestion)
        .ok_or_else(|| refusal("No such message is waiting."))?;
    let message = plain_message(link.thread, waiting.id, waiting.text, None);
    super::agent::send(context, message).await?;
    link.drop_suggestion(suggestion);
    Ok(list(context, GuestListParams {}))
}

/// `guest/dismiss`.
pub(super) fn dismiss(
    context: &Context,
    params: GuestSuggestionParams,
) -> Result<GuestListResult, ErrorObject> {
    let GuestSuggestionParams { link, suggestion } = params;
    let link = context
        .daemon
        .guests
        .get(&link)
        .ok_or_else(|| refusal("This guest link has ended."))?;
    if !link.drop_suggestion(suggestion) {
        return Err(refusal("No such message is waiting."));
    }
    Ok(list(context, GuestListParams {}))
}

#[cfg(test)]
mod tests {
    use parallax_protocol::RunId;

    use super::snapshot;
    use crate::server::remote::guest::fixtures::{self, SHOWN, private_in};

    #[test]
    fn a_guests_snapshot_has_its_threads_transcript_and_no_private_field() {
        let (thread, other) = (RunId::generate(), RunId::generate());
        let full = fixtures::snapshot(thread, other);
        let sent = serde_json::to_string(&snapshot(&full, Some("The title".to_owned()))).unwrap();
        assert_eq!(private_in(&sent, other), Vec::<String>::new(), "{sent}");
        for text in SHOWN.iter().chain(&["The title"]) {
            assert!(sent.contains(text), "{text} in {sent}");
        }
        // The full snapshot had every one of them.
        let full = serde_json::to_string(&full).unwrap();
        assert!(full.contains("/Users/s3cr3t-user") && full.contains("queued s3cr3t run"));
    }
}
