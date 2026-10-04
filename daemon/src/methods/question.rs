//! A Project's children's questions (PLX-402, decision 0043): `question/ask`, `question/answer`,
//! `question/escalate`, and `question/list`, behind the `questions` capability.
//!
//! A child's `ask` records its question and returns at once; the child goes on with its
//! assumption. The question wakes the Project's current coordinator through 0025's wake-ups, so
//! it batches with them and counts toward their cap, or, with no coordinator, goes straight to
//! Needs you. Only the coordinator answers or escalates with `from`, and only the user answers
//! without it: a thread's MCP server passes its own run, never the model. An answer reaches the
//! child as a queued message only when it differs from what the child was last told.
// ponytail: always wakes the coordinator; Ask me sending questions straight to Needs you is
// PLX-403's autonomy levels.

use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::methods::{
    QuestionAnswer, QuestionAsk, QuestionEscalate, QuestionList, RequestMethod,
};
use parallax_protocol::{
    AgentSendParams, ErrorKind, InboxKind, ProjectId, Question, QuestionAnswerParams,
    QuestionAskParams, QuestionEscalateParams, QuestionId, QuestionListParams, QuestionListResult,
    QuestionResult, QuestionStatus, RunId, TurnId,
};
use parallax_store::Store;
use serde_json::Value;
use tracing::info;

use super::{Context, handle, inbox};
use crate::agents::convert::NO_WRITE;
use crate::agents::coordinator::coordinator_of;
use crate::agents::{self, run_not_found, wake};
use crate::store::store_error;

/// The longest question, assumption, or answer, in bytes. A wake-up quotes them whole.
const MAX_BYTES: usize = 4 * 1024;

/// How the store keeps each [`QuestionStatus`].
pub(crate) const OPEN: &str = "open";
const ESCALATED: &str = "escalated";
const DECIDED: &str = "decided";
const ANSWERED: &str = "answered";

/// Answers a `question/*` method.
pub(crate) async fn dispatch(context: &Context, request: &Request) -> Result<Value, ErrorObject> {
    match request.method.as_str() {
        QuestionAsk::NAME => handle::<QuestionAsk, _, _>(request, |p| ask(context, p)).await,
        QuestionAnswer::NAME => {
            handle::<QuestionAnswer, _, _>(request, |p| answer(context, p)).await
        }
        QuestionEscalate::NAME => {
            handle::<QuestionEscalate, _, _>(request, |p| escalate(context, p)).await
        }
        QuestionList::NAME => handle::<QuestionList, _, _>(request, |p| list(context, p)).await,
        other => Err(ErrorObject::method_not_found(other)),
    }
}

async fn ask(context: &Context, params: QuestionAskParams) -> Result<QuestionResult, ErrorObject> {
    let QuestionAskParams {
        run,
        question,
        assumption,
    } = params;
    check("question", &question)?;
    check("assumption", &assumption)?;
    let (row, prompt, coordinator) = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let asker = db
                .get_run(run.into())
                .map_err(|e| store_error(&e))?
                .ok_or_else(|| run_not_found(run))?;
            let project = asker.fields.project_id;
            if db
                .get_project(project)
                .map_err(|e| store_error(&e))?
                .is_none()
            {
                return Err(ErrorObject::invalid_params(format!(
                    "run {run} isn't in a Project, so it has no coordinator to ask"
                )));
            }
            if asker.fields.policy == NO_WRITE {
                return Err(ErrorObject::invalid_params(
                    "a Project's coordinator answers questions; it doesn't ask them",
                ));
            }
            let coordinator = coordinator_of(db, project)?;
            let row = parallax_store::Question {
                id: QuestionId::generate().into(),
                project_id: project,
                run_id: run.into(),
                question,
                assumption,
                status: if coordinator.is_some() {
                    OPEN
                } else {
                    ESCALATED
                }
                .to_owned(),
                answer: None,
                created_at: Timestamp::now(),
            };
            db.add_question(&row).map_err(|e| store_error(&e))?;
            Ok((row, asker.fields.prompt, coordinator))
        })
        .await?;
    let asked = to_wire(row.clone())?;
    info!(question = %asked.id, %run, "a child asked a question");
    match coordinator {
        Some(coordinator) => wake::notify(
            &context.daemon,
            coordinator.into(),
            wake::question(run, &prompt, asked.id, &asked.question, &asked.assumption),
        ),
        None => needs_you(&context.daemon, &row, &prompt).await,
    }
    Ok(QuestionResult { question: asked })
}

async fn answer(
    context: &Context,
    params: QuestionAnswerParams,
) -> Result<QuestionResult, ErrorObject> {
    let QuestionAnswerParams {
        question,
        text,
        from,
    } = params;
    check("text", &text)?;
    let answered = text.clone();
    let (before, prompt, status) = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let (row, prompt) = find(db, question)?;
            let status = match from {
                Some(from) => {
                    open_for(db, &row, from, "answer")?;
                    DECIDED
                }
                None => ANSWERED,
            };
            db.set_question(row.id, status, Some(&answered))
                .map_err(|e| store_error(&e))?;
            Ok((row, prompt, status))
        })
        .await?;
    let child = RunId::try_from(before.run_id)
        .map_err(|_| ErrorObject::internal_error("a stored question has an invalid run id"))?;
    let project = ProjectId::try_from(before.project_id)
        .map_err(|_| ErrorObject::internal_error("a stored question has an invalid project id"))?;
    if from.is_some() {
        let line = format!(
            "{}: {} Went with: {}",
            wake::task(&prompt),
            wake::one_line(&before.question, MAX_BYTES),
            wake::one_line(&text, MAX_BYTES)
        );
        inbox::add(&context.daemon, project, child, InboxKind::Decided, line).await;
    }
    let told = before.answer.as_deref().unwrap_or(&before.assumption);
    if !same(told, &text) {
        tell(context, &before, &text, from).await?;
    }
    Ok(QuestionResult {
        question: to_wire(parallax_store::Question {
            status: status.to_owned(),
            answer: Some(text),
            ..before
        })?,
    })
}

async fn escalate(
    context: &Context,
    params: QuestionEscalateParams,
) -> Result<QuestionResult, ErrorObject> {
    let QuestionEscalateParams { question, from } = params;
    let (row, prompt) = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let (row, prompt) = find(db, question)?;
            open_for(db, &row, from, "escalate")?;
            db.set_question(row.id, ESCALATED, None)
                .map_err(|e| store_error(&e))?;
            Ok((row, prompt))
        })
        .await?;
    let row = parallax_store::Question {
        status: ESCALATED.to_owned(),
        ..row
    };
    needs_you(&context.daemon, &row, &prompt).await;
    Ok(QuestionResult {
        question: to_wire(row)?,
    })
}

async fn list(
    context: &Context,
    params: QuestionListParams,
) -> Result<QuestionListResult, ErrorObject> {
    context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let project = params.project;
            if db
                .get_project(project.into())
                .map_err(|e| store_error(&e))?
                .is_none()
            {
                return Err(ErrorObject::parallax(
                    ErrorKind::ProjectNotFound,
                    format!("no project has id {project}"),
                ));
            }
            let questions = db
                .questions(project.into())
                .map_err(|e| store_error(&e))?
                .into_iter()
                .map(to_wire)
                .collect::<Result<_, _>>()?;
            Ok(QuestionListResult { questions })
        })
        .await
}

/// Sends the child `row` asked the answer `text`, queued behind a running turn (PLX-370), from
/// the coordinator `from`, or from the user.
async fn tell(
    context: &Context,
    row: &parallax_store::Question,
    text: &str,
    from: Option<RunId>,
) -> Result<(), ErrorObject> {
    let message = match &row.answer {
        None => format!(
            "Answer to your question \"{}\": {text}\n\nYou went on assuming: {}\nChange what you \
             did on that assumption to follow this answer.",
            row.question, row.assumption
        ),
        Some(old) => format!(
            "The user changed the answer to your question \"{}\": {text}\n\nIt was: {old}\n\
             Change what you did on the old answer to follow this one.",
            row.question
        ),
    };
    let run_id = RunId::try_from(row.run_id)
        .map_err(|_| ErrorObject::internal_error("a stored question has an invalid run id"))?;
    let params = AgentSendParams {
        run_id,
        turn_id: TurnId::generate(),
        text: message,
        model: None,
        effort: None,
        permission: None,
        context_window: None,
        fast: None,
        account: None,
        images: Vec::new(),
        threads: Vec::new(),
        from,
        delivery: None,
    };
    let daemon = Arc::clone(&context.daemon);
    context
        .daemon
        .agents
        .detached(agents::send(daemon, params))
        .await
        .map_err(|error| {
            ErrorObject::internal_error(format!(
                "the answer is recorded, but the child didn't get it: {}",
                error.message
            ))
        })?;
    Ok(())
}

/// Adds a Needs you item for `row`, which the coordinator escalated or nobody can answer.
async fn needs_you(
    daemon: &Arc<crate::server::Daemon>,
    row: &parallax_store::Question,
    prompt: &str,
) {
    let (Ok(project), Ok(run)) = (
        ProjectId::try_from(row.project_id),
        RunId::try_from(row.run_id),
    ) else {
        return;
    };
    let line = format!(
        "{}: asks {} Went on assuming: {}",
        wake::task(prompt),
        wake::one_line(&row.question, MAX_BYTES),
        wake::one_line(&row.assumption, MAX_BYTES)
    );
    inbox::add(daemon, project, run, InboxKind::NeedsYou, line).await;
}

/// The question `id`, and the prompt of the child that asked it.
fn find(db: &Store, id: QuestionId) -> Result<(parallax_store::Question, String), ErrorObject> {
    let row = db
        .get_question(id.into())
        .map_err(|e| store_error(&e))?
        .ok_or_else(|| ErrorObject::invalid_params(format!("no question has id {id}")))?;
    let prompt = db
        .get_run(row.run_id)
        .map_err(|e| store_error(&e))?
        .map(|run| run.fields.prompt)
        .unwrap_or_default();
    Ok((row, prompt))
}

/// Refuses unless `from` is `row`'s Project's current coordinator and `row` is still open.
fn open_for(
    db: &Store,
    row: &parallax_store::Question,
    from: RunId,
    what: &str,
) -> Result<(), ErrorObject> {
    if coordinator_of(db, row.project_id)? != Some(from) {
        return Err(ErrorObject::invalid_params(format!(
            "only the Project's coordinator can {what} a child's question"
        )));
    }
    if row.status != OPEN {
        return Err(ErrorObject::invalid_params(format!(
            "question {} is {}, not open",
            row.id, row.status
        )));
    }
    Ok(())
}

fn check(name: &str, text: &str) -> Result<(), ErrorObject> {
    if text.trim().is_empty() {
        return Err(ErrorObject::invalid_params(format!(
            "{name} must not be empty"
        )));
    }
    if text.len() > MAX_BYTES {
        return Err(ErrorObject::invalid_params(format!(
            "{name} must be at most {MAX_BYTES} bytes"
        )));
    }
    Ok(())
}

/// Whether two answers say the same, ignoring case and spacing.
fn same(a: &str, b: &str) -> bool {
    let fold = |text: &str| {
        text.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    fold(a) == fold(b)
}

fn to_wire(row: parallax_store::Question) -> Result<Question, ErrorObject> {
    let invalid = |_| ErrorObject::internal_error(format!("question {} has an invalid id", row.id));
    Ok(Question {
        id: QuestionId::try_from(row.id).map_err(invalid)?,
        run: RunId::try_from(row.run_id).map_err(invalid)?,
        status: serde_json::from_value(row.status.into()).unwrap_or(QuestionStatus::Unknown),
        question: row.question,
        assumption: row.assumption,
        answer: row.answer,
        created_at: row.created_at,
    })
}

#[cfg(test)]
mod tests {
    use super::same;

    #[test]
    fn answers_that_differ_only_in_case_or_spacing_are_the_same() {
        assert!(same(" Per  user\n", "per user"));
        assert!(!same("per user", "per IP"));
    }
}
