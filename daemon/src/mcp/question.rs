//! The question tools (PLX-402, decision 0043): a Project's child gets `ask`, and its coordinator
//! gets `answer` and `escalate`. Which ones a caller gets follows its run as plxd reports it, and
//! the server passes that run as the asker or the answerer, so no tool takes it. plxd checks the
//! same roles again in `question/*`.

use parallax_protocol::methods::{QuestionAnswer, QuestionAsk, QuestionEscalate};
use parallax_protocol::{
    QuestionAnswerParams, QuestionAskParams, QuestionEscalateParams, QuestionId, RunId,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::thread::Binding;
use super::{Plxd, parse, pretty};

/// What a Project's child gets.
pub const CHILD_TOOLS: &[&str] = &["ask"];

/// What a Project's coordinator gets.
pub const COORDINATOR_TOOLS: &[&str] = &["answer", "escalate"];

/// The tools of a caller in a Project, by whether it is the coordinator.
#[must_use]
pub fn tools(coordinator: bool) -> &'static [&'static str] {
    if coordinator {
        COORDINATOR_TOOLS
    } else {
        CHILD_TOOLS
    }
}

/// `tools/list` entries for [`tools`].
#[must_use]
pub fn definitions(coordinator: bool) -> Vec<Value> {
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false},
        })
    };
    let question = json!({"type": "string", "description": "The question's id, from the message that woke you."});
    if !coordinator {
        return vec![tool(
            "ask",
            "Ask your Project's coordinator a question without waiting. Choose the answer you think most likely, say it as the assumption, and go on working on it at once: if the coordinator or the user decides otherwise, a message tells you.",
            json!({
                "question": {"type": "string", "description": "The question, at most 4 KiB."},
                "assumption": {"type": "string", "description": "The answer you go on with until you hear otherwise, at most 4 KiB."},
            }),
            &["question", "assumption"],
        )];
    }
    vec![
        tool(
            "answer",
            "Answer a child's question for the user. If your answer differs from the child's assumption, the child gets it as a message. The user sees it in the inbox and can change it.",
            json!({
                "question": question,
                "text": {"type": "string", "description": "The answer, at most 4 KiB. Repeat the child's assumption to confirm it without messaging the child."},
            }),
            &["question", "text"],
        ),
        tool(
            "escalate",
            "Pass a child's question to the user, when it is theirs to decide. The child keeps going on its assumption until the user answers.",
            json!({"question": question}),
            &["question"],
        ),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AskArgs {
    question: String,
    assumption: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnswerArgs {
    question: QuestionId,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EscalateArgs {
    question: QuestionId,
}

/// Runs question tool `name` for the caller `binding` is bound to.
///
/// # Errors
///
/// When plxd can't be reached or refuses the call, or the arguments are invalid: a message the
/// model sees.
pub async fn call(binding: &Binding, name: &str, arguments: Value) -> Result<String, String> {
    let caller: RunId = binding.run;
    let mut plxd = Plxd::open(&binding.socket).await?;
    match name {
        "ask" => {
            let AskArgs {
                question,
                assumption,
            } = parse(arguments)?;
            let asked = plxd
                .call::<QuestionAsk>(QuestionAskParams {
                    run: caller,
                    question,
                    assumption,
                })
                .await?
                .question;
            Ok(format!(
                "Recorded question {}. Go on now with your assumption: {}\nIf the coordinator or \
                 the user decides otherwise, a message will tell you.",
                asked.id, asked.assumption
            ))
        }
        "answer" => {
            let AnswerArgs { question, text } = parse(arguments)?;
            let answered = plxd
                .call::<QuestionAnswer>(QuestionAnswerParams {
                    question,
                    text,
                    from: Some(caller),
                })
                .await?
                .question;
            Ok(pretty(&answered))
        }
        "escalate" => {
            let EscalateArgs { question } = parse(arguments)?;
            let escalated = plxd
                .call::<QuestionEscalate>(QuestionEscalateParams {
                    question,
                    from: caller,
                })
                .await?
                .question;
            Ok(pretty(&escalated))
        }
        other => Err(format!("no tool is named {other:?}")),
    }
}
