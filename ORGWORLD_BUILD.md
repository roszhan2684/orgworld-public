<!--
PROVENANCE: Transcribed verbatim from the build specification pasted into the
Claude Code session on 2026-10-28. The paste was TRUNCATED by the chat client at
50,000 characters, mid-way through section 100 ("NON-GOALS FOR V0.1"), at the text
"huge-scale RL traini". Any sections after that point (100+ in the original) were
NOT received and are therefore NOT represented here. See
docs/research/IMPLEMENTATION_CONFLICTS.md (C-00) for the handling of this gap.
-->

# ORGWORLD

## A Persistent, Self-Evolving Multi-Agent Organization Simulator, Claude Code Plugin, RL Research Platform, and Visual Agent World

**Project name:** OrgWorld  
**Research engine:** EvoOrg  
**Primary interface:** Claude Code plugin  
**Primary visualization:** Interactive web application  
**Primary research objective:** Study whether persistent AI organizations can learn to improve across sequences of tasks by adapting roles, communication structures, authority, memory, coordination behavior, and organizational structure while controlling for inference compute.

---

# 0. INSTRUCTIONS TO CLAUDE CODE

You are building a real production-quality research system called **OrgWorld**.

This is NOT:

- a UI mockup;
- a scripted agent animation;
- a collection of fake agents;
- a dashboard that displays fabricated conversations;
- a single Claude instance pretending to be twelve agents;
- an LLM wrapper with decorative avatars;
- a toy reinforcement learning demo.

OrgWorld must be a functioning, local-first multi-agent organization runtime whose real actions are reflected by a visual world.

Before writing implementation code:

1. Read this entire file.
2. Read `EVOORG_RESEARCH.md`.
3. Inspect the entire repository.
4. Produce a dependency-ordered implementation plan.
5. Record unresolved technical decisions.
6. Resolve decisions using evidence where possible.
7. Build incrementally.
8. Add tests as each subsystem is created.
9. Never mark a capability complete without executable verification.
10. Never replace required behavior with a hard-coded demo.
11. Preserve the research controls described in this specification.
12. Prefer simple, testable architecture over premature complexity.
13. Keep EvoOrg independent from Claude-specific code.
14. Keep OrgWorld visualization independent from cognition-provider implementation.
15. Make runs replayable from recorded events.
16. Every visual agent action must correspond to an actual runtime event.

If `EVOORG_RESEARCH.md` conflicts with this implementation specification on a scientific question, **the research document wins**.

If the implementation requires changing the scientific design, do NOT silently change it.

Create:

```text
docs/research/IMPLEMENTATION_CONFLICTS.md
```

and document:

- conflict;
- implementation constraint;
- possible alternatives;
- effect on scientific validity;
- recommended resolution.

---

# 1. PRODUCT VISION

OrgWorld turns an AI multi-agent system into a persistent organization that can be observed like a miniature living world.

Users should be able to type:

```text
/orgworld Build a secure authentication system for this repository
```

and observe approximately 10–12 autonomous specialized agents:

- receiving responsibilities;
- researching;
- communicating;
- disagreeing;
- forming temporary teams;
- creating hypotheses;
- making decisions;
- implementing work;
- reviewing work;
- running experiments;
- consulting organizational memory;
- updating beliefs;
- recording evidence;
- evaluating outcomes.

The web interface should represent these agents as small humans/characters living inside an interactive environment.

They should:

- walk between rooms;
- sit at desks;
- approach one another;
- enter meeting rooms;
- visit a shared library;
- work at computers;
- display short speech indicators;
- move toward relevant workspaces;
- visually form teams;
- rearrange organizational structures over time.

The animation must visualize **real system state**.

Example:

```text
MESSAGE_SENT
```

may produce:

```text
Scout walks toward Researcher
↓
communication animation
↓
Researcher receives knowledge artifact
```

The UI must never randomly create a conversation that did not happen.

---

# 2. ORGWORLD + EVOORG RELATIONSHIP

Keep the concepts separate.

## Claude / model provider

Provides agent cognition.

## Agent

Represents an individual reasoning actor.

## EvoOrg

Controls organizational learning and evolution.

## OrgWorld Runtime

Executes the organization.

## OrgWorld Web

Visualizes and inspects execution.

The system should conceptually be:

```text
Foundation Model
      │
      ▼
Agent Cognition
      │
      ▼
OrgWorld Agent Runtime
      │
      ▼
EvoOrg Organization Layer
      │
      ▼
Event Protocol
      │
      ├───────────────┐
      ▼               ▼
Experiment Store   OrgWorld Web
```

Model providers must ultimately be replaceable.

Initial provider:

```text
Claude
```

Future providers:

```text
OpenAI
local models
other APIs
```

Do not embed EvoOrg logic directly into Claude-specific prompts.

---

# 3. CORE RESEARCH HYPOTHESIS

The implementation must support testing approximately this hypothesis:

> Persistent AI organizations can improve across sequences of tasks by accumulating organizational experience and adapting roles, communication topology, authority, memory policies, coordination behavior, and organizational structure without changing the underlying foundation model.

The system must make this hypothesis falsifiable.

OrgWorld must support experiments comparing:

### Baseline A — Single agent

```text
1 model
1 context
1 task
```

### Baseline B — Fixed multi-agent organization

```text
same agents
same roles
same communication graph
no cross-task structural adaptation
```

### Baseline C — Per-task adaptive organization

```text
organization may adapt during a task
organization resets afterward
```

### EvoOrg

```text
persistent agents
persistent organizational memory
adaptive coordination
RL policy
structural evolution
cross-task learning
```

Experimental runs should support matched constraints for:

- base model;
- task;
- available tools;
- total token budget;
- number of model calls;
- time budget where practical;
- execution environment.

---

# 4. CORE PRINCIPLE: ORGANIZATIONAL LEARNING

Do not initially fine-tune foundation-model weights.

The primary learning target is the **organization**.

Separate:

```text
Cognition learning
```

from:

```text
Organizational learning
```

EvoOrg should learn things such as:

- which agent should receive a task;
- when to delegate;
- who should communicate;
- when to request criticism;
- when to verify;
- when to gather more evidence;
- which memories to retrieve;
- whether a meeting is useful;
- which agent should lead;
- how much compute to allocate;
- whether a specialist is needed;
- which communication links are valuable;
- when work should stop.

Longer-term evolution may change:

- which roles exist;
- hierarchy;
- team boundaries;
- authority;
- veto power;
- communication structure;
- memory policies;
- decision processes;
- agent creation/removal.

---

# 5. REINFORCEMENT LEARNING DESIGN

RL must exist as a first-class architectural subsystem.

However, v0.1 must remain functional before advanced RL training is complete.

Implement progressive learning stages.

## Stage 0 — Observation

No learned policy.

Record:

- states;
- actions;
- communication;
- task outcomes;
- costs;
- decisions;
- organizational metrics.

This creates training data.

## Stage 1 — Contextual organization selection

Given task characteristics:

```text
task features
↓
select organizational configuration
↓
execute
↓
observe reward
```

Start with:

- contextual bandit;
- Bayesian selection;
- simple learned scorer;

rather than full deep RL.

## Stage 2 — Sequential RL

The policy makes organizational decisions during task execution.

Conceptual state:

```text
task_type
task_progress
agents_available
agents_busy
open_questions
open_hypotheses
confidence
conflict_level
tests_passed
tests_failed
remaining_token_budget
remaining_time
communication_graph
memory_relevance
recent_outcomes
```

Conceptual actions:

```text
ASSIGN_TASK
CREATE_SUBTASK
SEND_MESSAGE
REQUEST_REVIEW
REQUEST_CRITIQUE
REQUEST_RESEARCH
CALL_MEETING
RETRIEVE_MEMORY
CREATE_TEAM
DISSOLVE_TEAM
MODIFY_COMMUNICATION_EDGE
REALLOCATE_BUDGET
REQUEST_EXPERIMENT
ESCALATE_DECISION
TERMINATE_WORK
SPAWN_SPECIALIST
```

## Stage 3 — Structural evolution

Evolution operates at a slower timescale than RL.

RL optimizes behavior **inside an organization**.

Evolution changes the organization itself.

Example:

```text
RL:
"Send Builder output to Critic."

Evolution:
"Critic should permanently review implementation work."
```

Evolution may modify an **Organization Genome**.

---

# 6. ORGANIZATION GENOME

Define a serializable organization specification.

Suggested structure:

```json
{
  "id": "org-generation-001",
  "generation": 1,
  "roles": [],
  "agents": [],
  "teams": [],
  "communicationPolicy": {},
  "decisionPolicy": {},
  "memoryPolicy": {},
  "authorityPolicy": {},
  "budgetPolicy": {},
  "verificationPolicy": {},
  "fitness": {}
}
```

The genome should support mutation.

Potential mutation operations:

```text
ADD_ROLE
REMOVE_ROLE
SPLIT_ROLE
MERGE_ROLES

ADD_AGENT
REMOVE_AGENT

CREATE_TEAM
DISSOLVE_TEAM

ADD_COMMUNICATION_EDGE
REMOVE_COMMUNICATION_EDGE

CHANGE_AUTHORITY
CHANGE_VETO_RIGHT
CHANGE_REVIEW_REQUIREMENT

CHANGE_MEMORY_ACCESS
CHANGE_DECISION_METHOD
CHANGE_VERIFICATION_POLICY
```

Every mutation must be recorded.

Never overwrite evolutionary history.

---

# 7. DEFAULT ORGANIZATION

Start with twelve agents.

## 1. Director

Responsibilities:

- understand top-level objective;
- assign priorities;
- manage unresolved coordination;
- initiate major decisions;
- approve final organization-level outputs.

Director must NOT automatically make every decision.

Centralization should remain measurable.

---

## 2. Scout

Responsibilities:

- rapid exploration;
- dependency discovery;
- external information gathering;
- repository exploration;
- identify unknowns.

---

## 3. Researcher

Responsibilities:

- deep investigation;
- evidence gathering;
- hypothesis analysis;
- synthesis.

---

## 4. Strategist

Responsibilities:

- compare approaches;
- build plans;
- coordinate strategic options;
- identify trade-offs.

---

## 5. Architect

Responsibilities:

- system architecture;
- interfaces;
- component boundaries;
- technical design;
- architectural decision records.

---

## 6. Builder

Responsibilities:

- implementation;
- code changes;
- prototypes;
- execution.

---

## 7. Experimenter

Responsibilities:

- tests;
- experiments;
- validation;
- controlled comparisons;
- reproduction.

---

## 8. Critic

Responsibilities:

- challenge assumptions;
- identify logical weaknesses;
- red-team proposals;
- generate counterarguments.

---

## 9. Risk Agent

Responsibilities:

- security;
- reliability;
- privacy;
- operational failure;
- failure modes.

---

## 10. Analyst

Responsibilities:

- evaluate evidence;
- calculate metrics;
- compare experiments;
- aggregate performance.

---

## 11. Librarian

Responsibilities:

- organizational memory;
- determine what knowledge persists;
- retrieve relevant institutional knowledge;
- detect stale memory.

---

## 12. Mediator

Responsibilities:

- conflicting proposals;
- disagreement resolution;
- summarize opposing evidence;
- facilitate multi-agent decisions.

---

# 8. AGENT MODEL

Each agent must be independently represented.

Minimum persisted fields:

```text
id
name
role
roleVersion
status
currentTask
currentGoal
capabilities
toolAccess
tokenBudget
tokensConsumed
modelProvider
modelName
memoryReferences
beliefs
confidence
relationships
reputation
historicalPerformance
currentTeam
communicationPermissions
createdAt
updatedAt
generationCreated
```

Do NOT attempt to make agents psychologically human.

Use interpretable organizational concepts.

---

# 9. BELIEF MODEL

Agents should be able to hold different beliefs.

Example:

```json
{
  "claim": "Architecture B is safer than Architecture A",
  "confidence": 0.77,
  "evidence": ["artifact-17", "experiment-8"],
  "createdAt": "...",
  "updatedAt": "..."
}
```

Agents must not automatically share beliefs.

Knowledge can propagate only through allowed mechanisms such as:

- direct message;
- meeting;
- shared artifact;
- shared memory;
- decision record;
- explicit broadcast.

This enables research into information asymmetry.

---

# 10. RELATIONSHIP MODEL

Maintain functional agent relationships.

Example:

```text
trust
communicationFrequency
agreementRate
reviewAccuracy
delegationSuccess
influence
```

Do not simulate romance, friendship, emotions, or arbitrary personality drama.

Relationships exist because organizational history matters.

Example:

```text
Architect trusts Critic more after Critic repeatedly detects valid failures.
```

Trust updates must have a recorded cause.

---

# 11. REPUTATION AND INFLUENCE

Track reputation independently from authority.

An agent may:

- have high authority and low predictive accuracy;
- have low formal authority and high influence.

Useful metrics:

```text
acceptedRecommendations
rejectedRecommendations
validatedPredictions
invalidPredictions
successfulDelegations
reviewPrecision
reviewRecall
decisionContribution
```

Influence should be derived from measurable behavior where possible.

---

# 12. COMMUNICATION

Every communication must be represented as a real artifact.

Message:

```json
{
  "id": "msg-123",
  "sender": "critic",
  "recipient": "architect",
  "type": "challenge",
  "content": "...",
  "relatedTask": "...",
  "relatedDecision": "...",
  "timestamp": "...",
  "tokenCost": 450
}
```

Supported communication:

```text
DIRECT_MESSAGE
BROADCAST
QUESTION
ANSWER
PROPOSAL
CHALLENGE
EVIDENCE
REVIEW_REQUEST
REVIEW_RESPONSE
DELEGATION
STATUS_UPDATE
```

Track communication cost.

---

# 13. MEETINGS

Meetings are explicit organizational events.

Meeting properties:

```text
participants
reason
agenda
input artifacts
start
end
messages
decisions
actions
token cost
```

Meetings should not happen automatically just because the visualization needs activity.

Meetings should have cost.

This lets experiments determine whether excessive meetings hurt performance.

---

# 14. DECISION SYSTEM

Create formal decision objects.

Example:

```json
{
  "id": "decision-019",
  "question": "Which authentication architecture should be used?",
  "options": [],
  "proposals": [],
  "evidence": [],
  "opposition": [],
  "votes": [],
  "authority": [],
  "finalDecision": {},
  "confidence": 0.84,
  "result": null
}
```

Support multiple decision policies:

```text
DIRECTOR
MAJORITY
WEIGHTED_VOTE
EXPERT_AUTHORITY
CONSENSUS
VETO
EVIDENCE_THRESHOLD
RL_SELECTED
```

Policies should be interchangeable for experiments.

---

# 15. ORGANIZATIONAL MEMORY

There must be multiple memory levels.

## Agent private memory

Visible only to that agent unless shared.

## Team memory

Available to team members.

## Organizational memory

Managed by Librarian.

## Episodic memory

Specific previous runs and events.

## Semantic memory

Generalized lessons.

## Decision memory

Historical decisions and outcomes.

## Failure memory

Mistakes worth avoiding.

Persist provenance.

Never store:

```text
"Use X because it worked."
```

without storing:

```text
which task
which organization
which evidence
which experiment
which outcome
```

---

# 16. MEMORY RETRIEVAL

Memory retrieval must be measurable.

Record:

```text
query
retrieved items
retrieval latency
token cost
usefulness
whether memory affected decision
whether memory was correct
```

Later EvoOrg should learn memory policies.

---

# 17. TASK SYSTEM

Tasks must support hierarchy.

```text
Objective
├── Task
│   ├── Subtask
│   └── Subtask
└── Task
```

Task fields:

```text
id
parentId
objective
assignedAgents
status
priority
dependencies
inputArtifacts
outputArtifacts
estimatedCost
actualCost
createdAt
startedAt
completedAt
verificationStatus
```

Statuses:

```text
QUEUED
ASSIGNED
ACTIVE
BLOCKED
VERIFYING
COMPLETED
FAILED
CANCELLED
```

---

# 18. ARTIFACT SYSTEM

Agents must exchange structured artifacts rather than only chat text.

Artifacts include:

```text
research note
hypothesis
proposal
architecture design
code patch
experiment
test report
decision
risk report
evaluation
memory item
```

Track lineage:

```text
Observation
   ↓
Hypothesis
   ↓
Proposal
   ↓
Experiment
   ↓
Decision
```

The UI must later visualize artifact ancestry.

---

# 19. EVENT-DRIVEN ARCHITECTURE

This is a hard requirement.

The runtime produces events.

The UI consumes events.

The UI does not invent state.

Create a central event schema.

Examples:

```text
RUN_CREATED

AGENT_CREATED
AGENT_REMOVED
AGENT_STATUS_CHANGED

TASK_CREATED
TASK_ASSIGNED
TASK_STARTED
TASK_COMPLETED
TASK_FAILED

MESSAGE_SENT
MESSAGE_RECEIVED

MEETING_CREATED
MEETING_STARTED
MEETING_ENDED

ARTIFACT_CREATED
ARTIFACT_UPDATED

HYPOTHESIS_CREATED
HYPOTHESIS_REJECTED
HYPOTHESIS_ACCEPTED

EXPERIMENT_CREATED
EXPERIMENT_STARTED
EXPERIMENT_COMPLETED

DECISION_CREATED
VOTE_CAST
DECISION_COMPLETED

MEMORY_WRITTEN
MEMORY_RETRIEVED

RELATIONSHIP_UPDATED

ORGANIZATION_MUTATED
ROLE_CHANGED
TEAM_CREATED
TEAM_DISSOLVED

RL_STATE_OBSERVED
RL_ACTION_SELECTED
REWARD_RECORDED

BUDGET_UPDATED

RUN_PAUSED
RUN_RESUMED
RUN_COMPLETED
RUN_FAILED
```

Every event:

```text
eventId
runId
sequence
timestamp
type
actorId
payload
causedBy
correlationId
schemaVersion
```

Events must be append-only.

---

# 20. REPLAY

Any run must be reconstructible from events.

Implement:

```text
EventStore
+
Reducer
=
WorldState
```

Replay should support:

```text
pause
resume
1x
2x
4x
10x
scrub timeline
jump to event
jump to decision
jump to mutation
```

Never depend on live LLM calls during replay.

Replay must use stored events.

---

# 21. ORGWORLD VISUAL WORLD

Build an interactive 2D/isometric environment.

Recommended first implementation:

```text
Next.js
TypeScript
React
Phaser
```

Use Phaser for the spatial world.

Use React for surrounding research interfaces.

Do not begin with full 3D.

---

# 22. WORLD AREAS

Create meaningful locations.

## Command Center

Director and high-level coordination.

## Research Lab

Scout / Researcher work.

## Strategy Room

Strategist work.

## Engineering Area

Architect / Builder.

## Experiment Lab

Experimenter / tests.

## Critique Room

Critic / Risk.

## Decision Chamber

Formal decisions.

## Memory Library

Librarian / memory activity.

## Analysis Station

Analyst.

## Meeting Rooms

Temporary collaboration.

The layout should remain configurable.

---

# 23. CHARACTER BEHAVIOR

Characters are visualization projections of runtime state.

Example mapping:

```text
RESEARCHING
→ walk to Research Lab

CODING
→ walk to Engineering workstation

REVIEWING
→ walk to Critique Room

MEMORY_RETRIEVAL
→ visit Library

MEETING_STARTED
→ participants enter Meeting Room

DECISION_STARTED
→ participants enter Decision Chamber
```

Movement should use pathfinding.

Characters must not teleport unless:

- replay speed is high;
- user enables reduced animation;
- world reset occurs.

---

# 24. CHARACTER VISUAL STATES

Each agent displays:

```text
role icon
short name
status indicator
current activity
```

Optional states:

```text
thinking
working
waiting
communicating
meeting
blocked
reviewing
idle
```

Speech bubbles should display only short summaries.

Full communication belongs in inspector panels.

---

# 25. GOD VIEW

God View shows:

```text
all agents
all communication
all active tasks
all meetings
all beliefs
all relationships
all organizational state
```

This is primarily a research/debugging perspective.

---

# 26. AGENT VIEW

Click an agent.

Allow:

```text
View as this agent
```

Then restrict visible information to what that agent actually knows.

Show:

```text
known facts
known decisions
known messages
known artifacts
known relationships
private memory
unknown information
```

Do not accidentally reveal hidden global state.

This feature is critical for studying information asymmetry.

---

# 27. NETWORK VIEW

Provide interactive graph visualization.

Nodes:

```text
agents
```

Edges may represent:

```text
communication
trust
authority
delegation
information flow
```

Controls should allow switching metrics.

Example encoding:

```text
node size → influence

edge width → communication frequency

edge opacity → trust

node grouping → team
```

---

# 28. ORGANIZATION VIEW

Visualize formal organization:

```text
roles
teams
authority
managerial structure
review structure
```

Allow comparisons between generations.

---

# 29. KNOWLEDGE / ARTIFACT VIEW

Display knowledge lineage.

Example:

```text
Observation
   │
   ▼
Hypothesis
   │
   ├── Critic challenge
   │
   ▼
Experiment
   │
   ▼
Decision
   │
   ▼
Persistent memory
```

Clicking nodes reveals provenance.

---

# 30. RL VIEW

Create an interpretable learning view.

For each RL decision display:

```text
state snapshot
candidate actions
selected action
policy score
reward expectation if available
actual reward
cost
outcome
```

Example:

```text
Tests failing: 4
Tokens remaining: 31%
Critic confidence: 0.89
Architect confidence: 0.54

Policy:

Continue build       0.13
More research        0.19
Request critique     0.51 ←
Call meeting         0.17
```

Do not claim probabilistic values are meaningful unless they come from the actual policy.

---

# 31. EVOLUTION VIEW

Display:

```text
Generation
Organization genome
Mutation
Parent generation
Fitness
Task performance
Cost
Mutation acceptance
```

Example:

```text
Generation 37

Parent fitness: 0.74
Current fitness: 0.82

Changes:
- removed Director→Analyst edge
+ added Critic→Builder review requirement
+ increased memory retrieval threshold
```

---

# 32. TIME MACHINE

Implement full run replay.

Timeline should display significant events:

```text
research
messages
meetings
experiments
decisions
mutations
failures
task completion
```

User can click timeline events.

---

# 33. COUNTERFACTUAL REPLAY

Design architecture for this even if full implementation comes later.

Goal:

Run an old task using a newer organization.

Example:

```text
Task #12
Original organization:
score = 0.63

Generation 24 organization:
score = 0.87
```

This is important evidence for organizational improvement.

---

# 34. METRICS

Track at least:

## Task metrics

```text
quality
correctness
completion
verification
robustness
```

## Cost metrics

```text
input tokens
output tokens
model calls
tool calls
wall clock
agent active time
```

## Organizational metrics

```text
communication edges
messages
meeting count
meeting duration
hierarchy depth
centralization
team size
specialization
delegation count
coordination overhead
decision latency
```

## Memory metrics

```text
retrieval count
retrieval usefulness
reuse rate
incorrect memory rate
memory age
```

## Evolution metrics

```text
fitness
generation
mutation count
accepted mutations
rejected mutations
transfer performance
```

---

# 35. COMPUTE CONTROL

A critical scientific requirement.

Implement enforceable budgets.

Per run:

```text
max input tokens
max output tokens
max total tokens
max model calls
max tool calls
max agents
max concurrent agents
max wall-clock time
```

Per agent:

```text
token allowance
tool allowance
```

Record all consumption.

Do not allow EvoOrg to appear superior simply because it uses dramatically more inference.

---

# 36. REWARD FUNCTION

Reward must be configurable.

Do not hard-code one arbitrary "truth".

Initial conceptual form:

```text
reward =
    task_quality
  + verification_quality
  + robustness
  + transfer
  + useful_memory_reuse
  - token_cost
  - latency
  - coordination_cost
  - redundant_work
  - failures
```

Configuration example:

```yaml
reward:
  taskQuality: 0.40
  verification: 0.15
  robustness: 0.15
  transfer: 0.10
  memoryReuse: 0.05

  tokenCost: -0.05
  latency: -0.05
  coordination: -0.05
```

Actual weights must be experiment configuration.

Persist the exact reward configuration with every run.

---

# 37. EXPERIMENT MODE

Two execution modes must exist.

## Sandbox mode

User may:

```text
create agent
delete agent
change roles
force message
force meeting
change policy
change budget
pause execution
```

Good for demos and debugging.

## Experiment mode

Once started, lock:

```text
model
task definition
budget
starting organization
experimental configuration
baseline definition
```

User interference must be disabled or explicitly logged as contamination.

---

# 38. CLAUDE CODE PLUGIN

OrgWorld must ship as a proper Claude Code plugin using the current Claude Code plugin format.

At implementation time, verify the latest Anthropic plugin specification before finalizing plugin manifests.

The plugin should package appropriate:

```text
commands
skills
subagents
hooks
MCP server
CLI
```

Use:

```text
.claude-plugin/plugin.json
```

for plugin manifest configuration.

Do not make Claude-specific packaging leak into EvoOrg Core.

---

# 39. PRIMARY COMMAND

The primary developer experience:

```text
/orgworld <objective>
```

Examples:

```text
/orgworld Build authentication for this repository
```

```text
/orgworld Find and fix the performance regression
```

```text
/orgworld Research whether this architecture will scale
```

---

# 40. COMMAND SET

Support progressively:

```text
/orgworld
/orgworld run
/orgworld watch
/orgworld status
/orgworld agents
/orgworld inspect <agent>
/orgworld messages
/orgworld decisions
/orgworld memory
/orgworld graph
/orgworld replay
/orgworld compare
/orgworld experiment
/orgworld evolve
/orgworld pause
/orgworld resume
/orgworld stop
```

Advanced:

```text
/orgworld ask <agent> "<question>"
```

```text
/orgworld tell <agent> "<instruction>"
```

```text
/orgworld meeting <agents...>
```

```text
/orgworld create-agent <role>
```

Sandbox-only commands must not work in locked Experiment Mode.

---

# 41. `/orgworld why`

Implement this as an important feature.

When asked:

```text
/orgworld why
```

identify the latest important organizational decision.

Return:

```text
decision
proposer
evidence
objections
participants
experiments
vote
policy
confidence
final rationale
result if known
```

Never fabricate reasoning that wasn't persisted.

---

# 42. CLAUDE SUBAGENTS

Use Claude Code subagents where they provide actual isolated execution.

Plugin agents should correspond to useful cognitive specializations.

However:

The OrgWorld runtime state is the source of truth.

Claude subagent process state alone must not be considered persistent organizational memory.

The runtime must store:

```text
task
input
output
cost
events
artifacts
agent identity
```

---

# 43. MCP SERVER

Create an OrgWorld MCP server.

Initial tool ideas:

```text
orgworld_get_state
orgworld_get_agent
orgworld_assign_task
orgworld_send_message
orgworld_create_artifact
orgworld_query_memory
orgworld_write_memory
orgworld_propose_decision
orgworld_cast_vote
orgworld_request_meeting
orgworld_create_experiment
orgworld_record_experiment
orgworld_update_relationship
orgworld_complete_task
orgworld_get_budget
```

Tool schemas should be explicit and validated.

Use Zod where appropriate.

---

# 44. CLI

Build a local CLI.

Example:

```bash
orgworld init
orgworld run "objective"
orgworld status
orgworld watch
orgworld replay <run>
orgworld experiment <config>
```

The plugin should be able to invoke the CLI.

Humans should also be able to use it directly.

---

# 45. LOCAL-FIRST ARCHITECTURE

Initial version should require no OrgWorld cloud account.

Desired architecture:

```text
Claude Code
    │
    ▼
OrgWorld Plugin
    │
    ▼
OrgWorld Local Runtime
    │
    ├── Event Store
    ├── Memory
    ├── EvoOrg
    ├── Agent Runtime
    ├── Experiment Runner
    │
    ▼
WebSocket / API
    │
    ▼
OrgWorld Web
```

Suggested local ports may be configurable.

Never hard-code a globally fixed port without collision handling.

---

# 46. PERSISTENCE

Each participating repository should be able to contain:

```text
.orgworld/
```

Suggested structure:

```text
.orgworld/
├── config/
│   ├── orgworld.yaml
│   ├── research.yaml
│   └── budget.yaml
│
├── organization/
│   ├── current.json
│   ├── genome.json
│   ├── topology.json
│   └── policies/
│
├── agents/
│   ├── director/
│   ├── scout/
│   ├── researcher/
│   ├── strategist/
│   ├── architect/
│   ├── builder/
│   ├── experimenter/
│   ├── critic/
│   ├── risk/
│   ├── analyst/
│   ├── librarian/
│   └── mediator/
│
├── memory/
│   ├── episodic/
│   ├── semantic/
│   ├── failures/
│   └── decisions/
│
├── runs/
│
├── experiments/
│
├── evolution/
│   ├── generations/
│   ├── mutations/
│   └── fitness/
│
├── events/
│
└── artifacts/
```

Do not store secrets here.

---

# 47. REPOSITORY ARCHITECTURE

Use a monorepo.

Recommended:

```text
orgworld/
│
├── apps/
│   ├── web/
│   └── research/
│
├── packages/
│   ├── core/
│   ├── protocol/
│   ├── agent-runtime/
│   ├── organization-runtime/
│   ├── evoorg/
│   ├── memory/
│   ├── event-store/
│   ├── evaluator/
│   ├── experiment-runner/
│   ├── replay/
│   ├── world-engine/
│   ├── model-adapters/
│   └── shared/
│
├── integrations/
│   ├── claude-code/
│   └── mcp/
│
├── cli/
│
├── benchmarks/
│
├── experiments/
│
├── docs/
│   ├── architecture/
│   ├── research/
│   ├── decisions/
│   └── protocols/
│
├── scripts/
│
├── tests/
│
├── .claude-plugin/
│
├── CLAUDE.md
├── ORGWORLD_BUILD.md
├── EVOORG_RESEARCH.md
└── README.md
```

Use a workspace-capable package manager.

Prefer TypeScript across the application unless a Python ML component clearly provides substantial benefit.

If Python is needed for future RL training, isolate it.

Example:

```text
ml/
```

Do not make Node and Python tightly interdependent in v0.1.

---

# 48. DATABASE

Use SQLite initially.

Reasons:

```text
local-first
portable
reproducible
no account
simple backup
easy run export
```

Use migrations.

Potential tables:

```text
runs
agents
tasks
messages
meetings
artifacts
events
decisions
votes
experiments
memories
relationships
organizations
generations
mutations
rewards
metrics
model_calls
```

Large raw event payloads may additionally use JSONL if beneficial.

Avoid storing the same state independently in many locations unless a clear source-of-truth hierarchy exists.

---

# 49. API

Implement a local service.

Suggested interfaces:

```text
HTTP
+
WebSocket
```

HTTP:

```text
commands
queries
experiment setup
historical data
```

WebSocket:

```text
live event stream
world updates
```

Version API routes.

Example:

```text
/api/v1/...
```

---

# 50. FRONTEND

Recommended:

```text
Next.js
React
TypeScript
Phaser
D3 or equivalent graph library
```

Use a restrained dark research-tool visual language around the playful Agent World.

The world should feel alive.

The research interface should feel rigorous.

Do not make every screen cartoonish.

---

# 51. WEB PRODUCT NAVIGATION

Initial navigation:

```text
WORLD
REPLAY
AGENTS
DECISIONS
MEMORY
NETWORK
EVOLUTION
EXPERIMENTS
METRICS
```

WORLD is the default.

---

# 52. AGENT INSPECTOR

Clicking an agent opens:

```text
Name
Role
Status
Current task
Current objective
Current belief summary
Confidence
Budget
Token usage
Team
Reputation
Influence
Relationships
Recent messages
Recent artifacts
Memory
Historical performance
```

Tabs:

```text
Overview
Tasks
Messages
Beliefs
Memory
Relationships
History
```

---

# 53. REAL-TIME EVENT PANEL

Include a collapsible event feed.

Example:

```text
20:14:08 Scout completed repository scan
20:14:12 Scout → Architect: dependency risk
20:14:20 Architect created Proposal #32
20:14:26 Critic challenged Proposal #32
20:14:40 Meeting #14 started
```

Clicking an event selects the relevant agent/artifact.

---

# 54. PERFORMANCE

Do not rerender the entire React application for every world tick.

Separate:

```text
simulation rendering
```

from:

```text
React state
```

Batch UI updates where appropriate.

The web app should remain usable with:

```text
10 agents
25 agents
50 agents
100 agents
```

100-agent visualization can initially use reduced animation fidelity.

---

# 55. SCALE TESTS

Create benchmarks for:

```text
10 agents
25 agents
50 agents
100 agents
250 simulated agents
```

The 250-agent benchmark may use synthetic event generation rather than 250 live LLM calls.

Measure:

```text
event throughput
WebSocket throughput
frontend FPS
database growth
replay performance
```

---

# 56. SECURITY

OrgWorld runs inside developer repositories.

Treat local code access seriously.

Do not:

```text
upload repository contents without explicit configuration
store API keys in .orgworld/
execute arbitrary stored commands from replay
render unsanitized agent-generated HTML
```

Validate all MCP inputs.

Separate:

```text
read tools
write tools
execution tools
```

Log tool usage.

---

# 57. HOOK SAFETY

Claude Code hooks can execute deterministic automation.

Use hooks conservatively.

Do not put destructive or broad shell operations into automatic hooks.

Hooks may eventually support:

```text
event logging
formatting
test triggers
state synchronization
```

Every hook command must be documented.

---

# 58. OBSERVABILITY

Use structured logging.

Every log should include where relevant:

```text
runId
agentId
taskId
eventId
correlationId
```

Implement levels:

```text
debug
info
warn
error
```

Add a diagnostic command:

```text
orgworld doctor
```

Checks:

```text
runtime
database
plugin
MCP
ports
web app
config
model adapter
```

---

# 59. FAILURE RECOVERY

If an agent crashes:

```text
AGENT_FAILED
```

must be emitted.

Organization policy decides whether to:

```text
retry
reassign
spawn replacement
abort task
continue degraded
```

The UI should show failure.

Do not hide failures.

---

# 60. DETERMINISM AND REPRODUCIBILITY

Store every relevant run configuration.

```text
OrgWorld version
EvoOrg version
model provider
model identifier
model parameters
organization genome
reward configuration
budget
task
tool access
environment metadata
random seed where applicable
```

LLM execution itself may not be deterministic.

Record enough information for meaningful reproduction and comparison.

---

# 61. RUN EXPORT

Implement:

```bash
orgworld export <run-id>
```

Export:

```text
config
events
metrics
organization
agent states
decisions
artifacts
evaluation
```

Suggested portable format:

```text
.orgworld-run.zip
```

Never include secrets.

---

# 62. RESEARCH DATA EXPORT

Support:

```text
JSON
CSV
```

for metrics.

Eventually support experiment tables suitable for:

```text
Python
R
Jupyter
```

---

# 63. EXPERIMENT CONFIGURATION

Experiment YAML example:

```yaml
experiment:
  name: persistent-vs-reset-authentication

taskSuite:
  - auth-001
  - auth-002
  - auth-003

conditions:
  - single-agent
  - fixed-multi-agent
  - adaptive-reset
  - evoorg

repetitions: 5

controls:
  model: fixed
  tokenBudget: 400000
  tools: fixed

metrics:
  - taskQuality
  - verification
  - tokenCost
  - latency
  - communicationCost
  - transfer
```

Create schema validation.

---

# 64. BASELINES

Do not compare only against weak baselines.

Implement genuine baseline modes.

### Single Agent

Strong model, full allowed budget.

### Fixed Organization

Same agents but no learning/evolution.

### Adaptive Reset

May reorganize within task but clears organizational learning after task.

### EvoOrg

Persistent.

Do not intentionally handicap the baselines.

---

# 65. TRAIN / VALIDATION / TEST TASK SEPARATION

Design experiment runner to support:

```text
training task sequences
validation task sequences
held-out test sequences
cross-domain transfer tasks
```

Prevent accidental leakage where practical.

---

# 66. FALSIFICATION TESTS

The implementation must make it possible to detect that EvoOrg is wrong.

Track scenarios where:

```text
persistence gives no benefit;
persistent memory hurts;
organization overfits;
RL collapses to one agent;
coordination cost exceeds quality gain;
fresh per-task organization performs better;
more compute explains all gains.
```

These are valid outcomes.

Do not bias implementation toward making EvoOrg "win."

---

# 67. ABLATIONS

Support turning subsystems off.

```text
no persistence
no RL
no evolution
no relationship state
no trust
no shared memory
no private memory
no hierarchy
no communication learning
no role mutation
```

Experiment configurations should support these flags.

---

# 68. FIRST DEMONSTRATION TASK

Create one reproducible software engineering demonstration.

Example:

```text
Build authentication for a small sample application.
```

The demo should require:

```text
research
architecture
implementation
security review
tests
criticism
decision
verification
```

Do not optimize the entire platform specifically for this task.

---

# 69. FIRST RESEARCH BENCHMARK

After basic runtime stability, implement a task suite with multiple tasks rather than one long task.

We need sequential experience.

Example:

```text
Task 1
Task 2
Task 3
...
Task N
```

Measure whether organizational performance improves.

---

# 70. UI — RUN COMPARISON

Build comparison interface.

Example:

| Metric | Single | Fixed | Adaptive | EvoOrg |
|---|---:|---:|---:|---:|
| Quality | | | | |
| Tokens | | | | |
| Latency | | | | |
| Messages | | | | |
| Transfer | | | | |

Populate only actual experimental results.

---

# 71. UI — ORGANIZATIONAL BOTTLENECKS

Detect and display things such as:

```text
communication centralization
agent overload
decision bottleneck
excessive meetings
repeated research
redundant review
idle agents
```

Do not label them failures without defined thresholds.

---

# 72. UI — HEATMAP

Activity heatmap should derive from:

```text
compute activity
messages
work events
```

Never randomly animate "busy" rooms.

---

# 73. UI — EVOLUTION TIMELINE

Display:

```text
Task 1
Task 10
Task 20
Task 30
```

with organizational generations.

Important changes:

```text
role added
role removed
team created
authority changed
communication edge changed
memory policy changed
```

---

# 74. VISUALIZATION DESIGN

Art direction:

```text
tiny living organization
pixel/isometric-inspired
professional research instrumentation
```

Avoid:

```text
generic SaaS dashboard
neon cyberpunk overload
huge gradients
meaningless animated particles
```

The world should be visually memorable but readable.

---

# 75. ACCESSIBILITY

Provide:

```text
reduced motion
keyboard navigation
accessible labels
high-contrast text
non-animation status alternatives
```

All important information must be available without relying only on animation or color.

---

# 76. CLAUDE.md

Create a concise root `CLAUDE.md`.

Keep it focused on:

```text
project purpose
architecture boundaries
critical commands
coding standards
research integrity rules
verification requirements
```

Do not duplicate this entire build document inside `CLAUDE.md`.

Point Claude to relevant docs.

---

# 77. ARCHITECTURE DECISION RECORDS

Create ADRs.

Directory:

```text
docs/decisions/
```

At minimum:

```text
ADR-001-monorepo.md
ADR-002-event-sourcing.md
ADR-003-sqlite.md
ADR-004-phaser.md
ADR-005-model-adapter-boundary.md
ADR-006-rl-evolution-separation.md
ADR-007-memory-model.md
```

Each:

```text
Context
Decision
Alternatives
Consequences
Evidence
```

---

# 78. TESTING STRATEGY

Use:

```text
unit tests
integration tests
contract tests
end-to-end tests
replay tests
property tests where useful
```

Critical invariants:

```text
event sequence is ordered;
replay reconstructs state;
budget cannot go negative;
experiment lock prevents mutation;
agent cannot access unauthorized memory;
run export excludes secrets;
UI world state matches backend world state;
all decisions retain provenance.
```

---

# 79. REPLAY GOLDEN TEST

Create a deterministic synthetic event fixture.

Run reducer.

Expected final state must be fixed.

Any event/reducer change breaking it requires deliberate migration.

---

# 80. MCP CONTRACT TESTS

Every MCP tool needs:

```text
valid input
invalid input
authorization check where relevant
expected event generation
expected database effect
```

---

# 81. UI E2E TESTS

Automate:

```text
launch runtime
launch web
start simulated run
observe agents
click agent
inspect state
pause
resume
open replay
scrub timeline
open decision
```

Use browser automation.

---

# 82. NO FAKE COMPLETION

Never declare:

```text
RL implemented
```

if the code only chooses random actions.

Label accurately:

```text
random baseline
heuristic policy
bandit policy
trained RL policy
```

Likewise never say:

```text
agents communicate
```

if the messages are generated by static sample data.

---

# 83. DEVELOPMENT PHASES

Build in this order.

---

# PHASE 0 — RESEARCH + ARCHITECTURE

Deliver:

```text
research mapping
architecture
ADRs
schemas
event protocol
experiment model
```

No polished UI yet.

Acceptance:

Research questions from `EVOORG_RESEARCH.md` can be mapped to actual measurable system variables.

---

# PHASE 1 — CORE DOMAIN

Implement:

```text
Agent
Task
Message
Artifact
Decision
Meeting
Memory
Organization
Run
Event
Budget
```

Acceptance:

Unit tests pass.

---

# PHASE 2 — EVENT STORE + REPLAY

Implement:

```text
append
query
sequence
snapshot
reduce
replay
```

Acceptance:

Golden replay test passes.

---

# PHASE 3 — SINGLE-AGENT BASELINE

Run a real task.

Record:

```text
model calls
events
cost
artifacts
result
```

Acceptance:

Exportable run.

---

# PHASE 4 — FIXED MULTI-AGENT ORGANIZATION

Implement 12 roles.

Implement:

```text
delegation
messages
tasks
artifacts
meetings
decisions
```

Acceptance:

At least one real collaborative run succeeds.

---

# PHASE 5 — ORGWORLD WEB

Implement:

```text
world map
agents
movement
agent inspector
event panel
live events
```

Acceptance:

Every visible state comes from actual events.

---

# PHASE 6 — CLAUDE CODE PLUGIN

Implement:

```text
plugin manifest
/orgworld
/orgworld status
/orgworld watch
MCP integration
CLI integration
```

Acceptance:

Fresh repository installation works.

---

# PHASE 7 — MEMORY + PERSISTENCE

Implement:

```text
private memory
team memory
organizational memory
retrieval
provenance
cross-run persistence
```

Acceptance:

Knowledge from Run A can influence Run B and provenance can be inspected.

---

# PHASE 8 — RESEARCH VIEWS

Implement:

```text
network
decisions
memory
metrics
comparison
replay
```

---

# PHASE 9 — BANDIT ORGANIZATION POLICY

Implement organization-selection learning.

Keep heuristic and random baselines.

Acceptance:

Policy evaluation test suite exists.

---

# PHASE 10 — SEQUENTIAL RL

Introduce policy state/action framework.

Do not require neural RL initially.

Start with transparent implementation.

---

# PHASE 11 — STRUCTURAL EVOLUTION

Implement:

```text
genome
mutations
fitness
selection
generation history
```

Acceptance:

Different organization generations can run the same task.

---

# PHASE 12 — EVOLUTION UI

Visualize:

```text
generation lineage
mutations
fitness
structure change
```

---

# PHASE 13 — EXPERIMENT RUNNER

Implement four baseline conditions.

Support repetitions.

Export aggregate data.

---

# PHASE 14 — COUNTERFACTUALS + TRANSFER

Run old tasks with newer organizations.

Support held-out domains.

---

# PHASE 15 — HARDENING

Complete:

```text
security
performance
accessibility
documentation
plugin install flow
CI
release automation
```

---

# 84. BUILD VERIFICATION

At the end of every phase create:

```text
docs/verification/PHASE-X.md
```

Include:

```text
requirements
implementation
tests executed
results
known limitations
evidence
```

Do not mark a phase complete because files exist.

---

# 85. CI

CI should run:

```text
format
lint
typecheck
unit
integration
build
```

Run heavier E2E separately if needed.

---

# 86. VERSIONING

Version separately where useful:

```text
OrgWorld
EvoOrg research protocol
event schema
organization genome
run export format
```

Support migrations.

---

# 87. README

README should eventually communicate two stories.

## Developer story

> Turn your repository into a living AI engineering organization.

## Research story

> A laboratory for studying persistent and self-evolving multi-agent organizations.

Include:

```text
demo
installation
/orgworld example
architecture diagram
research methodology
limitations
reproducibility
```

---

# 88. CLAUDE PLUGIN INSTALLATION GOAL

Target UX:

```text
/plugin marketplace add <owner>/orgworld
/plugin install orgworld@orgworld
```

Then:

```text
/orgworld
```

The exact marketplace syntax and plugin manifest must be validated against the current Claude Code specification during implementation.

---

# 89. FIRST USER EXPERIENCE

First launch:

```text
/orgworld
```

Claude should detect whether `.orgworld/` exists.

If not:

```text
Initialize OrgWorld
Create organization
Select mode
```

Default:

```text
12-agent Software Organization
Sandbox Mode
Persistent memory ON
Evolution OFF until enough run data exists
```

Then objective:

```text
/orgworld Build feature X
```

Console output should provide:

```text
Run ID
organization
budget
agents
web URL
status
```

---

# 90. FIRST WORLD EXPERIENCE

User opens browser.

Immediately sees:

```text
agents
rooms
current task
run status
token budget
event stream
```

Within seconds, real events move agents.

Clicking an agent reveals its actual state.

---

# 91. EVOLUTION SHOULD NOT START IMMEDIATELY

Do not mutate organization after one task and claim learning.

Require configurable evidence.

Example:

```text
minimum runs
minimum evaluation confidence
validation performance
```

Evolution candidates should be tested.

Avoid catastrophic structural changes from noisy rewards.

---

# 92. MUTATION EVALUATION

Candidate organization:

```text
parent genome
↓
mutation
↓
candidate genome
↓
evaluation tasks
↓
fitness
```

Do not automatically replace parent just because one task improved.

---

# 93. ARCHIVE LINEAGE

Never delete old organizations.

Store:

```text
Generation 1
Generation 2
Generation 3
```

with parent-child lineage.

---

# 94. RL SAFETY

RL policies may optimize unintended behavior.

Detect potential reward hacking.

Examples:

```text
avoiding hard subtasks;
ending runs early;
reducing communication only to minimize cost;
gaming task evaluator;
reusing incorrect memory because retrieval earns reward.
```

Record suspicious strategy changes.

---

# 95. EVALUATOR SEPARATION

Task-producing agents should not unilaterally score themselves.

Create evaluator boundaries.

Use when appropriate:

```text
deterministic tests
external metrics
independent evaluator agent
held-out evaluator
```

Prefer objective tests when possible.

---

# 96. SCIENTIFIC INTEGRITY

OrgWorld is a research instrument.

Never:

- fabricate results;
- hide failed experiments;
- choose only winning runs;
- automatically delete poor generations;
- change baselines after seeing outcomes without recording the change;
- silently change metric definitions.

Store failed runs.

---

# 97. DATA PROVENANCE

Every experimental result should be traceable to:

```text
run
task
organization
model
budget
events
evaluation
reward config
software version
```

---

# 98. DEFINITION OF V0.1

OrgWorld v0.1 is complete when all of the following work:

1. Local runtime starts.

2. `.orgworld/` initializes.

3. Event store persists real events.

4. Single-agent baseline executes.

5. 12 persistent roles exist.

6. Multi-agent tasks can be delegated.

7. Agents communicate using persisted messages.

8. Decisions retain provenance.

9. Organizational memory survives runs.

10. Web world renders actual agents.

11. Agents move because of real runtime activities.

12. Agent inspector works.

13. Event stream works.

14. Replay reconstructs a run.

15. Compute budget is tracked.

16. Run metrics are persisted.

17. Experiment configuration is versioned.

18. Claude Code `/orgworld` command works.

19. MCP tools work.

20. CLI works.

21. Fixed multi-agent baseline works.

22. EvoOrg can perform at least one controlled organization-policy adaptation.

23. No sophisticated RL claims are made unless trained/evaluated.

24. Tests verify state/event/replay correctness.

25. README allows another developer to run the system.

---

# 99. DEFINITION OF RESEARCH V1

Research v1 requires:

```text
single-agent baseline
fixed multi-agent baseline
adaptive-reset baseline
persistent EvoOrg condition

multiple tasks
multiple runs
budget controls
experiment locking
persistent organization
memory
organizational adaptation
RL or learned policy
evolution
transfer evaluation
ablations
metrics export
counterfactual evaluation
```

---

# 100. NON-GOALS FOR V0.1

Do NOT prioritize:

```text
3D graphics
mobile app
multiplayer users
cloud accounts
billing
marketplace ecosystem
NFT/avatars
voice conversations
photorealistic humans
LLM fine-tuning
huge-scale RL traini
```

<!-- [TRUNCATED IN SOURCE — remainder of section 100 and any later sections were not received.] -->
