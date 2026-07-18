# Agent operations: clanker-board API

How a Claude Code session drives tickets through the lifecycle using the
clanker-board API (dev: `http://localhost:4711`, prod: `:4712`). This is the
API-backed twin of `tracker.md` (which drives GitHub Issues via `gh`).

## Model

| Concept     | Here                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| Identity    | An `actor` (`kind: agent`), one per Claude session, self-registered        |
| Claim       | `assigneeId` + `claimedAt` - a **lease**, not ownership                    |
| Unclaimed   | Open + unassigned (or an expired agent lease, see TTL)                     |
| Frontier    | Derived `ready`: open + every blocker closed                               |
| Ticket type | Freeform `type` field (`research`, `grilling`, `task`, `spec`, ...)        |
| Sub-issue   | `parentId` (set via `PUT .../issues/{n}/parent`)                           |
| Blocking    | `PUT .../issues/{n}/blocked-by/{blocker}`                                  |
| Done        | `state: closed`                                                            |
| Human       | The seeded `kind: human` actor - assign to it to hand a ticket to a person |

## Session bootstrap (once, at start)

The actor name embeds the Claude Code session id, so any claim/comment traces
back to a local transcript (`$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`) and
the session can be reopened with `claude --resume <id>`:

```bash
ACTOR_ID=$(curl -s -X POST localhost:4711/api/actors \
  -H 'content-type: application/json' \
  -d "{\"name\":\"claude:$CLAUDE_CODE_SESSION_ID\",\"kind\":\"agent\"}" | jq .id)
```

Remember `ACTOR_ID` for the whole session.

## Claim the next ready ticket (atomic - no list-then-claim race)

```bash
# First ready issue (open, unheld, all blockers closed), in rank order.
# Filters are optional and AND-ed: label, type, parentNumber.
curl -s -X POST localhost:4711/api/projects/<slug>/issues/claim-next \
  -H 'content-type: application/json' \
  -d "{\"actorId\":$ACTOR_ID,\"label\":\"ready-for-agent\"}"
# 200 -> the claimed issue; 404 -> nothing ready (wait/poll or stop)
```

Claim a specific ticket (409 if someone else holds a live lease):

```bash
curl -s -X POST localhost:4711/api/projects/<slug>/issues/<n>/claim \
  -H 'content-type: application/json' -d "{\"actorId\":$ACTOR_ID}"
```

Claim **before any work**. Re-claiming your own ticket renews the lease
(heartbeat) - do this before starting another long stretch of work.

## Leases and the TTL

An agent-held claim older than `CLAIM_TTL_MINUTES` (default 45) counts as
abandoned: claim endpoints will steal it for another agent. Human-held claims
are never stolen. If you stole a ticket, read its comments and branch first -
salvage, don't restart blindly.

## Finish or park (never exit holding a claim)

Done:

```bash
curl -s -X PATCH localhost:4711/api/projects/<slug>/issues/<n> \
  -H 'content-type: application/json' -d '{"state":"closed"}'
```

Parking (stopping without closing) - post a progress comment, then release:

```bash
# 1. progress note: what's done, what's left, branch name, decisions
curl -s -X POST localhost:4711/api/projects/<slug>/issues/<n>/comments \
  -H 'content-type: application/json' \
  -d "{\"actorId\":$ACTOR_ID,\"body\":\"<progress note>\"}"
# 2a. back to the frontier:
curl -s -X PATCH localhost:4711/api/projects/<slug>/issues/<n> \
  -H 'content-type: application/json' -d '{"assigneeId":null}'
# 2b. or hand to the human (e.g. grilling awaiting answers):
HUMAN_ID=$(curl -s localhost:4711/api/actors | jq '[.[]|select(.kind=="human")][0].id')
curl -s -X PATCH localhost:4711/api/projects/<slug>/issues/<n> \
  -H 'content-type: application/json' -d "{\"assigneeId\":$HUMAN_ID}"
```

Everything a future claimer needs must live in comments + a pushed branch,
never only in this session's memory.

## Release-on-exit safety net (SessionEnd hook)

The protocol above can be forgotten; a hook makes release deterministic. List
this session's open claims via the server-side filter and null them:

```bash
# ~/.claude/hooks: SessionEnd
for n in $(curl -s "localhost:4711/api/projects/<slug>/issues?assigneeId=$ACTOR_ID&state=open" | jq '.[].number'); do
  curl -s -X PATCH "localhost:4711/api/projects/<slug>/issues/$n" \
    -H 'content-type: application/json' -d '{"assigneeId":null}' > /dev/null
done
```

The TTL steal is the final backstop when even the hook can't run (crash).

## Other useful queries

```bash
# The frontier, without claiming:
curl -s "localhost:4711/api/projects/<slug>/issues?ready=true&assigneeId=unassigned&state=open"
# Children of a spec:  claim-next with parentNumber, or filter client-side on parentId.
# Full API surface: interactive docs at /docs.
```

## Rules

- One session = one actor = at most one claimed ticket at a time.
- Only `research`-type tickets may be resolved more than one per session
  (mirrors `tracker.md`).
- Never close or modify a parent (map/spec) issue from a build-ticket session.
- Expect other sessions to be working the same project concurrently; the claim
  endpoints are the only safe way to take a ticket.
