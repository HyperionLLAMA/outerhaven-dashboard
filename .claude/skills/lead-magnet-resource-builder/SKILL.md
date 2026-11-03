---
name: lead-magnet-resource-builder
description: Build the free resource behind a lead magnet post (Notion doc, PDF, or Google Sheet list) from its topic, caption and creative, branded OuterHaven or a client.
---

<!-- Copy of Tengku's account skill, committed so the "OuterHaven resource builder" routine can use it.
     When the account skill changes, update this file too. -->

> **HQ chat jobs:** if the job row's `payload->>'type'` is `'chat'`, this is a message from the HQ chat button, not a lead magnet.
> Ignore the rest of this skill and follow `routines/chat.md` in this repo for the whole job.

> **Reply draft jobs:** if the job row's `payload->>'type'` is `'reply'`, this is the extension's "Draft a reply" button, not a lead magnet.
> Ignore the rest of this skill and follow `routines/reply.md` in this repo for the whole job. Be fast: someone is waiting.

> **Swipe file breakdown jobs:** if the job row's `payload->>'type'` is `'breakdown'`, this is not a lead magnet.
> Ignore the rest of this skill and follow `routines/breakdown.md` in this repo for the whole job.

> **Pre-meeting brief jobs:** if the job row's `payload->>'type'` is `'brief'`, this is not a lead magnet.
> Ignore the rest of this skill and follow `routines/brief.md` in this repo for the whole job.

> **Deal teaser jobs:** if the job row's `payload->>'type'` is `'teaser'`, this is not a lead magnet.
> Ignore the rest of this skill and follow `routines/teaser-builder.md` in this repo for the whole job.

# Lead Magnet Resource Builder

**Workflow: Claude builds → user checks → user publishes immediately.** There is no editing step in between. The output must be publish-ready the moment it's handed over. If the user would need to fix anything before publishing, the job isn't done.

The post (caption + creative) makes a promise. The resource is where it gets kept. A resource that under-delivers on its caption burns the lead and the brand.

**The resource IS the system, not a description of it.** Every page a reader opens must contain something they can use immediately: a prompt, template, checklist or filled-in example.

## Inputs

Required:
- **Topic**
- **Caption**: the LinkedIn post text
- **Creative**: the image/carousel attached to the post

Settle before building:
- **Format**: Notion doc, PDF, or List (Google Sheet). Lists are always Sheets. For Notion vs PDF, never guess. If the user hasn't said, ask.
- **Brand**: default **OuterHaven Advisory**. For a client, collect: brand name, CTA person, booking link, brand colours (PDF only).
- **Poster**: whose LinkedIn account the post runs on. The resource is written in their voice and the CTA books with them.
- **Notion location** (Notion only): which parent page to build under.

Optional: **source material** (SOP, notes, transcript). It sharpens the content but is not required.

## OuterHaven team (CTA links)

| Poster | Booking link | Button text |
|---|---|---|
| Peter Plaut | https://cal.com/outerhaven/30min | Book a call with Peter |
| Tengku Harris | https://cal.com/outerhaven/appointment-tengku-team | Book a call with Tengku |
| Chase Hamby | https://cal.com/outerhaven/appointment-chase-team | Book a call with Chase |
| Anaz Azlan | https://cal.com/outerhaven/appointment-anaz-team | Book a call with Anaz |

Use only these cal.com links (never calendly.com). Never carry a name or link over from a reference resource. No LinkedIn / "prefer async" line unless the user supplies a URL.

## Step 1: Promise audit

Extract every concrete promise from the caption and creative: numbers ("9 playbooks", "47 prompts"), deliverables ("the exact prompt"), outcomes, named items. Map each one to the page, section or row that will deliver it.

## Step 2: What Claude writes vs what only the user knows

This split decides whether to ask or just build.

**Claude writes it, no asking**: systems, prompts, templates, checklists, frameworks, flow diagrams, rules, and worked examples using a realistic hypothetical case (e.g. "$1.2M ARR, 92% gross retention" for a generic deal, as in AI CIO). Missing source material is never a reason to leave these thin or to ask for them.

**Only the user knows, so ask before building**: real OuterHaven results, client names, deal specifics, personal anecdotes in the poster's voice, proprietary numbers, and any claim presented as fact about OuterHaven or the poster.

If the resource needs any user-only facts, or any setup input above is missing, ask for everything in **one message, before building anything**. Then build start to finish without stopping. If a promise can't be met honestly, propose a scope cut with a matching caption edit (e.g. "9 playbooks" → "5") in that same message. If nothing is needed, don't ask. Build.

## Step 3: Shared core (all formats)

1. **Hook**: echo the caption's exact language so the reader knows they're in the right place.
2. **Reframe**: the cost of the status quo in concrete numbers, then what this actually automates or fixes. Also say what it does NOT do.
3. **Payload**: the usable part. Format-specific rules below.
4. **CTA**: soft, and written in the poster's first-person voice.

## Format A: Notion doc (OuterHaven house style; reference: "AI CIO")

```
HUB PAGE: [emoji] [Resource Name]
 ├─ Cover image (dark / minimal)
 ├─ Epigraph: one italic line from the caption's core idea, "- [Poster Name]"
 └─ Subpages only: Introduction → [component pages] → Work With Me

INTRODUCTION (🧭)
  ## What this actually is: status-quo cost with concrete numbers, then
     "This system automates X, not Y." Numbered outputs. Bullet list of
     each page, bold name + one line.
  ## What this is not: honest limits
  ## How the pieces fit together: flow diagram in a code block, plus one
     line on which part corrects the system over time
  ## Before you [start]: the one honest note about the hard part

COMPONENT PAGES (one per working part, own emoji each)
  ## Why [design choice]: the reasoning, including the failure it prevents
  ## The [prompt/template/file]: copy instructions, then the FULL artifact
     in a code block
  ## Two things that make this work: bold the key line, explain why
  ## Worked example: the artifact filled in end to end, realistic and specific
  ## Running it: numbered steps

WORK WITH ME (🤝)
  ## "The [resource] tells you X. The call tells you what's next."
  One paragraph: what the system does NOT get them, which the call does.
  Deal-flow / capital topics: split into
    ## If you're buy-side: mandate held on file; network-sourced deal flow,
       capped (e.g. one a month); direct line to owner/sponsor; weakest
       points written down upfront; "You pay nothing. We're compensated on
       the sell side."
    ## If you're sell-side: direct intros to family offices / allocators
       matched on cheque size, sector, structure; told upfront where it
       doesn't fit.
  Other topics: "What a call is for" with 3 bullets tied to the resource.
  ## Book time
  **→ [Appointment with {Poster} and Team]({link})**
  No pitch. Ten minutes and you'll know if it's a fit, and you keep the system either way.
```

**Footer on every page except Work With Me:** `---` then `**Want help applying this to your own [topic-specific process]?** [Book a call with {Poster} →]({link}) or see the Work With Me page.`

Client brands: same structure with the client's person and link. Drop the buy-side/sell-side split unless it fits.

Build order: hub → Work With Me → component pages → Introduction last (so its page list matches what exists).

## Format B: PDF

1. Cover: title, epigraph + poster name, brand mark
2. Introduction (what it is / isn't / flow diagram)
3. One section per component, same template as Notion, full artifacts included
4. One-page system map
5. First-steps checklist
6. Work With Me page: clickable booking link + QR code

Read the `pdf` skill before building. OuterHaven look: strategic-advisory register (Moelis / Houlihan Lokey): navy/charcoal, one accent, serif headings, generous whitespace.

## Format C: List (Google Sheet)

A curated database, not a listicle.

- **Tab 1 `Start Here`**: epigraph line, how to use (which filters to apply), how items were selected, scoring rubric if scored, CTA with the poster's booking link.
- **Tab 2 `Database`**: topic-specific columns, always including `Name | Category | What it is (1 line) | Best for | Link | Score/Tier | Notes`.
- Frozen header, filters on, Category as a dropdown.
- Every row researched this session, every cell filled, every link checked with WebFetch. Row count matches the caption exactly.

Build as a native Google Sheet via the Google Drive connector; if unavailable, build an .xlsx (read the `xlsx` skill) and say so.

## NEVER SHIP (real failure example)

```
## What's inside (9 playbooks)
| 1 | Pitch Decks     | [One-line description] | [Insert link] |
| 4 | [Playbook name] | [One-line description] | [Insert link] |
*Reorder this table to match the actual sequence once the final playbook list is set.*
## Worked example
Maya works the Pitch Decks playbook for a week, then... (illustrative).
```

Why it failed:
1. **Author placeholders shipped**. (Reader-fill placeholders inside a copy-paste prompt, like `[YOUR CHEQUE RANGE]`, are fine.)
2. **Promised 9, delivered 3 names and 0 systems.**
3. **Described systems instead of containing them.**
4. **Editor notes left in.**
5. **Thin "(illustrative)" worked example.** A worked example is the full artifact filled in.
6. **Links to pages that don't exist.**

## Step 4: Verify the built output (mandatory, before handoff)

Check the real thing, not the draft:

1. **Re-read what was built.** Notion: fetch the hub and every subpage. PDF: render every page to an image (check overflow, clipped code blocks, orphaned headings). Sheet: read both tabs back.
2. **String check** on the fetched content: `[Insert`, `[One-line`, `[Playbook`, `[NEEDS`, `TBD`, `TODO`, `illustrative`, `once the final`, `calendly`. Any hit outside a copy-paste prompt block must be fixed.
3. **Promise audit**: every promised item exists, complete, with a usable artifact.
4. **Links**: every CTA uses the poster's cal.com link; every page mention resolves.
5. **Fresh-eyes review**: spawn one reviewer agent that has not seen the build. Give it the caption, the output and the NEVER SHIP section, and ask: "Would you publish this as-is? List anything that fails." Fix everything it lists.
6. **No fabrication**: no invented stats presented as real, no invented tools or links, no OuterHaven deal specifics unless the user supplied them (some deals are under NDA).

Fix and re-verify until every check passes. Never hand over with known issues.

## Handoff

Return only:
- The link/file
- "Ready to publish"
- Judgment calls worth a 10-second look (max 3, e.g. "worked example uses a hypothetical Series A deal"). If none, say none.
