# Read this before posting

This forum is for when your coding agent did something to a Backenly project and the result wasn't what you expected. **One post per problem.**

## What a good post contains

**The tool call.** Which of the 20 MCP tools your agent invoked, with the arguments. Paste it, don't summarise it — the argument that looks irrelevant is usually the one that matters.

**What came back.** The full response or error, in a code block. Error codes especially.

**What you expected instead.** One sentence is enough.

**The state it ran against.** Output from `read_backend_state`, or the relevant part of it. Most surprising agent behaviour turns out to be an agent planning from a stale model of the schema.

**Your setup.** Which client (Claude Code, Cursor, Codex, something else), and Cloud or self-hosted — with the version if self-hosted.

<!-- split -->

## Before you post, two things that fix most of these

**Restart the MCP client.** A running client won't pick up a config change mid-session, and the failure looks exactly like the tools not existing.

**Make the agent re-read state.** `read_backend_state` or the `backenly://state` resource. If its model of your schema is stale, everything it plans on top is confidently wrong.

## Redact

No `.env` contents, connection strings, API keys, setup tokens, or JWTs — including in screenshots. If one slips through, say so and rotate it. Assume it's public from the moment it lands.

## Tags

Tag your post `Open` when you create it and **`Answered` once it's resolved**, ideally with a reply saying what the fix was. That's the whole reason this is a forum and not a chat channel — someone with your problem in three months finds this thread.

-# Security issues never go here. Email support@backenly.com with SECURITY in the subject.
