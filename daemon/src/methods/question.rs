//! A Project's children's questions (PLX-402, decision 0043): `question/ask`, `question/answer`,
//! `question/escalate`, and `question/list`, behind the `questions` capability.
//!
//! A child's `ask` records its question and returns at once; the child goes on with its
//! assumption. The question wakes the Project's current coordinator through 0025's wake-ups, so
//! it batches with them and counts toward their cap, or, with no coordinator or in Ask me
//! (PLX-403), goes straight to Needs you, as do those still open when the Project switches to Ask
//! me (PLX-474). Only the coordinator answers or escalates with `from`, and only the user answers
//! without it: a thread's MCP server passes its own run, never the model. In Ask me plxd refuses
//! the coordinator's answer. An answer reaches the child as a queued message only when it differs
//! from what the child was last told.

use std::sync::Arc;

use jiff::Timestamp;
use parallax_protocol::jsonrpc::{ErrorObject, Request};
use parallax_protocol::methods::{
    QuestionAnswer, QuestionAsk, QuestionEscalate, QuestionList, RequestMethod,
};
use parallax_protocol::{
    AgentSendParams, ErrorKind, InboxKind, ProjectAutonomy, ProjectId, Question,
    QuestionAnswerParams, QuestionAskParams, QuestionEscalateParams, QuestionId,
    QuestionListParams, QuestionListResult, QuestionResult, QuestionStatus, RunId, TurnId,
};
use parallax_store::Store;
use serde_json::Value;
use tracing::info;
use uuid::Uuid;

use super::{Context, handle, inbox};
use crate::agents::convert::NO_WRITE;
use crate::agents::coordinator::coordinator_of;
use crate::agents::{self, run_not_found, wake};
use crate::store::Tx;
use crate::store::{project_autonomy, store_error};

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
        QuestionAsk::NAME => {
            handle::<QuestionAsk, _, _>(context, request, |p| ask(context, p)).await
        }
        QuestionAnswer::NAME => {
            handle::<QuestionAnswer, _, _>(context, request, |p| answer(context, p)).await
        }
        QuestionEscalate::NAME => {
            handle::<QuestionEscalate, _, _>(context, request, |p| escalate(context, p)).await
        }
        QuestionList::NAME => {
            handle::<QuestionList, _, _>(context, request, |p| list(context, p)).await
        }
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
    let command_id = context.command_id;
    let (row, prompt, coordinator, autonomy) = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let asker = db
                .get_run(run.into())
                .map_err(|e| store_error(&e))?
                .ok_or_else(|| run_not_found(run))?;
            let project = asker.fields.project_id;
            let Some(project_row) = db.get_project(project).map_err(|e| store_error(&e))? else {
                return Err(ErrorObject::invalid_params(format!(
                    "run {run} isn't in a Project, so it has no coordinator to ask"
                )));
            };
            let autonomy = project_autonomy(&project_row.autonomy);
            if asker.fields.policy == NO_WRITE {
                return Err(ErrorObject::invalid_params(
                    "a Project's coordinator answers questions; it doesn't ask them",
                ));
            }
            // In Ask me nothing wakes the coordinator: the question is the user's from the start.
            let coordinator = coordinator_of(db, project)?.filter(|_| answers(autonomy));
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
                delivered_to: None,
            };
            db.add_question(&row).map_err(|e| store_error(&e))?;
            crate::commands::complete(
                db,
                command_id,
                &QuestionResult {
                    question: to_wire(row.clone())?,
                },
            )?;
            Ok((row, asker.fields.prompt, coordinator, autonomy))
        })
        .await?;
    let asked = to_wire(row.clone())?;
    info!(question = %asked.id, %run, "a child asked a question");
    match coordinator {
        Some(coordinator) => wake::notify_questions(
            &context.daemon,
            coordinator.into(),
            wake::question(
                run,
                &prompt,
                asked.id,
                &asked.question,
                &asked.assumption,
                autonomy,
            ),
            vec![row.id],
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
    let command_id = context.command_id;
    let (before, prompt, status) = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let (row, prompt) = find(db, question)?;
            let status = match from {
                Some(from) => {
                    open_for(db, &row, from, "answer")?;
                    if !answers(autonomy_of(db, row.project_id)?) {
                        return Err(ErrorObject::invalid_params(
                            "the Project's autonomy is Ask me, so only the user answers its \
                             children's questions; pass this one to them with escalate",
                        ));
                    }
                    DECIDED
                }
                None => ANSWERED,
            };
            db.set_question(row.id, status, Some(&answered))
                .map_err(|e| store_error(&e))?;
            if from.is_none() && same(row.answer.as_deref().unwrap_or(&row.assumption), &answered) {
                crate::commands::complete(
                    db,
                    command_id,
                    &QuestionResult {
                        question: to_wire(parallax_store::Question {
                            status: status.to_owned(),
                            answer: Some(answered),
                            ..row.clone()
                        })?,
                    },
                )?;
            }
            Ok((row, prompt, status))
        })
        .await?;
    let child = RunId::try_from(before.run_id)
        .map_err(|_| ErrorObject::internal_error("a stored question has an invalid run id"))?;
    let project = ProjectId::try_from(before.project_id)
        .map_err(|_| ErrorObject::internal_error("a stored question has an invalid project id"))?;
    if from.is_some() {
        let line = format!(
            "{}: asked {}, went with {}",
            wake::task(&prompt),
            wake::quoted(&before.question),
            wake::quoted(&text)
        );
        inbox::add(&context.daemon, project, child, InboxKind::Decided, line).await;
    }
    let told = before.answer.as_deref().unwrap_or(&before.assumption);
    if !same(told, &text)
        && let Err(error) = tell(context, &before, &text, from).await
    {
        // The answer row already committed. Keep the failure so retry cannot deliver twice.
        let command_id = context.command_id;
        let stored_error = error.clone();
        context
            .daemon
            .store
            .run(&context.cancel, move |db| {
                crate::commands::complete(db, command_id, &stored_error)
            })
            .await?;
        return Err(error);
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
    let command_id = context.command_id;
    let (row, prompt) = context
        .daemon
        .store
        .run(&context.cancel, move |db| {
            let (row, prompt) = find(db, question)?;
            open_for(db, &row, from, "escalate")?;
            db.set_question(row.id, ESCALATED, None)
                .map_err(|e| store_error(&e))?;
            let result = QuestionResult {
                question: to_wire(parallax_store::Question {
                    status: ESCALATED.to_owned(),
                    ..row.clone()
                })?,
            };
            crate::commands::complete(db, command_id, &result)?;
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
            "Answer to your question {}: {text}\n\nYou went on assuming: {}\nChange what you did \
             on that assumption to follow this answer.",
            wake::quoted(&row.question),
            wake::quoted(&row.assumption)
        ),
        Some(old) => format!(
            "The user changed the answer to your question {}: {text}\n\nIt was: {old}\nChange \
             what you did on the old answer to follow this one.",
            wake::quoted(&row.question)
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
    inbox::add(daemon, project, run, InboxKind::NeedsYou, asks(row, prompt)).await;
}

/// A Needs you item's line for `row`, asked by a child whose task is `prompt`.
fn asks(row: &parallax_store::Question, prompt: &str) -> String {
    format!(
        "{}: asks {}, went on assuming {}",
        wake::task(prompt),
        wake::quoted(&row.question),
        wake::quoted(&row.assumption)
    )
}

/// Escalates `project`'s open questions to Needs you, in the caller's store job, for a Project
/// that just switched to Ask me, whose coordinator no longer answers them (PLX-474).
pub(crate) fn escalate_open(db: &mut Tx, project: ProjectId) -> Result<(), ErrorObject> {
    let questions = db.questions(project.into()).map_err(|e| store_error(&e))?;
    for row in questions.iter().filter(|row| row.status == OPEN) {
        let Ok(run) = RunId::try_from(row.run_id) else {
            continue;
        };
        let prompt = db
            .get_run(row.run_id)
            .map_err(|e| store_error(&e))?
            .map(|run| run.fields.prompt)
            .unwrap_or_default();
        db.set_question(row.id, ESCALATED, None)
            .map_err(|e| store_error(&e))?;
        inbox::record(db, project, run, InboxKind::NeedsYou, asks(row, &prompt))?;
    }
    Ok(())
}

/// The question `id`, and the prompt of the child that asked it. Refuses a question whose child
/// is gone, which nothing could tell.
fn find(db: &Store, id: QuestionId) -> Result<(parallax_store::Question, String), ErrorObject> {
    let row = db
        .get_question(id.into())
        .map_err(|e| store_error(&e))?
        .ok_or_else(|| ErrorObject::invalid_params(format!("no question has id {id}")))?;
    let child = db
        .get_run(row.run_id)
        .map_err(|e| store_error(&e))?
        .ok_or_else(|| {
            ErrorObject::invalid_params(format!(
                "the run that asked question {id} was deleted, so nothing can answer it"
            ))
        })?;
    Ok((row, child.fields.prompt))
}

/// Project `project`'s autonomy level (0043), Routine, the default, for one that is gone.
pub(crate) fn autonomy_of(db: &Store, project: Uuid) -> Result<ProjectAutonomy, ErrorObject> {
    Ok(db
        .get_project(project)
        .map_err(|e| store_error(&e))?
        .map_or(ProjectAutonomy::Routine, |row| {
            project_autonomy(&row.autonomy)
        }))
}

/// Whether the coordinator answers questions at `autonomy`: not in Ask me, nor at a level this
/// plxd doesn't know.
pub(crate) fn answers(autonomy: ProjectAutonomy) -> bool {
    matches!(autonomy, ProjectAutonomy::Routine | ProjectAutonomy::Full)
}

/// What the coordinator is told about `autonomy`, in its first message and with each question.
pub(crate) fn level(autonomy: ProjectAutonomy) -> &'static str {
    match autonomy {
        ProjectAutonomy::Routine => {
            "The project's autonomy is Routine: answer only what your shared context or the code \
             clearly answers, and escalate the rest."
        }
        ProjectAutonomy::Full => {
            "The project's autonomy is Full: answer everything you can justify, and escalate only \
             what you can't."
        }
        ProjectAutonomy::Ask | ProjectAutonomy::Unknown => {
            "The project's autonomy is Ask me: Parallax refuses answer, so escalate every question."
        }
    }
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
    use parallax_protocol::ProjectAutonomy;

    use super::{answers, same};

    #[test]
    fn answers_that_differ_only_in_case_or_spacing_are_the_same() {
        assert!(same(" Per  user\n", "per user"));
        assert!(!same("per user", "per IP"));
    }

    #[test]
    fn only_routine_and_full_let_the_coordinator_answer() {
        assert!(answers(ProjectAutonomy::Routine));
        assert!(answers(ProjectAutonomy::Full));
        assert!(!answers(ProjectAutonomy::Ask));
        assert!(
            !answers(ProjectAutonomy::Unknown),
            "a level from a newer plxd"
        );
    }
}
