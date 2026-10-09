# Models and providers

Capability guidance for choosing acom agents, checked 2026-10-09. These are broad reasoning/coding comparisons, not an intelligence score or a guarantee of account access. `>` means generally stronger; `≳` means a less certain advantage. Effort, tools, task and harness can change the result. Compare on representative tasks before relying on a ranking.

## Providers and sessions

| Provider | acom harness | Model ID families |
|---|---|---|
| Anthropic | `claude` (Claude Code) | `claude-opus-*`, `claude-fable-*`, `claude-mythos-*`, `claude-sonnet-*`, `claude-haiku-*` |
| OpenAI | `codex` | `gpt-*-astra`, `gpt-*-sol`, `gpt-*-terra`, `gpt-*-luna` |

A harness is the installed client, not a model. Its version, login and account determine which models actually work. acom's catalog and allowed lists do not grant access. Custom IDs are supported; consult current provider documentation for models outside this snapshot. Haiku 4.5 has fixed effort: its `medium` catalog entry is a placeholder, not adjustable reasoning.

Changing model within the same provider keeps the native session when the harness supports it. Another provider cannot resume that session. Launch it with a task summary and the predecessor's `conversation_history` and `output_log` paths from `acom agent <ID>`; these are reference files, not imported context. Check the files and current project state before continuing. `acom models --catalog` prints current IDs and supported effort choices; `acom limits` prints permitted models/efforts and self-change permissions.

## OpenAI ordering

- Current family: `gpt-6-astra > gpt-6.1-sol ≳ gpt-6-sol > gpt-6-luna`.
- Previous family: `gpt-5.6-sol > gpt-5.6-terra > gpt-5.6-luna`.

Astra targets the hardest reasoning and coding; 6.1 Sol balances near-Astra capability with cost; Luna targets focused, high-volume work. The 6.1-over-6 Sol comparison is a successor-based inference, not a universal measured win. [Current family guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [previous family roles](https://developers.openai.com/api/docs/models).

Unresolved cross-generation comparisons include 6 Sol versus 5.6 Sol, and 6 Luna versus 5.6 Terra or 5.6 Sol. Do not merge the two chains into a strict total order or infer intelligence from price alone.

## Claude ordering

Approximate working bands, not an official total order. Models sharing a band are not necessarily tied, and neighboring bands can overlap by task.

| Band | Models |
|---|---|
| Current frontier | `claude-opus-5-5`, `claude-fable-5-1`, `claude-mythos-5-1` |
| Strong newer models | `claude-sonnet-5-5`, `claude-opus-5`, `claude-fable-5` |
| Older high-capability models | `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7` |
| Older balanced model | `claude-sonnet-4-6` |
| Older lightweight model | `claude-haiku-4-5` |

Better-supported relationships:

- Opus: `5.5 > 5 > 4.8 ≳ 4.7`.
- Sonnet: `5.5 > 5 > 4.6`.
- Fable: `5.1 > 5`.
- Haiku: `5.5 > 4.5`; the new `claude-haiku-5-5` is intended for focused work. Its position against older Sonnets and Opuses is task-dependent, so it is not assigned a fixed band here.

[Capability guidance](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence), [Opus 5](https://www.anthropic.com/news/claude-opus-5), [Opus 4.8](https://www.anthropic.com/news/claude-opus-4-8), [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5), [Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5), [Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5).

Fable 5.1 and Mythos 5.1 are the same underlying model with different safeguards and access conditions; effective behavior can differ. Fable 5 and Opus 5 trade places by task. Sonnet 5 approaches Opus 4.8, but Opus is generally more capable; Sonnet 5 versus Opus 4.7 is not settled. [Fable and Mythos](https://www.anthropic.com/claude-fable-and-mythos-5-1), [Sonnet 5 comparison](https://www.anthropic.com/news/claude-sonnet-5).

There is no unconditional `Fable > Opus > Sonnet` ladder: Opus 5.5 beats Fable 5.1 on several published coding evaluations, while Sonnet 5.5 beats Opus 5.5 on Terminal-Bench 4.0 but loses on others. Benchmark settings and harnesses also differ. [Opus results](https://www.anthropic.com/claude-opus-5-5), [Sonnet results](https://www.anthropic.com/claude-sonnet-5-5).

## Choosing agents

Use a strong model for ambiguous planning, difficult debugging and review; a lighter one for narrow edits, extraction and routine checks. More effort may help difficult tasks, but the same effort label does not imply equal compute across models/providers. Different providers can offer useful independent review, but disagreement is not evidence that one is correct: verify against code, tests and sources.
