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
    ErrorKind, GuestCreateParams, GuestCreateResult, GuestListParams, GuestListResult,
    GuestRevokeParams, GuestSuggestParams, GuestSuggestResult, GuestSuggestionParams, RunId,
    SubscribeThreadParams, ThreadHistoryParams, ThreadSnapshot,
};

use super::agent::{check_message, plain_message};
use super::{Context, read_only};
use crate::server::remote::guest::{self, Link, refusal};

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
        RequestName::OrchestrationSubscribeThread => request
            .params::<SubscribeThreadParams>()
            .ok()
            .map(|p| p.thread_id),
        RequestName::OrchestrationThreadHistory => request
            .params::<ThreadHistoryParams>()
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

/// `snapshot` as a guest of its thread sees it: the events [`guest::shown`] passes, and none of
/// the thread's permission requests, background tasks, or watched pull requests.
pub(super) fn snapshot(snapshot: &mut ThreadSnapshot) {
    let thread = snapshot.thread.id;
    snapshot
        .events
        .retain(|logged| guest::shown(&logged.event, thread));
    snapshot.requests.clear();
    snapshot.background.clear();
    snapshot.watching.clear();
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
