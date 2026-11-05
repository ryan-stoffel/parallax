# 0099: An agent says which input a secret needs

- Status: accepted; extends [0098](0098-secret-files-for-commands.md)
- Date: 2026-11-04
- Issue: PLX-1326

## Context

The secret card picked its view from `delivery`, which says how the agent gets the answer, not what the user gives. Agents are told to use `delivery: "file"` for shell commands, so an API key got the multi-line `.env` editor. A `.p8` or `.p12` had no picker of its own, and the editor refuses binary files.

## Decision

- **`request_secret` takes a required `input`:** `value` is one masked field, `env` is the editor, and `file` is a file picker. The agent knows what it is asking for, so plxd and the app don't guess from the label. An API key for a shell command is `input: "value"` with `delivery: "file"`.
- **`env` and `file` always deliver a file.** Asking for `delivery: "secretRef"` with either is refused, because a keystore ref holds text and no tool takes one of these.
- **`accept` lists the extensions a `file` input offers,** each with its leading dot, such as `.p8`. It filters the OS file dialog, and the card checks a dropped file against it.
- **A picked file goes as `saveBytes`,** in base64, so a binary file reaches the private file byte for byte. The contents are read only on Save. The limit stays 64 KB, measured on the bytes.
- **The desktop card follows T3 Code's:** its label and reason, the input with Save on one line, then the privacy note and a quiet Decline. The editor and the file's drop zone need the width, so their Save joins that last line.
- **An item with no `input`,** from before this record, shows what it showed before: the editor with `delivery: "file"`, else the field.
- **On the phone, `file` opens the document picker,** and the app deletes the picker's cached copy once it has read it. `env` stays in the secure field, since iOS doesn't mask a multi-line one (0098).

## Consequences

- The file keeps plxd's generated name with no extension. A tool that needs a name such as `AuthKey_ABC.p8` needs the agent to copy it.
- A `file` input has no paste. A key kept in a password manager has to be saved to a file first.
- `secret/request` keeps `input` optional for callers from before this record. Only the `request_secret` tool requires it.
