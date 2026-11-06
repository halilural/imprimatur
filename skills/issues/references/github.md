# GitHub commands for the issues skill

`OWNER/REPO` is `gh repo view --json nameWithOwner -q .nameWithOwner`. The board is the user's
project named after the repo (`gh project list --owner OWNER`). Its number is `P`.

## Issues

```bash
# Create: capture the number and the numeric id (links need the id, not the number)
url=$(gh issue create -t "feat(x): title" -b "$BODY" --label enhancement --label priority:medium)
n=${url##*/}
id=$(gh api repos/OWNER/REPO/issues/$n -q .id)

gh issue edit $n --title "…" --add-label bug --remove-label enhancement --milestone "Sprint 3 · Nov 4–10 · Board"
gh issue comment $n -b "$TEXT"
gh issue close $n --reason completed     # or: --reason "not planned" (won't do)
gh issue list --state all --search "keyword in:title,body" --json number,title,state
```

## Sub-issues (an epic's children)

```bash
# sub_issue_id must be a JSON integer: send it with --input, not -f (a string is a 422)
echo "{\"sub_issue_id\": $id}" | gh api repos/OWNER/REPO/issues/$EPIC/sub_issues -X POST --input -
gh api repos/OWNER/REPO/issues/$EPIC/sub_issues -q '.[].number'     # list
gh api repos/OWNER/REPO/issues/$n/parent -q .number                  # parent
# Move a child that already has a parent: add "replace_parent": true
```

## Blocked by

```bash
# $n is blocked by issue number $b (the API takes the blocker's numeric id)
bid=$(gh api repos/OWNER/REPO/issues/$b -q .id)
echo "{\"issue_id\": $bid}" | gh api repos/OWNER/REPO/issues/$n/dependencies/blocked_by -X POST --input -
gh api repos/OWNER/REPO/issues/$n/dependencies/blocked_by -q '.[].number'
```

## The board (Status, Sprint)

```bash
gh project field-list P --owner OWNER --format json     # Status options and the Sprint field's id
item=$(gh project item-add P --owner OWNER --url "$url" --format json -q .id)
pid=$(gh project view P --owner OWNER --format json -q .id)
gh project item-edit --project-id $pid --id $item --field-id $STATUS_FIELD --single-select-option-id $TODO_OPTION
gh project item-edit --project-id $pid --id $item --field-id $SPRINT_FIELD --iteration-id $CURRENT_ITERATION
```

The current sprint comes from the Sprint field's iterations: its `startDate` plus `duration` days
contains today. The query:

```bash
gh api graphql -f query='{ user(login:"OWNER"){ projectV2(number:P){ field(name:"Sprint"){
  ... on ProjectV2IterationField { id configuration { iterations { id title startDate duration } } } } } } }'
```

No iteration covers today: leave Sprint empty and ask the user once. Never create a sprint unasked.

## Milestones

```bash
gh api repos/OWNER/REPO/milestones -q '.[]|"\(.number) \(.title) \(.due_on)"'
gh api repos/OWNER/REPO/milestones -X POST -f title="Sprint 3 · Nov 4–10 · Board" -f due_on=2026-11-10T23:59:59Z   # only when the user asks
```

## Labels

```bash
gh label list --limit 100 --json name -q '.[].name'
gh label create spike --color c5def5 --description "Time-boxed research"   # only labels the vocabulary names
```

## Screenshots for How to try it

```bash
# PNGs onto a branch of their own via the API (no local commit: the repo's hooks expect its files);
# prints one Markdown image line per file. Private repo by default; --public only for sample-data UI.
node ~/.claude/skills/issues/screenshots.mjs $n shots/1-list.png shots/2-detail.png
node ~/.claude/skills/issues/screenshots.mjs $n shots/*.png --branch docs/$n-screenshots
```
