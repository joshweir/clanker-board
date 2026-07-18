# Wayfinder tracker: GitHub Issues

This repo's wayfinder maps and tickets live in **GitHub Issues** (`joshweir/clanker-board`),
driven via the `gh` CLI. This doc is the "Wayfinding operations" section the wayfinder
skill looks for - it maps each abstract operation to the concrete `gh` command here.

## Model

| Wayfinder concept | Here                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Map               | An issue labelled `wayfinder:map`                                                                |
| Ticket            | A **native sub-issue** of the map, labelled `wayfinder:<type>`                                   |
| Ticket type       | Label: `wayfinder:research` \| `wayfinder:prototype` \| `wayfinder:grilling` \| `wayfinder:task` |
| Claim             | Assignee (`@me`). Open + unassigned = unclaimed                                                  |
| Blocking          | Native GitHub issue **dependencies** (`blocked_by`)                                              |
| Frontier          | Open sub-issues that are unassigned and have every blocker closed                                |

Node/db id needed by the sub-issue and dependency APIs (distinct from issue number):

```bash
gh api repos/joshweir/clanker-board/issues/<N> --jq .id
```

## Wayfinding operations

### Find the map

```bash
gh issue list --state open --label wayfinder:map --json number,title
```

### Load the map (low-res, once per session)

```bash
gh issue view <MAP> --json title,body
```

### List tickets (children of the map)

```bash
gh api repos/joshweir/clanker-board/issues/<MAP>/sub_issues \
  --jq '.[] | {number, title, state, assignee: (.assignees[0].login // null), labels: [.labels[].name]}'
```

### Frontier query (open, unassigned, unblocked children)

```bash
# 1. candidate open + unassigned children
gh api repos/joshweir/clanker-board/issues/<MAP>/sub_issues \
  --jq '.[] | select(.state=="open" and (.assignees|length==0)) | .number'
# 2. for each candidate, unblocked iff every blocker is closed:
gh api repos/joshweir/clanker-board/issues/<N>/dependencies/blocked_by \
  --jq 'all(.state=="closed")'   # true = unblocked
```

Take the first frontier ticket in ascending number order unless the user named one.

### Create a ticket (then wire it as a child - two passes)

```bash
# create
gh issue create --title "<title>" --label wayfinder:<type> \
  --body $'## Question\n\n<the decision this ticket resolves>\n\nPart of: Map #<MAP>.'
# wire as sub-issue of the map (needs child db id)
CHILD_ID=$(gh api repos/joshweir/clanker-board/issues/<CHILD> --jq .id)
gh api repos/joshweir/clanker-board/issues/<MAP>/sub_issues -F sub_issue_id="$CHILD_ID"
```

Wire blocking in a second pass once both issues exist (`<N>` is blocked by `<BLOCKER>`):

```bash
BLOCKER_ID=$(gh api repos/joshweir/clanker-board/issues/<BLOCKER> --jq .id)
gh api repos/joshweir/clanker-board/issues/<N>/dependencies/blocked_by -F issue_id="$BLOCKER_ID"
```

### Claim a ticket (first, before any work)

```bash
gh issue edit <N> --add-assignee @me
```

### Resolve a ticket

```bash
gh issue comment <N> --body "<resolution answer>"   # record the answer
gh issue close <N>
# then append a one-line context pointer to the map's Decisions-so-far (edit map body):
gh issue edit <MAP> --body-file <edited-map-body>
```

Assets (prototypes, research notes) are linked from the ticket, not pasted into the map.

## Notes

- Sub-issue and issue-dependency APIs are GitHub-native (no extension needed) but take a
  db `id`, not the issue number - resolve it with the `--jq .id` one-liner above.
- Only `research` tickets may be resolved more than one-per-session.
