# CodeSymphony CLI Chat

This context covers how a chat thread chooses and keeps using a CLI agent, model, and optional provider configuration across turns.

## Language

**Thread selection**:
The persisted choice of agent, model, and optional model provider that governs how a chat thread runs.
_Avoid_: session settings, runtime config

**Alias-only model selection**:
A model selection that changes the model identifier while still relying on the local CLI account and auth flow.
_Avoid_: custom provider, remote endpoint

**Provider-backed model selection**:
A model selection that routes a thread through a stored provider endpoint and credentials.
_Avoid_: built-in model, alias-only model

**Provider-backed Claude selection**:
A Claude thread selection that uses a provider-backed model selection instead of local Claude Code auth.
_Avoid_: custom Claude model

**In-thread model switch**:
A same-agent model change on an existing thread that keeps the provider session and takes effect on the next turn.
_Avoid_: forked thread, silent new session

## Relationships

- A **Thread selection** chooses exactly one agent and one model
- A **Thread selection** may also choose one **Provider-backed model selection**
- A **Provider-backed Claude selection** is a Claude-flavoured **Provider-backed model selection**
- An **Alias-only model selection** and a **Provider-backed model selection** are distinct kinds of model selection
- An **In-thread model switch** preserves the existing provider session
- An **In-thread model switch** applies its new model on the next turn, not the in-flight turn

## Example dialogue

> **Dev:** "User wants to switch from one Claude model to another in the same thread. Is that a custom Claude model?"
> **Domain expert:** "Only if that thread is using a provider-backed Claude selection. If it still relies on local Claude Code auth, that's just an alias-only model selection."
>
> **Dev:** "If the user changes model in the same thread, do we restart the provider session?"
> **Domain expert:** "No. An in-thread model switch keeps the provider session and the new model starts on the next turn."

## Flagged ambiguities

- "custom Claude model" was used to mean both alias-only Claude entries and provider-backed Claude entries; resolved: the risky case is **Provider-backed Claude selection**
